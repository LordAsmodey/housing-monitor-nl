'use strict';
const { randomUUID } = require('node:crypto');
const BROWSER_SCENARIO = 'railway:funda-browser-session:encrypted-volume:v2-today';
const { SOURCE_ID, SEARCH_URL, FILTERS, FundaError, collect } = require('./funda-core.cjs');
const settings = require('./search-settings.cjs');

// Network I/O is outside transactions. A durable lease prevents replica overlap;
// ownership is checked under the source row lock before committing any findings.
async function runFunda(db, listings, { destination, intervalSeconds = 900, collector = collect, browser = false, definition } = {}) {
  const source = definition ?? { SOURCE_ID, SEARCH_URL, FILTERS, BROWSER_SCENARIO,
    name: 'Funda — Groningen +30 km', baseUrl: 'https://www.funda.nl', allowedDomains: ['www.funda.nl'] };
  const { SOURCE_ID: sourceId, SEARCH_URL: searchUrl, FILTERS: filters, BROWSER_SCENARIO: scenario } = source;
  if (!/^-[1-9]\d*$/.test(destination ?? '')) throw new FundaError('DESTINATION_MISSING');
  const now = new Date(), token = randomUUID();
  let search;
  const run = await db.$transaction(async tx => {
    await tx.source.upsert({ where: { id: sourceId }, update: { intervalSeconds }, create: {
      id: sourceId, name: source.name, baseUrl: source.baseUrl,
      allowedDomains: source.allowedDomains, intervalSeconds, status: 'DEGRADED',
    } });
    // Serialize settings writes with claiming a run. Network I/O uses this immutable snapshot.
    if (settings.definition(sourceId) && tx.searchConfiguration) {
      await tx.$queryRaw`SELECT id FROM "Source" WHERE id = ${sourceId} FOR UPDATE`;
      search = await tx.searchConfiguration.upsert({where:{sourceId},update:{},create:{sourceId,filters:settings.defaults(sourceId)}});
      search.filters = settings.validate(sourceId, search.filters);
      if (!search.enabled) return null;
    }
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
    const runUrls = (source.searchUrls ?? [searchUrl]).map(url=>search?settings.queryUrl(sourceId,url,search.filters):url);
    const runFilters = search ? {...filters,...search.filters,...('maxAdvertisedRent' in filters?{maxAdvertisedRent:search.filters.maxRent}:{})} : filters;
    await tx.siteProfile.upsert({ where: { sourceId: sourceId }, create: {
      sourceId: sourceId, searchUrls: runUrls, filters: runFilters, authStrategy: browser?'browser-session':'none',browserStateRef:browser?scenario:null,
    }, update: { searchUrls: runUrls, filters: runFilters,authStrategy:browser?'browser-session':'none',browserStateRef:browser?scenario:null } });
    return tx.monitoringRun.create({ data: { sourceId: sourceId,
      ...(search ? {searchRevision:search.revision,searchSnapshot:{enabled:search.enabled,filters:search.filters}} : {}) } });
  });
  if (!run) return { skipped: true };
  const telemetry = require('./telemetry.cjs').init();
  const monitorSource = sourceId.split(':')[0];
  const checkInId = telemetry.start(monitorSource, intervalSeconds);
  try {
    const result = await collector({ now, ...(search ? {settings:search.filters} : {}) });
    const completed = await db.$transaction(async tx => {
      const finishedAt = new Date();
      const owned = await tx.source.updateMany({ where: { id: sourceId, monitorLeaseToken: token,
        monitorLeaseUntil: { gt: finishedAt } }, data: { monitorLeaseToken: null, monitorLeaseUntil: null, status: 'HEALTHY' } });
      if (!owned.count) throw new FundaError('LEASE_LOST');
      const recorded = await listings.recordValidatedRunInTransaction(tx, sourceId, result.listings, destination,
        {requireAvailable: source.requireAvailable ?? false, stableExternalId: source.stableExternalId ?? false,
          ...(search ? {filters:search.filters,suppressNotifications:search.revision!==search.appliedRevision} : {})});
      if (search) await tx.searchConfiguration.updateMany({where:{sourceId,revision:search.revision},data:{appliedRevision:search.revision}});
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
