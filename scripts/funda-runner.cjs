'use strict';
const { randomUUID } = require('node:crypto');
const BROWSER_SCENARIO = 'railway:funda-browser-session:encrypted-volume:v2-today';
const { SOURCE_ID, SEARCH_URL, FILTERS, FundaError, collect } = require('./funda-core.cjs');

// Network I/O is outside transactions. A durable lease prevents replica overlap;
// ownership is checked under the source row lock before committing any findings.
async function runFunda(db, listings, { destination, intervalSeconds = 900, collector = collect, browser = false } = {}) {
  if (!/^-[1-9]\d*$/.test(destination ?? '')) throw new FundaError('DESTINATION_MISSING');
  const now = new Date(), token = randomUUID();
  const run = await db.$transaction(async tx => {
    await tx.source.upsert({ where: { id: SOURCE_ID }, update: { intervalSeconds }, create: {
      id: SOURCE_ID, name: 'Funda — Groningen +30 km', baseUrl: 'https://www.funda.nl',
      allowedDomains: ['www.funda.nl'], intervalSeconds, status: 'DEGRADED',
    } });
    const profile=await tx.siteProfile.findUnique({where:{sourceId:SOURCE_ID}});
    if(browser&&profile?.browserStateRef!==BROWSER_SCENARIO) await tx.source.updateMany({where:{id:SOURCE_ID,monitorLeaseToken:null},data:{nextCheckAt:now}});
    const claim = await tx.source.updateMany({ where: { id: SOURCE_ID, AND: [
      { OR: [{ nextCheckAt: null }, { nextCheckAt: { lte: now } }] },
      { OR: [{ monitorLeaseUntil: null }, { monitorLeaseUntil: { lte: now } }] },
    ] }, data: { monitorLeaseToken: token, monitorLeaseUntil: new Date(now.getTime() + (browser?360000:180000)),
      lastAttemptAt: now, nextCheckAt: new Date(now.getTime() + intervalSeconds * 1000) } });
    if (!claim.count) return null;
    await tx.monitoringRun.updateMany({ where: { sourceId: SOURCE_ID, status: 'RUNNING' },
      data: { status: 'FAILED', finishedAt: now, errorCategory: 'WORKER_INTERRUPTED' } });
    await tx.siteProfile.upsert({ where: { sourceId: SOURCE_ID }, create: {
      sourceId: SOURCE_ID, searchUrls: [SEARCH_URL], filters: FILTERS, authStrategy: browser?'browser-session':'none',browserStateRef:browser?BROWSER_SCENARIO:null,
    }, update: { searchUrls: [SEARCH_URL], filters: FILTERS,authStrategy:browser?'browser-session':'none',browserStateRef:browser?BROWSER_SCENARIO:null } });
    return tx.monitoringRun.create({ data: { sourceId: SOURCE_ID } });
  });
  if (!run) return { skipped: true };
  try {
    const result = await collector({ now });
    return await db.$transaction(async tx => {
      const finishedAt = new Date();
      const owned = await tx.source.updateMany({ where: { id: SOURCE_ID, monitorLeaseToken: token,
        monitorLeaseUntil: { gt: finishedAt } }, data: { monitorLeaseToken: null, monitorLeaseUntil: null, status: 'HEALTHY' } });
      if (!owned.count) throw new FundaError('LEASE_LOST');
      const recorded = await listings.recordValidatedRunInTransaction(tx, SOURCE_ID, result.listings, destination);
      await tx.monitoringRun.update({ where: { id: run.id }, data: {
        status: 'SUCCEEDED', finishedAt, listingsFound: result.listings.length } });
      return { skipped: false, runId: run.id, inspected: result.inspected, matched: result.listings.length, ...recorded };
    }, { timeout: 30000 });
  } catch (error) {
    const failure = error instanceof FundaError ? error : new FundaError('RUN_FAILED');
    await db.$transaction(async tx => {
      await tx.source.updateMany({ where: { id: SOURCE_ID, monitorLeaseToken: token }, data: {
        status: failure.blocked ? 'BLOCKED' : 'DEGRADED', monitorLeaseToken: null, monitorLeaseUntil: null,
        nextCheckAt: new Date(Date.now() + Math.max(intervalSeconds, failure.retryAfterSeconds,
          failure.blocked ? 21600 : 0) * 1000),
      } });
      await tx.monitoringRun.updateMany({ where: { id: run.id, status: 'RUNNING' }, data: {
        status: 'FAILED', finishedAt: new Date(), errorCategory: failure.category } });
    });
    throw failure;
  }
}
module.exports = { runFunda };
