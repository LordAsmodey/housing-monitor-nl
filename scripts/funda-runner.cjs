'use strict';
const { randomUUID } = require('node:crypto');
const BROWSER_SCENARIO = 'railway:funda-browser-session:encrypted-volume:v2-today';
const { SOURCE_ID, SEARCH_URL, FILTERS, FundaError, collect } = require('./funda-core.cjs');

// Network I/O is outside transactions. A durable lease prevents replica overlap;
// ownership is checked under the source row lock before committing any findings.
async function runFunda(db, listings, { destination, intervalSeconds = 900, collector = collect, browser = false, definition } = {}) {
  const source = definition ?? { SOURCE_ID, SEARCH_URL, FILTERS, BROWSER_SCENARIO,
    name: 'Funda — Groningen +30 km', baseUrl: 'https://www.funda.nl', allowedDomains: ['www.funda.nl'] };
  const { SOURCE_ID: sourceId, SEARCH_URL: searchUrl, FILTERS: filters, BROWSER_SCENARIO: scenario } = source;
  if (!/^-[1-9]\d*$/.test(destination ?? '')) throw new FundaError('DESTINATION_MISSING');
  const now = new Date(), token = randomUUID();
  const run = await db.$transaction(async tx => {
    await tx.source.upsert({ where: { id: sourceId }, update: { intervalSeconds }, create: {
      id: sourceId, name: source.name, baseUrl: source.baseUrl,
      allowedDomains: source.allowedDomains, intervalSeconds, status: 'DEGRADED',
    } });
    const profile=await tx.siteProfile.findUnique({where:{sourceId:sourceId}});
    if(browser&&profile?.browserStateRef!==scenario) await tx.source.updateMany({where:{id:sourceId,monitorLeaseToken:null},data:{nextCheckAt:now}});
    const claim = await tx.source.updateMany({ where: { id: sourceId, AND: [
      { OR: [{ nextCheckAt: null }, { nextCheckAt: { lte: now } }] },
      { OR: [{ monitorLeaseUntil: null }, { monitorLeaseUntil: { lte: now } }] },
    ] }, data: { monitorLeaseToken: token, monitorLeaseUntil: new Date(now.getTime() + (browser?360000:180000)),
      lastAttemptAt: now, nextCheckAt: new Date(now.getTime() + intervalSeconds * 1000) } });
    if (!claim.count) return null;
    await tx.monitoringRun.updateMany({ where: { sourceId: sourceId, status: 'RUNNING' },
      data: { status: 'FAILED', finishedAt: now, errorCategory: 'WORKER_INTERRUPTED' } });
    await tx.siteProfile.upsert({ where: { sourceId: sourceId }, create: {
      sourceId: sourceId, searchUrls: source.searchUrls ?? [searchUrl], filters: filters, authStrategy: browser?'browser-session':'none',browserStateRef:browser?scenario:null,
    }, update: { searchUrls: source.searchUrls ?? [searchUrl], filters: filters,authStrategy:browser?'browser-session':'none',browserStateRef:browser?scenario:null } });
    return tx.monitoringRun.create({ data: { sourceId: sourceId } });
  });
  if (!run) return { skipped: true };
  const telemetry = require('./telemetry.cjs').init();
  const monitorSource = sourceId.split(':')[0];
  const checkInId = telemetry.start(monitorSource, intervalSeconds);
  try {
    const result = await collector({ now });
    const completed = await db.$transaction(async tx => {
      const finishedAt = new Date();
      const owned = await tx.source.updateMany({ where: { id: sourceId, monitorLeaseToken: token,
        monitorLeaseUntil: { gt: finishedAt } }, data: { monitorLeaseToken: null, monitorLeaseUntil: null, status: 'HEALTHY' } });
      if (!owned.count) throw new FundaError('LEASE_LOST');
      const recorded = await listings.recordValidatedRunInTransaction(tx, sourceId, result.listings, destination);
      await tx.monitoringRun.update({ where: { id: run.id }, data: {
        status: 'SUCCEEDED', finishedAt, listingsFound: result.listings.length } });
      return { skipped: false, runId: run.id, inspected: result.inspected, matched: result.listings.length, ...recorded };
    }, { timeout: 30000 });
    telemetry.finish(monitorSource, checkInId, 'ok');
    return completed;
  } catch (error) {
    const failure = error instanceof FundaError ? error : new FundaError('RUN_FAILED');
    telemetry.finish(monitorSource, checkInId, 'error');
    await db.$transaction(async tx => {
      await tx.source.updateMany({ where: { id: sourceId, monitorLeaseToken: token }, data: {
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
