import 'reflect-metadata';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaService } from '../../src/database/prisma.service';
import { ListingsService } from '../../src/listings/listings.service';
import { OutboxService } from '../../src/delivery/outbox.service';
import { DeliveryError } from '../../src/delivery/telegram';
import { runVesteda } from '../../src/sources/vesteda-runner';
import { SOURCE_ID as VESTEDA_SOURCE_ID, SEARCH_URL as VESTEDA_URL, SourceError } from '../../src/sources/vesteda-core';
import type { ListingInput } from '../../src/listings/listings.service';
import { smoke } from '../../scripts/outbox-smoke.mjs';
import { createRequire } from 'node:module';
const requireFromRoot = createRequire(`${process.cwd()}/package.json`);
const { runFunda } = requireFromRoot('./scripts/funda-runner.cjs');
const { SOURCE_ID, FundaError } = requireFromRoot('./scripts/funda-core.cjs');
const { runHuurwoningen } = requireFromRoot('./scripts/huurwoningen-runner.cjs');
const { SOURCE_ID: HUUR_SOURCE_ID, SEARCH_URL: HUUR_SEARCH_URL } = requireFromRoot('./scripts/huurwoningen-core.cjs');
const { runWoldring } = requireFromRoot('./scripts/woldring-runner.cjs');
const { SOURCE_ID: WOLDRING_SOURCE_ID, SEARCH_URLS: WOLDRING_URLS } = requireFromRoot('./scripts/woldring-core.cjs');

// Run only against an explicitly supplied disposable database (never load .env).
assert.ok(process.env.DATABASE_URL, 'Supply a disposable DATABASE_URL');
process.env.REDIS_URL = 'redis://localhost:6379';
process.env.TELEGRAM_DELIVERY_ENABLED = 'true';
process.env.TELEGRAM_BOT_TOKEN = '123:test';
process.env.TELEGRAM_CHAT_ID = '-123';
process.env.TELEGRAM_MAX_ATTEMPTS = '2';
const db = new PrismaService();
const service = new ListingsService(db);
const ids: string[] = [];
before(() => db.$connect());
after(async () => {
  // Outbox tests deliberately create DEAD_LETTER/UNCERTAIN. Even an inherited
  // SENTRY_DSN must never load the runtime SDK or send those failures externally.
  assert.equal(requireFromRoot.cache[requireFromRoot.resolve('@sentry/node')], undefined);
  await db.notificationOutbox.deleteMany({ where: { listing: { sourceId: { in: ids } } } });
  await db.housingListing.deleteMany({ where: { sourceId: { in: ids } } });
  await db.monitoringRun.deleteMany({ where: { sourceId: { in: ids } } });
  await db.siteProfile.deleteMany({ where: { sourceId: { in: ids } } });
  await db.source.deleteMany({ where: { id: { in: ids } } });
  await db.deliveryGate.deleteMany();
  await db.$disconnect();
});
const item = (externalId: string) => ({ externalId, title: 'Apartment', city: 'Groningen', canonicalUrl: `https://example.com/${externalId}`, rentPrice: 900 });
async function source() {
  const s = await db.source.create({ data: { name: 'Test', baseUrl: 'https://example.com', allowedDomains: ['example.com'] } });
  ids.push(s.id); return s;
}
async function resetGate() { await db.deliveryGate.deleteMany(); }
function worker(send: (chat: string, text: string) => Promise<string>) {
  const w = new OutboxService(db);
  (w as any).sender = { send };
  return w;
}
async function pending() {
  const s = await source();
  await service.recordValidatedRun(s.id, [], '-123');
  await service.recordValidatedRun(s.id, [item(s.id)], '-123');
  return db.notificationOutbox.findFirstOrThrow({ where: { listing: { sourceId: s.id } } });
}

test('concurrent baseline, external ID and URL deduplication suppress duplicate events', async () => {
  const s = await source();
  await Promise.all([service.recordValidatedRun(s.id, [item('a')], '-123'), service.recordValidatedRun(s.id, [item('a')], '-123')]);
  assert.equal(await db.notificationOutbox.count(), 0);
  await service.recordValidatedRun(s.id, [item('a'), item('b')], '-123');
  await service.recordValidatedRun(s.id, [{ ...item('b'), externalId: 'changed-id' }], '-123');
  assert.equal(await db.notificationOutbox.count(), 1);
  assert.equal(await db.housingListing.count({ where: { sourceId: s.id } }), 2);
  await db.notificationOutbox.updateMany({ data: { status: 'SENT' } });
});

test('rollback includes listings and baseline when outbox insertion fails', async () => {
  const s = await source(); await service.recordValidatedRun(s.id, [], '-123');
  await db.$executeRawUnsafe(`CREATE FUNCTION reject_test_outbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test rollback'; END $$`);
  await db.$executeRawUnsafe(`CREATE TRIGGER reject_test_outbox BEFORE INSERT ON "NotificationOutbox" FOR EACH ROW EXECUTE FUNCTION reject_test_outbox()`);
  try {
    await assert.rejects(service.recordValidatedRun(s.id, [item('rollback')], '-123'));
    assert.equal(await db.housingListing.count({ where: { sourceId: s.id } }), 0);
  } finally {
    await db.$executeRawUnsafe(`DROP TRIGGER reject_test_outbox ON "NotificationOutbox"`);
    await db.$executeRawUnsafe(`DROP FUNCTION reject_test_outbox()`);
  }
});

test('parallel workers send once; persisted gate survives a new worker', async () => {
  await resetGate(); const job = await pending(); const second = await pending();
  let calls = 0;
  const send = async () => { calls++; return '42'; };
  await Promise.all([worker(send).tick(), worker(send).tick()]);
  assert.equal(calls, 1);
  assert.equal((await db.notificationOutbox.findUniqueOrThrow({ where: { id: job.id } })).status, 'SENT');
  await worker(send).tick(); assert.equal(calls, 1);
  await db.notificationOutbox.update({ where: { id: second.id }, data: { status: 'SENT' } });
});

test('429 delays bot-wide delivery, retries stop at max attempts', async () => {
  await resetGate(); const job = await pending();
  const w = worker(async () => { throw new DeliveryError('RATE_LIMIT', false, true, 120); });
  await w.tick();
  let row = await db.notificationOutbox.findUniqueOrThrow({ where: { id: job.id } });
  assert.equal(row.status, 'PENDING'); assert.equal(row.attempts, 1);
  assert.ok(row.nextAttemptAt.getTime() > Date.now() + 110000);
  assert.ok((await db.deliveryGate.findUniqueOrThrow({ where: { id: 'telegram' } })).nextAttemptAt.getTime() > Date.now() + 110000);
  await resetGate(); await db.notificationOutbox.update({ where: { id: job.id }, data: { nextAttemptAt: new Date(0) } });
  await w.tick(); row = await db.notificationOutbox.findUniqueOrThrow({ where: { id: job.id } });
  assert.equal(row.status, 'DEAD_LETTER'); assert.equal(row.attempts, 2);
});

test('network ambiguity and interrupted sends require manual review without automatic retries', async () => {
  await resetGate(); const job = await pending();
  await worker(async () => { throw new DeliveryError('TRANSPORT_UNCERTAIN', true); }).tick();
  assert.equal((await db.notificationOutbox.findUniqueOrThrow({ where: { id: job.id } })).status, 'UNCERTAIN');
  const interrupted = await pending();
  await db.notificationOutbox.update({ where: { id: interrupted.id }, data: { status: 'SENDING', lockedUntil: new Date(0), lockToken: 'old' } });
  await resetGate(); let calls = 0;
  await worker(async () => { calls++; return '100'; }).tick();
  assert.equal(calls, 0);
  assert.equal((await db.notificationOutbox.findUniqueOrThrow({ where: { id: interrupted.id } })).status, 'UNCERTAIN');
});


test('confirmed HTTP delivery followed by database failure is quarantined after lease expiry', async () => {
  await resetGate(); const job = await pending();
  let calls = 0;
  const w = worker(async () => { calls++; return '999'; });
  const transact = db.$transaction.bind(db);
  let transactions = 0;
  (db as any).$transaction = (...args: any[]) => {
    transactions++;
    if (transactions === 2) throw new Error('simulated database outage after HTTP success');
    return (transact as any)(...args);
  };
  try { await assert.rejects(w.tick()); }
  finally { (db as any).$transaction = transact; }
  assert.equal(calls, 1);
  assert.equal((await db.notificationOutbox.findUniqueOrThrow({ where: { id: job.id } })).status, 'SENDING');
  await worker(async () => { calls++; return '1000'; }).tick();
  assert.equal(calls, 1);
  await db.notificationOutbox.update({ where: { id: job.id }, data: { lockedUntil: new Date(0) } });
  await resetGate();
  await worker(async () => { calls++; return '1001'; }).tick();
  assert.equal(calls, 1);
  assert.equal((await db.notificationOutbox.findUniqueOrThrow({ where: { id: job.id } })).status, 'UNCERTAIN');
});

test('smoke check uses the existing worker and a stable run ID across CLI restarts', async () => {
  await resetGate();
  const runId = `smoke-${Date.now()}`;
  ids.push(`outbox-smoke:${runId}`);
  let calls = 0;
  const w = worker(async () => { calls++; return '12345'; });
  const wait = async () => { await w.tick(); };
  const first = await smoke(db, service, '-123', runId, wait);
  assert.equal(first.baselineVerified, true);
  assert.equal(first.status, 'SENT');
  assert.equal(first.attempts, 1);
  const repeated = await smoke(db, new ListingsService(db), '-123', runId, wait);
  assert.equal(repeated.baselineVerified, false);
  assert.equal(repeated.id, first.id);
  assert.equal(repeated.telegramMessageId, first.telegramMessageId);
  assert.equal(calls, 1);
});

test('smoke check preserves an ambiguous job and never requeues it on rerun', async () => {
  await resetGate();
  const runId = `uncertain-${Date.now()}`;
  ids.push(`outbox-smoke:${runId}`);
  let calls = 0;
  const w = worker(async () => { calls++; throw new DeliveryError('TRANSPORT_UNCERTAIN', true); });
  const wait = async () => { await w.tick(); };
  await assert.rejects(smoke(db, service, '-123', runId, wait), /UNCERTAIN/);
  await assert.rejects(smoke(db, service, '-123', runId, wait), /UNCERTAIN/);
  assert.equal(calls, 1);
  assert.equal(await db.notificationOutbox.count({ where: { listing: { sourceId: `outbox-smoke:${runId}` } } }), 1);
});

test('Funda runs preserve baseline, deduplicate and retain last success on blocked or malformed responses', async () => {
  ids.push(SOURCE_ID);
  const scope = { sourceId: SOURCE_ID };
  const listing = { ...item('funda-1'), canonicalUrl: 'https://www.funda.nl/detail/huur/groningen/appartement-test/12345678/',
    publishedAt: new Date(), availabilityStatus: 'available' };
  const collector = async () => ({ listings: [listing], inspected: 1 });
  const options = { destination: '-123', collector };
  const first = await runFunda(db, service, options);
  assert.equal(first.baseline, true);
  assert.equal(await db.notificationOutbox.count({ where: { listing: scope } }), 0);
  assert.ok((await db.housingListing.findFirstOrThrow({ where: scope })).publishedAt);
  assert.equal((await runFunda(db, service, options)).skipped, true);
  const due = () => db.source.update({ where: { id: SOURCE_ID }, data: { nextCheckAt: new Date(0) } });
  await due();
  await runFunda(db, service, { ...options, collector: async () => ({ inspected: 2, listings: [listing,
    { ...listing, externalId: 'funda-2', canonicalUrl: 'https://www.funda.nl/detail/huur/groningen/appartement-test/12345679/' }] }) });
  const jobs = { listing: scope };
  assert.equal(await db.notificationOutbox.count({ where: jobs }), 1);
  await due(); await runFunda(db, service, options);
  assert.equal(await db.notificationOutbox.count({ where: jobs }), 1);
  const before = await db.source.findUniqueOrThrow({ where: { id: SOURCE_ID } });
  await due();
  await assert.rejects(runFunda(db, service, { ...options, collector: async () => { throw new FundaError('HUMAN_CHECK', true); } }), /HUMAN_CHECK/);
  const blocked = await db.source.findUniqueOrThrow({ where: { id: SOURCE_ID } });
  assert.equal(blocked.status, 'BLOCKED'); assert.deepEqual(blocked.lastSuccessAt, before.lastSuccessAt);
  assert.deepEqual(blocked.baselineAt, before.baselineAt);
  assert.ok(blocked.nextCheckAt!.getTime() > Date.now() + 21000000);
  await due();
  await assert.rejects(runFunda(db, service, { ...options, collector: async () => { throw new FundaError('PUBLICATION_DATE_MISSING'); } }));
  const degraded = await db.source.findUniqueOrThrow({ where: { id: SOURCE_ID } });
  assert.equal(degraded.status, 'DEGRADED'); assert.deepEqual(degraded.lastSuccessAt, before.lastSuccessAt);
  assert.equal(await db.monitoringRun.count({ where: { ...scope, status: 'FAILED' } }), 2);
  assert.equal(await db.notificationOutbox.count({ where: jobs }), 1);
});

test('Funda durable lease prevents overlap and stale workers cannot commit findings', async () => {
  await db.source.update({ where: { id: SOURCE_ID }, data: { nextCheckAt: new Date(0) } });
  let release!: () => void;
  let entered!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const running = runFunda(db, service, { destination: '-123', collector: async () => {
    entered(); await waiting; return { listings: [], inspected: 0 };
  } });
  await started;
  assert.equal((await runFunda(db, service, { destination: '-123', collector: async () => { throw new Error('must not run'); } })).skipped, true);
  const previous = await db.source.findUniqueOrThrow({ where: { id: SOURCE_ID } });
  assert.equal(previous.monitorLeaseUntil!.getTime()-previous.lastAttemptAt!.getTime(),180000);
  await db.source.update({ where: { id: SOURCE_ID }, data: { monitorLeaseUntil: new Date(0) } });
  const rejected = assert.rejects(running, /LEASE_LOST/);
  release(); await rejected;
  assert.deepEqual((await db.source.findUniqueOrThrow({ where: { id: SOURCE_ID } })).lastSuccessAt, previous.lastSuccessAt);
});

test('source recovery alerts use the same durable delivery without creating housing listings', async () => {
  await resetGate();
  await db.notificationOutbox.updateMany({where:{status:'PENDING'},data:{status:'SENT'}});
  const before=await db.housingListing.count();
  const data={idempotencyKey:'recovery:test-episode',destinationRef:'-123',payload:'Funda needs manual verification'};
  await Promise.all([db.notificationOutbox.createMany({data:[data],skipDuplicates:true}),db.notificationOutbox.createMany({data:[data],skipDuplicates:true})]);
  let calls=0;
  await worker(async()=>{calls++;return 'recovery-message'}).tick();
  const alert=await db.notificationOutbox.findUniqueOrThrow({where:{idempotencyKey:data.idempotencyKey}});
  assert.equal(alert.listingId,null);assert.equal(alert.status,'SENT');assert.equal(calls,1);
  assert.equal(await db.housingListing.count(),before);
  await db.notificationOutbox.delete({where:{id:alert.id}});
});

test('browser CAPTCHA creates one recovery alert and saving the session resumes the blocked scheduler', async()=>{
  const {FundaService}=await import('../../src/sources/funda.service');
  process.env.FUNDA_BROWSER_ORIGIN='https://funda-browser-session-production.up.railway.app';
  process.env.FUNDA_BROWSER_TOKEN='x'.repeat(43);
  const original=globalThis.fetch;let recovered=false,collections=0;
  globalThis.fetch=async(input)=>{
    const path=new URL(String(input)).pathname;
    if(path==='/worker/state')return Response.json({humanCheck:!recovered,accessDenied:false,recovered,listingLinks:recovered?1:0});
    if(path==='/worker/recovery')return Response.json({id:'a'.repeat(32),url:process.env.FUNDA_BROWSER_ORIGIN+'/#key='+'y'.repeat(43)});
    collections++;
    return recovered?Response.json({listings:[],inspected:1,settingsFingerprint:requireFromRoot('./scripts/search-settings.cjs').fingerprint(requireFromRoot('./scripts/search-settings.cjs').defaults(SOURCE_ID))}):Response.json({category:'HUMAN_CHECK',blocked:true},{status:422});
  };
  try {
    const monitor=new FundaService(db,service);
    await db.source.update({where:{id:SOURCE_ID},data:{status:'DEGRADED',nextCheckAt:new Date(0),monitorLeaseToken:null,monitorLeaseUntil:null}});
    await assert.rejects(monitor.tick(),/HUMAN_CHECK/);
    assert.equal((await db.source.findUniqueOrThrow({where:{id:SOURCE_ID}})).status,'BLOCKED');
    await monitor.tick();await monitor.tick();assert.equal(collections,1);
    assert.equal(await db.notificationOutbox.count({where:{idempotencyKey:'funda-recovery:'+'a'.repeat(32)}}),1);
    recovered=true;
    const result=await monitor.tick();assert.equal(result.skipped,false);
    assert.equal((await db.source.findUniqueOrThrow({where:{id:SOURCE_ID}})).status,'HEALTHY');
    assert.equal(collections,2);
  } finally {
    globalThis.fetch=original;delete process.env.FUNDA_BROWSER_ORIGIN;delete process.env.FUNDA_BROWSER_TOKEN;
    await db.notificationOutbox.deleteMany({where:{idempotencyKey:'funda-recovery:'+'a'.repeat(32)}});
  }
});

test('Woldring baseline, status transitions, retry rollback and notification deduplication', async () => {
  ids.push(WOLDRING_SOURCE_ID);
  const first = {...item('woldring-first'),canonicalUrl:'https://woldringverhuur.nl/first/',availabilityStatus:'available' as const,
    serviceCosts:95,housingDetails:{propertyType:'apartment' as const,availableFrom:'now',energyLabel:'A+',huurtoeslag:true,utilities:'separate' as const,applicationsClosed:true}};
  const unavailable={...first,externalId:'woldring-second',canonicalUrl:'https://woldringverhuur.nl/second/',availabilityStatus:'unavailable' as const};
  const run=(input:any[])=>runWoldring(db,service,{destination:'-123',collector:async()=>({listings:input,inspected:input.length})});
  assert.equal((await run([first,unavailable])).baseline,true);
  assert.equal(await db.notificationOutbox.count({where:{listing:{sourceId:WOLDRING_SOURCE_ID}}}),0);
  const profile=await db.siteProfile.findUniqueOrThrow({where:{sourceId:WOLDRING_SOURCE_ID}});
  assert.deepEqual(profile.searchUrls,WOLDRING_URLS);assert.equal(profile.authStrategy,'none');
  assert.equal((await run([first])).skipped,true);
  const nowAvailable={...unavailable,availabilityStatus:'available' as const};
  await db.source.update({where:{id:WOLDRING_SOURCE_ID},data:{nextCheckAt:new Date(0)}});
  const results=await Promise.all([run([first,nowAvailable]),run([first,nowAvailable])]);
  assert.equal(results.filter(x=>!x.skipped).length,1);
  const alerts=await db.notificationOutbox.findMany({where:{listing:{sourceId:WOLDRING_SOURCE_ID}}});
  assert.equal(alerts.length,1);assert.match(alerts[0].payload,/Servicekosten: €95/);assert.match(alerts[0].payload,/Аренда \+ servicekosten:/);
  assert.match(alerts[0].payload,/Приём заявок закрыт/);assert.doesNotMatch(alerts[0].payload,/Опубликовано:/);
  for(const input of [[first,unavailable],[first,nowAvailable]]) {
    await db.source.update({where:{id:WOLDRING_SOURCE_ID},data:{nextCheckAt:new Date(0)}});await run(input);
  }
  assert.equal(await db.notificationOutbox.count({where:{listing:{sourceId:WOLDRING_SOURCE_ID}}}),1);
  const third={...first,externalId:'woldring-third',canonicalUrl:'https://woldringverhuur.nl/third/'};
  await db.source.update({where:{id:WOLDRING_SOURCE_ID},data:{nextCheckAt:new Date(0)}});await run([first,nowAvailable,third]);
  assert.equal(await db.notificationOutbox.count({where:{listing:{sourceId:WOLDRING_SOURCE_ID}}}),2);
  const before=await db.source.findUniqueOrThrow({where:{id:WOLDRING_SOURCE_ID}});
  await db.source.update({where:{id:WOLDRING_SOURCE_ID},data:{nextCheckAt:new Date(0)}});
  await assert.rejects(runWoldring(db,service,{destination:'-123',collector:async()=>{throw new FundaError('INCOMPLETE_SEARCH')}}),/INCOMPLETE_SEARCH/);
  const failed=await db.source.findUniqueOrThrow({where:{id:WOLDRING_SOURCE_ID}});
  assert.deepEqual(failed.lastSuccessAt,before.lastSuccessAt);assert.deepEqual(failed.baselineAt,before.baselineAt);assert.equal(failed.status,'DEGRADED');
});

test('Vesteda baseline, lease, availability updates without housingDetails and failures preserve delivery state', async () => {
  const { VestedaService } = await import('../../src/sources/vesteda.service');
  const previous = process.env.VESTEDA_MONITORING_ENABLED;
  process.env.VESTEDA_MONITORING_ENABLED='false';
  try {
    const monitor = new VestedaService(db,service);
    assert.equal((await monitor.tick()).skipped,true);
    assert.equal(await db.source.count({where:{id:VESTEDA_SOURCE_ID}}),0);
  } finally {
    if(previous !== undefined) process.env.VESTEDA_MONITORING_ENABLED=previous;
    else delete process.env.VESTEDA_MONITORING_ENABLED;
  }
  ids.push(VESTEDA_SOURCE_ID);
  const first: ListingInput = { ...item('50412'), canonicalUrl: 'https://www.vesteda.com/nl/huurwoningen-groningen/westerwal/toxopeusstraat-210-groningen-50412', availabilityStatus: 'available' };
  const reserved: ListingInput = { ...first, externalId: '32752', canonicalUrl: 'https://www.vesteda.com/nl/huurwoningen-groningen/kolenpark/eelkemastraat-83-groningen-32752', availabilityStatus: 'unavailable' };
  const run = (input: ListingInput[]) => runVesteda(db, service, { destination: '-123', collector: async () => ({listings:input,inspected:input.length,total:input.length,pages:1,available:input.filter(x=>x.availabilityStatus==='available').length}) });
  const due = () => db.source.update({where:{id:VESTEDA_SOURCE_ID},data:{nextCheckAt:new Date(0)}});
  const jobs = {listing:{sourceId:VESTEDA_SOURCE_ID}};
  const baseline = await run([first,reserved]); assert.equal(baseline.skipped,false);
  if (!baseline.skipped) assert.equal(baseline.baseline,true);
  assert.equal(await db.notificationOutbox.count({where:jobs}),0);
  const profile = await db.siteProfile.findUniqueOrThrow({where:{sourceId:VESTEDA_SOURCE_ID}});
  assert.deepEqual(profile.searchUrls,[requireFromRoot('./scripts/search-settings.cjs').queryUrl(VESTEDA_SOURCE_ID,VESTEDA_URL,requireFromRoot('./scripts/search-settings.cjs').defaults(VESTEDA_SOURCE_ID))]); assert.equal(profile.authStrategy,'none');
  assert.deepEqual(profile.filters,{city:'Groningen',radiusKm:20,minRent:500,maxRent:1500,minArea:null,filtering:'vesteda-search'});
  assert.equal((await run([first])).skipped,true);
  const available = {...reserved,availabilityStatus:'available' as const,rentPrice:1138.85};
  await due();
  const concurrent=await Promise.all([run([first,available]),run([first,available])]);
  assert.equal(concurrent.filter(x=>!x.skipped).length,1);
  assert.equal(await db.notificationOutbox.count({where:jobs}),1);
  const stored=await db.housingListing.findFirstOrThrow({where:{sourceId:VESTEDA_SOURCE_ID,externalId:'32752'}});
  assert.equal(stored.availabilityStatus,'available');assert.equal(Number(stored.rentPrice),1138.85);
  for(const input of [[first,reserved],[first,available]]) {await due();await run(input);}
  assert.equal(await db.notificationOutbox.count({where:jobs}),1);
  const third={...first,externalId:'50339',canonicalUrl:'https://www.vesteda.com/nl/huurwoningen-groningen/westerwal/toxopeusstraat-60-groningen-50339'};
  await due();await run([first,available,third]);assert.equal(await db.notificationOutbox.count({where:jobs}),2);
  const before=await db.source.findUniqueOrThrow({where:{id:VESTEDA_SOURCE_ID}});
  for(const error of [new SourceError('INCOMPLETE_SEARCH'),new SourceError('ACCESS_BLOCKED',true)]) {
    await due();await assert.rejects(runVesteda(db,service,{destination:'-123',collector:async()=>{throw error;}}));
    const after=await db.source.findUniqueOrThrow({where:{id:VESTEDA_SOURCE_ID}});
    assert.deepEqual(after.baselineAt,before.baselineAt);assert.deepEqual(after.lastSuccessAt,before.lastSuccessAt);
    assert.equal(after.status,error.blocked?'BLOCKED':'DEGRADED');
    assert.equal(await db.notificationOutbox.count({where:jobs}),2);
  }
});

test('Huurwoningen has its own baseline, lease, filters and transactional notification deduplication', async () => {
  ids.push(HUUR_SOURCE_ID);
  const first = { ...item('83108c92'), canonicalUrl: 'https://www.huurwoningen.com/huren/groningen/83108c92/eeldersingel/' };
  const second = { ...item('abcdef12'), canonicalUrl: 'https://www.huurwoningen.com/huren/groningen/abcdef12/andere-straat/' };
  const run = (input: any[]) => runHuurwoningen(db, service, { destination: '-123', collector: async () => ({ listings: input, inspected: input.length }) });
  const baseline = await run([first]); assert.equal(baseline.baseline, true);
  assert.equal(await db.notificationOutbox.count({ where: { listing: { sourceId: HUUR_SOURCE_ID } } }), 0);
  const profile = await db.siteProfile.findUniqueOrThrow({ where: { sourceId: HUUR_SOURCE_ID } });
  assert.deepEqual(profile.searchUrls, [HUUR_SEARCH_URL]);
  assert.deepEqual(profile.filters, {city:'Groningen',radiusKm:25,maxRent:1500,since:'1',availableFrom:'within_3_months',excludedOfferTypes:['homeswap'],minRent:0,minArea:null,filtering:'huurwoningen-search'});
  assert.match(profile.browserStateRef!, /huurwoningen-browser-session/);
  assert.equal((await run([first])).skipped, true);
  await db.source.update({ where: { id: HUUR_SOURCE_ID }, data: { nextCheckAt: new Date(0) } });
  const results = await Promise.all([run([first, second]), run([first, second])]);
  assert.equal(results.filter(x => !x.skipped).length, 1);
  assert.equal(await db.notificationOutbox.count({ where: { listing: { sourceId: HUUR_SOURCE_ID } } }), 1);
  await db.source.update({ where: { id: HUUR_SOURCE_ID }, data: { nextCheckAt: new Date(0) } });
  await run([first, second]);
  assert.equal(await db.notificationOutbox.count({ where: { listing: { sourceId: HUUR_SOURCE_ID } } }), 1);
});

test('Huurwoningen recovery deduplicates alerts and resumes even when the validated search is empty', async () => {
  const { HuurwoningenService } = await import('../../src/sources/huurwoningen.service');
  process.env.HUURWONINGEN_BROWSER_ORIGIN = 'https://huurwoningen-browser-session-production.up.railway.app';
  process.env.HUURWONINGEN_BROWSER_TOKEN = 'x'.repeat(43);
  const original = globalThis.fetch; let recovered = false, collections = 0;
  globalThis.fetch = async input => {
    const path = new URL(String(input)).pathname;
    if (path === '/worker/state') return Response.json({humanCheck:!recovered,accessDenied:false,recovered,listingLinks:0,searchReady:recovered});
    if (path === '/worker/recovery') return Response.json({id:'b'.repeat(32),url:process.env.HUURWONINGEN_BROWSER_ORIGIN+'/#key='+'y'.repeat(43)});
    collections++;
    return recovered ? Response.json({listings:[],inspected:0,settingsFingerprint:requireFromRoot('./scripts/search-settings.cjs').fingerprint(requireFromRoot('./scripts/search-settings.cjs').defaults(HUUR_SOURCE_ID))}) : Response.json({category:'HUMAN_CHECK',blocked:true},{status:422});
  };
  try {
    const monitor = new HuurwoningenService(db,service);
    const before = await db.source.findUniqueOrThrow({where:{id:HUUR_SOURCE_ID}});
    await db.source.update({where:{id:HUUR_SOURCE_ID},data:{nextCheckAt:new Date(0)}});
    await assert.rejects(monitor.tick(),/HUMAN_CHECK/);
    const blocked = await db.source.findUniqueOrThrow({where:{id:HUUR_SOURCE_ID}});
    assert.equal(blocked.status,'BLOCKED');assert.deepEqual(blocked.lastSuccessAt,before.lastSuccessAt);
    await monitor.tick();await monitor.tick();assert.equal(collections,1);
    assert.equal(await db.notificationOutbox.count({where:{idempotencyKey:'huurwoningen-recovery:'+'b'.repeat(32)}}),1);
    recovered=true;assert.equal((await monitor.tick()).skipped,false);
    assert.equal((await db.source.findUniqueOrThrow({where:{id:HUUR_SOURCE_ID}})).status,'HEALTHY');
    assert.equal(collections,2);
  } finally {
    globalThis.fetch=original;delete process.env.HUURWONINGEN_BROWSER_ORIGIN;delete process.env.HUURWONINGEN_BROWSER_TOKEN;
    await db.notificationOutbox.deleteMany({where:{idempotencyKey:'huurwoningen-recovery:'+'b'.repeat(32)}});
  }
});


test('Gruno uses a separate baseline/lease, deduplicates availability events and never adds included costs twice', async () => {
  const {runGruno}=requireFromRoot('./scripts/gruno-runner.cjs');
  const {SOURCE_ID:grunoId,SEARCH_URL:grunoUrl,FILTERS:grunoFilters,parseCard,parseDetail}=requireFromRoot('./scripts/gruno-core.cjs');
  const {readFileSync}=await import('node:fs');
  const {GrunoService}=await import('../../src/sources/gruno.service');
  const previous=process.env.GRUNO_MONITORING_ENABLED;
  process.env.GRUNO_MONITORING_ENABLED='false';
  try {
    assert.equal((await new GrunoService(db,service).tick()).skipped,true);
    assert.equal(await db.source.count({where:{id:grunoId}}),0);
  } finally {
    if(previous===undefined)delete process.env.GRUNO_MONITORING_ENABLED;
    else process.env.GRUNO_MONITORING_ENABLED=previous;
  }
  ids.push(grunoId);
  const first:ListingInput=parseDetail(readFileSync('test/fixtures/gruno-detail.html','utf8'),parseCard(readFileSync('test/fixtures/gruno-card.html','utf8')));
  const second:ListingInput={...first,externalId:'01767',canonicalUrl:'https://www.grunoverhuur.nl/woningaanbod/huur/groningen/hoendiep/29-1',availabilityStatus:'unavailable'};
  const run=(input:ListingInput[])=>runGruno(db,service,{destination:'-123',collector:async()=>({listings:input,inspected:input.length})});
  const due=()=>db.source.update({where:{id:grunoId},data:{nextCheckAt:new Date(0)}});
  const jobs={listing:{sourceId:grunoId}};
  assert.equal((await run([first,second])).baseline,true);
  assert.equal(await db.notificationOutbox.count({where:jobs}),0);
  const profile=await db.siteProfile.findUniqueOrThrow({where:{sourceId:grunoId}});
  assert.deepEqual(profile.searchUrls,[grunoUrl]);assert.deepEqual(profile.filters,{...grunoFilters,...requireFromRoot('./scripts/search-settings.cjs').defaults(grunoId)});assert.equal(profile.authStrategy,'none');
  assert.equal((await run([first])).skipped,true);
  const available={...second,availabilityStatus:'available' as const};
  await due();const concurrent=await Promise.all([run([first,available]),run([first,available])]);
  assert.equal(concurrent.filter(x=>!x.skipped).length,1);
  const notification=await db.notificationOutbox.findFirstOrThrow({where:jobs});
  assert.match(notification.payload,/Цена в объявлении: €1232/);assert.match(notification.payload,/Servicekosten: €130 \(включены в цену\)/);
  assert.doesNotMatch(notification.payload,/Аренда \+ servicekosten|1362/);
  const stored=await db.housingListing.findFirstOrThrow({where:{sourceId:grunoId,externalId:second.externalId}});
  assert.equal(JSON.parse(stored.rawSourceRef!).priceBasis,'advertised');
  for(const input of [[first,second],[first,available]]) {await due();await run(input);}
  assert.equal(await db.notificationOutbox.count({where:jobs}),1);
  const third={...first,externalId:'01765',canonicalUrl:'https://www.grunoverhuur.nl/woningaanbod/huur/groningen/oudeweg/9-e',
    housingDetails:{...first.housingDetails!,serviceCostsIncluded:undefined}};
  await due();await run([first,available,third]);
  const unknown=await db.notificationOutbox.findFirstOrThrow({where:{listing:{sourceId:grunoId,externalId:'01765'}}});
  assert.match(unknown.payload,/включение в цену не уточнено/);assert.doesNotMatch(unknown.payload,/Аренда \+ servicekosten|1362/);
  const before=await db.source.findUniqueOrThrow({where:{id:grunoId}});
  for(const error of [new FundaError('INCOMPLETE_SEARCH'),new FundaError('ACCESS_BLOCKED',true)]) {
    await due();await assert.rejects(runGruno(db,service,{destination:'-123',collector:async()=>{throw error}}));
    const after=await db.source.findUniqueOrThrow({where:{id:grunoId}});
    assert.deepEqual(after.baselineAt,before.baselineAt);assert.deepEqual(after.lastSuccessAt,before.lastSuccessAt);
    assert.equal(after.status,error.blocked?'BLOCKED':'DEGRADED');assert.equal(await db.notificationOutbox.count({where:jobs}),2);
  }
  const uncertain:ListingInput={...first,externalId:'01888',canonicalUrl:'https://www.grunoverhuur.nl/woningaanbod/huur/groningen/unknownstraat/1',availabilityStatus:'unknown'};
  await due();await run([first,available,third,uncertain]);
  assert.equal(await db.notificationOutbox.count({where:jobs}),2);
  assert.equal((await db.housingListing.findFirstOrThrow({where:{sourceId:grunoId,externalId:'01888'}})).availabilityStatus,'unknown');
  await due();await run([{...uncertain,availabilityStatus:'available'}]);
  assert.equal(await db.notificationOutbox.count({where:jobs}),3);
  const beforeRollback=await db.source.findUniqueOrThrow({where:{id:grunoId}});
  // Rollback includes Gruno listings, baseline and run success if outbox fails.
  const fourth={...first,externalId:'01999',canonicalUrl:'https://www.grunoverhuur.nl/woningaanbod/huur/groningen/teststraat/1'};
  const failing=new ListingsService(db);
  failing.recordValidatedRunInTransaction=async(tx,...args)=>{await service.recordValidatedRunInTransaction(tx,...args);throw Error('rollback')};
  await due();await assert.rejects(runGruno(db,failing,{destination:'-123',collector:async()=>({listings:[fourth],inspected:1})}));
  assert.equal(await db.housingListing.count({where:{sourceId:grunoId,externalId:'01999'}}),0);
  assert.deepEqual((await db.source.findUniqueOrThrow({where:{id:grunoId}})).lastSuccessAt,beforeRollback.lastSuccessAt);
});

test('Lamberink has an independent baseline, strict availability, admin filters and transactional failure handling', async () => {
  const { runLamberink } = await import('../../src/sources/lamberink-runner');
  const { LamberinkService } = await import('../../src/sources/lamberink.service');
  const { parseSearch, SOURCE_ID: id, SEARCH_URL } = await import('../../src/sources/lamberink-core');
  const { readFileSync } = await import('node:fs');
  const registry = requireFromRoot('./scripts/search-settings.cjs');
  const old = process.env.LAMBERINK_MONITORING_ENABLED;
  try {
    process.env.LAMBERINK_MONITORING_ENABLED = 'false';
    assert.equal((await new LamberinkService(db,service).tick()).skipped, true);
    assert.equal(await db.source.count({where:{id}}), 0);
  } finally { if (old === undefined) delete process.env.LAMBERINK_MONITORING_ENABLED; else process.env.LAMBERINK_MONITORING_ENABLED = old; }
  ids.push(id);
  const parsed = parseSearch(JSON.parse(readFileSync('test/fixtures/lamberink-search.json','utf8')));
  const run = (input:ListingInput[]) => runLamberink(db,service,{destination:'-123',collector:async()=>({...parsed,listings:input})});
  const due = () => db.source.update({where:{id},data:{nextCheckAt:new Date(0)}});
  const jobs = {listing:{sourceId:id}};
  assert.equal((await run(parsed.listings) as any).baseline, true);
  assert.equal(await db.notificationOutbox.count({where:jobs}),0);
  const profile = await db.siteProfile.findUniqueOrThrow({where:{sourceId:id}});
  assert.deepEqual(profile.searchUrls,[SEARCH_URL]); assert.equal(profile.authStrategy,'none');
  await due(); assert.equal((await run(parsed.listings) as any).created,0);
  const home:ListingInput = {...parsed.listings[0]!,externalId:'NEW1',canonicalUrl:'https://lamberink.nl/wonen/aanbod/test-new1',availabilityStatus:'unknown'};
  await due(); await run([...parsed.listings,home]);
  assert.equal(await db.notificationOutbox.count({where:jobs}),0);
  await due(); await run([...parsed.listings,{...home,availabilityStatus:'available'}]);
  assert.equal(await db.notificationOutbox.count({where:jobs}),1);
  await due(); await run([...parsed.listings,{...home,availabilityStatus:'available'}]);
  assert.equal(await db.notificationOutbox.count({where:jobs}),1);
  await db.searchConfiguration.update({where:{sourceId:id},data:{filters:{...registry.defaults(id),maxRent:1000}}});
  await due(); await run([{...home,externalId:'NEW2',canonicalUrl:'https://lamberink.nl/wonen/aanbod/test-new2',availabilityStatus:'available'}]);
  assert.equal(await db.notificationOutbox.count({where:jobs}),1);
  const before = await db.source.findUniqueOrThrow({where:{id}});
  await due(); await assert.rejects(runLamberink(db,service,{destination:'-123',collector:async()=>{throw new FundaError('INCOMPLETE_SEARCH')}}),/INCOMPLETE_SEARCH/);
  const after = await db.source.findUniqueOrThrow({where:{id}});
  assert.equal(after.status,'DEGRADED'); assert.deepEqual(after.baselineAt,before.baselineAt); assert.deepEqual(after.lastSuccessAt,before.lastSuccessAt);
  assert.equal(await db.notificationOutbox.count({where:jobs}),1);
});

test('Solide has an independent baseline, strict availability, admin filters and transactional failure handling', async () => {
  const { runSolide } = await import('../../src/sources/solide-runner');
  const { SolideService } = await import('../../src/sources/solide.service');
  const { parseSearch, SOURCE_ID: id, SEARCH_URL } = await import('../../src/sources/solide-core');
  const { readFileSync } = await import('node:fs');
  const registry = requireFromRoot('./scripts/search-settings.cjs');
  const old = process.env.SOLIDE_MONITORING_ENABLED;
  try {
    process.env.SOLIDE_MONITORING_ENABLED = 'false';
    assert.equal((await new SolideService(db,service).tick()).skipped, true);
    assert.equal(await db.source.count({where:{id}}), 0);
  } finally { if (old === undefined) delete process.env.SOLIDE_MONITORING_ENABLED; else process.env.SOLIDE_MONITORING_ENABLED = old; }
  ids.push(id);
  const search = parseSearch(readFileSync('test/fixtures/solide-search.html','utf8'));
  const parsed = {...search, inspected:search.listings.length, available:5};
  const run = (input:ListingInput[]) => runSolide(db,service,{destination:'-123',collector:async()=>({...parsed,listings:input})});
  const due = () => db.source.update({where:{id},data:{nextCheckAt:new Date(0)}});
  const jobs = {listing:{sourceId:id}};
  assert.equal((await run(parsed.listings) as any).baseline, true);
  assert.equal(await db.notificationOutbox.count({where:jobs}),0);
  const profile = await db.siteProfile.findUniqueOrThrow({where:{sourceId:id}});
  assert.deepEqual(profile.searchUrls,[SEARCH_URL]); assert.equal(profile.authStrategy,'none');
  await due(); assert.equal((await run(parsed.listings) as any).created,0);
  // Production regression: WordPress reassigned slugs between existing post IDs.
  // Start with legacy URL fingerprints, then swap two URLs in reverse row order.
  const {createHash} = await import('node:crypto');
  const original = await db.housingListing.findMany({where:{sourceId:id}});
  for (const row of original) await db.housingListing.update({where:{id:row.id},data:{
    urlFingerprint:createHash('sha256').update(row.canonicalUrl).digest('hex')
  }});
  const swapped = parsed.listings.map((item,index)=>({...item,canonicalUrl:index===0
    ? parsed.listings[1]!.canonicalUrl : index===1 ? parsed.listings[0]!.canonicalUrl : item.canonicalUrl})).reverse();
  await due(); assert.equal((await run(swapped) as any).created,0);
  for (const item of swapped) {
    const row = await db.housingListing.findUniqueOrThrow({where:{sourceId_externalId:{sourceId:id,externalId:item.externalId}}});
    assert.equal(row.id,original.find(x=>x.externalId===item.externalId)!.id);
    assert.equal(row.canonicalUrl,item.canonicalUrl);
    assert.equal(row.urlFingerprint,createHash('sha256').update(`externalId:${item.externalId}`).digest('hex'));
  }
  assert.equal(await db.notificationOutbox.count({where:jobs}),0);
  await due(); await run(swapped);
  assert.equal(await db.notificationOutbox.count({where:jobs}),0);
  const home:ListingInput = {...parsed.listings[0]!,externalId:'NEW1',canonicalUrl:'https://solideverhuur.nl/huurwoningen/groningen/test-new1',availabilityStatus:'unknown'};
  await due(); await run([...parsed.listings,home]);
  assert.equal(await db.notificationOutbox.count({where:jobs}),0);
  await due(); await run([...parsed.listings,{...home,availabilityStatus:'available'}]);
  assert.equal(await db.notificationOutbox.count({where:jobs}),1);
  await due(); await run([...parsed.listings,{...home,availabilityStatus:'available'}]);
  assert.equal(await db.notificationOutbox.count({where:jobs}),1);
  await db.searchConfiguration.update({where:{sourceId:id},data:{filters:{...registry.defaults(id),minArea:40}}});
  await due(); await run([{...home,externalId:'NEW2',canonicalUrl:'https://solideverhuur.nl/huurwoningen/groningen/test-new2',availabilityStatus:'available',areaM2:10}]);
  assert.equal(await db.notificationOutbox.count({where:jobs}),1);
  const before = await db.source.findUniqueOrThrow({where:{id}});
  await due(); await assert.rejects(runSolide(db,service,{destination:'-123',collector:async()=>{throw new FundaError('INCOMPLETE_SEARCH')}}),/INCOMPLETE_SEARCH/);
  const after = await db.source.findUniqueOrThrow({where:{id}});
  assert.equal(after.status,'DEGRADED'); assert.deepEqual(after.baselineAt,before.baselineAt); assert.deepEqual(after.lastSuccessAt,before.lastSuccessAt);
  assert.equal(await db.notificationOutbox.count({where:jobs}),1);
});

test('stable post identity preserves history when a new post reuses an absent post URL', async () => {
  const s=await source();
  const old={...item('old-post'),availabilityStatus:'available' as const};
  // Seed the legacy identity scheme, as already stored production rows use it.
  await service.recordValidatedRun(s.id,[old],'-123');
  const stored=await db.housingListing.findFirstOrThrow({where:{sourceId:s.id}});
  const incoming={...old,externalId:'new-post'};
  const record=()=>db.$transaction(tx=>service.recordValidatedRunInTransaction(tx,s.id,[incoming],'-123',{stableExternalId:true}));
  assert.equal((await record()).created,1);
  assert.equal((await record()).created,0);
  assert.equal(await db.housingListing.count({where:{sourceId:s.id}}),2);
  assert.equal((await db.housingListing.findUniqueOrThrow({where:{id:stored.id}})).externalId,'old-post');
  assert.equal(await db.notificationOutbox.count({where:{listing:{sourceId:s.id}}}),1);
});

test('Vandermeulen has an independent baseline, strict availability, admin filters and transactional failure handling', async () => {
  const { runVandermeulen } = await import('../../src/sources/vandermeulen-runner');
  const { VandermeulenService } = await import('../../src/sources/vandermeulen.service');
  const { parseSearch, SOURCE_ID: id, SEARCH_URL } = await import('../../src/sources/vandermeulen-core');
  const { readFileSync } = await import('node:fs');
  const registry = requireFromRoot('./scripts/search-settings.cjs');
  const old = process.env.VANDERMEULEN_MONITORING_ENABLED;
  try {
    process.env.VANDERMEULEN_MONITORING_ENABLED = 'false';
    assert.equal((await new VandermeulenService(db,service).tick()).skipped, true);
    assert.equal(await db.source.count({where:{id}}), 0);
  } finally { if (old === undefined) delete process.env.VANDERMEULEN_MONITORING_ENABLED; else process.env.VANDERMEULEN_MONITORING_ENABLED = old; }
  ids.push(id);
  const parsed = parseSearch(readFileSync('test/fixtures/vandermeulen-search.html','utf8'));
  const run = (input:ListingInput[]) => runVandermeulen(db,service,{destination:'-123',collector:async()=>({...parsed,listings:input})});
  const due = () => db.source.update({where:{id},data:{nextCheckAt:new Date(0)}});
  const jobs = {listing:{sourceId:id}};
  assert.equal((await run(parsed.listings) as any).baseline, true);
  assert.equal(await db.notificationOutbox.count({where:jobs}),0);
  const profile = await db.siteProfile.findUniqueOrThrow({where:{sourceId:id}});
  assert.deepEqual(profile.searchUrls,[SEARCH_URL]); assert.equal(profile.authStrategy,'none');
  await due(); assert.equal((await run(parsed.listings) as any).created,0);
  const home:ListingInput = {...parsed.listings[0]!,externalId:'NEW1',canonicalUrl:'https://www.vandermeulenmakelaars.nl/huurwoningen/test-h90001/',availabilityStatus:'unknown'};
  await due(); await run([...parsed.listings,home]);
  assert.equal(await db.notificationOutbox.count({where:jobs}),0);
  await due(); await run([...parsed.listings,{...home,availabilityStatus:'available'}]);
  assert.equal(await db.notificationOutbox.count({where:jobs}),1);
  await due(); await run([...parsed.listings,{...home,availabilityStatus:'available'}]);
  assert.equal(await db.notificationOutbox.count({where:jobs}),1);
  await db.searchConfiguration.update({where:{sourceId:id},data:{filters:{...registry.defaults(id),minArea:20}}});
  await due(); await run([{...home,externalId:'NEW2',canonicalUrl:'https://www.vandermeulenmakelaars.nl/huurwoningen/test-h90002/',availabilityStatus:'available'}]);
  assert.equal(await db.notificationOutbox.count({where:jobs}),1);
  const before = await db.source.findUniqueOrThrow({where:{id}});
  await due(); await assert.rejects(runVandermeulen(db,service,{destination:'-123',collector:async()=>{throw new FundaError('INCOMPLETE_SEARCH')}}),/INCOMPLETE_SEARCH/);
  const after = await db.source.findUniqueOrThrow({where:{id}});
  assert.equal(after.status,'DEGRADED'); assert.deepEqual(after.baselineAt,before.baselineAt); assert.deepEqual(after.lastSuccessAt,before.lastSuccessAt);
  assert.equal(await db.notificationOutbox.count({where:jobs}),1);
});

test('Maxx has an independent baseline, strict availability, admin filters and transactional failure handling', async () => {
  const { runMaxx } = await import('../../src/sources/maxx-runner');
  const { MaxxService } = await import('../../src/sources/maxx.service');
  const { parseSearch, SOURCE_ID: id, SEARCH_URL } = await import('../../src/sources/maxx-core');
  const { readFileSync } = await import('node:fs');
  const registry = requireFromRoot('./scripts/search-settings.cjs');
  const old = process.env.MAXX_MONITORING_ENABLED;
  try {
    process.env.MAXX_MONITORING_ENABLED = 'false';
    assert.equal((await new MaxxService(db,service).tick()).skipped, true);
    assert.equal(await db.source.count({where:{id}}), 0);
  } finally { if (old === undefined) delete process.env.MAXX_MONITORING_ENABLED; else process.env.MAXX_MONITORING_ENABLED = old; }
  ids.push(id);
  const parsed = parseSearch(readFileSync('test/fixtures/maxx-search.html','utf8'));
  const run = (input:ListingInput[]) => runMaxx(db,service,{destination:'-123',collector:async()=>({...parsed,listings:input})});
  const due = () => db.source.update({where:{id},data:{nextCheckAt:new Date(0)}});
  const jobs = {listing:{sourceId:id}};
  assert.equal((await run(parsed.listings) as any).baseline, true);
  assert.equal(await db.notificationOutbox.count({where:jobs}),0);
  const profile = await db.siteProfile.findUniqueOrThrow({where:{sourceId:id}});
  assert.deepEqual(profile.searchUrls,[SEARCH_URL]); assert.equal(profile.authStrategy,'none');
  await due(); assert.equal((await run(parsed.listings) as any).created,0);
  const home:ListingInput = {...parsed.listings[0]!,externalId:'NEW1',canonicalUrl:'https://maxxhuren.nl/objects/ads/view/id-90001/',availabilityStatus:'unknown'};
  await due(); await run([...parsed.listings,home]);
  assert.equal(await db.notificationOutbox.count({where:jobs}),0);
  await due(); await run([...parsed.listings,{...home,availabilityStatus:'available'}]);
  assert.equal(await db.notificationOutbox.count({where:jobs}),1);
  await due(); await run([...parsed.listings,{...home,availabilityStatus:'available'}]);
  assert.equal(await db.notificationOutbox.count({where:jobs}),1);
  await db.searchConfiguration.update({where:{sourceId:id},data:{filters:{...registry.defaults(id),minArea:50}}});
  await due(); await run([{...home,externalId:'NEW2',canonicalUrl:'https://maxxhuren.nl/objects/ads/view/id-90002/',availabilityStatus:'available'}]);
  assert.equal(await db.notificationOutbox.count({where:jobs}),1);
  const before = await db.source.findUniqueOrThrow({where:{id}});
  await due(); await assert.rejects(runMaxx(db,service,{destination:'-123',collector:async()=>{throw new FundaError('INCOMPLETE_SEARCH')}}),/INCOMPLETE_SEARCH/);
  const after = await db.source.findUniqueOrThrow({where:{id}});
  assert.equal(after.status,'DEGRADED'); assert.deepEqual(after.baselineAt,before.baselineAt); assert.deepEqual(after.lastSuccessAt,before.lastSuccessAt);
  assert.equal(await db.notificationOutbox.count({where:jobs}),1);
});

test('Rentsolutions has an independent baseline, strict availability, admin filters and transactional failure handling', async () => {
  const { runRentsolutions } = await import('../../src/sources/rentsolutions-runner');
  const { RentsolutionsService } = await import('../../src/sources/rentsolutions.service');
  const { parseSearch, SOURCE_ID: id, SEARCH_URL } = await import('../../src/sources/rentsolutions-core');
  const { readFileSync } = await import('node:fs');
  const registry = requireFromRoot('./scripts/search-settings.cjs');
  const old = process.env.RENTSOLUTIONS_MONITORING_ENABLED;
  try {
    process.env.RENTSOLUTIONS_MONITORING_ENABLED = 'false';
    assert.equal((await new RentsolutionsService(db,service).tick()).skipped, true);
    assert.equal(await db.source.count({where:{id}}), 0);
  } finally { if (old === undefined) delete process.env.RENTSOLUTIONS_MONITORING_ENABLED; else process.env.RENTSOLUTIONS_MONITORING_ENABLED = old; }
  ids.push(id);
  const parsed = parseSearch(readFileSync('test/fixtures/rentsolutions-search.html','utf8'));
  const run = (input:ListingInput[]) => runRentsolutions(db,service,{destination:'-123',collector:async()=>({...parsed,listings:input})});
  const due = () => db.source.update({where:{id},data:{nextCheckAt:new Date(0)}});
  const jobs = {listing:{sourceId:id}};
  assert.equal((await run(parsed.listings) as any).baseline, true);
  assert.equal(await db.notificationOutbox.count({where:jobs}),0);
  const profile = await db.siteProfile.findUniqueOrThrow({where:{sourceId:id}});
  assert.deepEqual(profile.searchUrls,[SEARCH_URL]); assert.equal(profile.authStrategy,'none');
  await due(); assert.equal((await run(parsed.listings) as any).created,0);
  const home:ListingInput = {...parsed.listings[0]!,externalId:'NEW1',canonicalUrl:'https://rent-solutions.nl/object/test-h90001/',availabilityStatus:'unknown'};
  await due(); await run([...parsed.listings,home]);
  assert.equal(await db.notificationOutbox.count({where:jobs}),0);
  await due(); await run([...parsed.listings,{...home,availabilityStatus:'available'}]);
  assert.equal(await db.notificationOutbox.count({where:jobs}),1);
  await due(); await run([...parsed.listings,{...home,availabilityStatus:'available'}]);
  assert.equal(await db.notificationOutbox.count({where:jobs}),1);
  await db.searchConfiguration.update({where:{sourceId:id},data:{filters:{...registry.defaults(id),minArea:100}}});
  await due(); await run([{...home,externalId:'NEW2',canonicalUrl:'https://rent-solutions.nl/object/test-h90002/',availabilityStatus:'available'}]);
  assert.equal(await db.notificationOutbox.count({where:jobs}),1);
  const before = await db.source.findUniqueOrThrow({where:{id}});
  await due(); await assert.rejects(runRentsolutions(db,service,{destination:'-123',collector:async()=>{throw new FundaError('INCOMPLETE_SEARCH')}}),/INCOMPLETE_SEARCH/);
  const after = await db.source.findUniqueOrThrow({where:{id}});
  assert.equal(after.status,'DEGRADED'); assert.deepEqual(after.baselineAt,before.baselineAt); assert.deepEqual(after.lastSuccessAt,before.lastSuccessAt);
  assert.equal(await db.notificationOutbox.count({where:jobs}),1);
});

test('Rentola has an independent baseline, strict availability, admin filters and transactional failure handling', async () => {
  const { runRentola } = await import('../../src/sources/rentola-runner');
  const { RentolaService } = await import('../../src/sources/rentola.service');
  const { parseSearch, SOURCE_ID: id, SEARCH_URL } = await import('../../src/sources/rentola-core');
  const { readFileSync } = await import('node:fs');
  const registry = requireFromRoot('./scripts/search-settings.cjs');
  const old = process.env.RENTOLA_MONITORING_ENABLED;
  try {
    process.env.RENTOLA_MONITORING_ENABLED = 'false';
    assert.equal((await new RentolaService(db,service).tick()).skipped, true);
    assert.equal(await db.source.count({where:{id}}), 0);
  } finally { if (old === undefined) delete process.env.RENTOLA_MONITORING_ENABLED; else process.env.RENTOLA_MONITORING_ENABLED = old; }
  ids.push(id);
  const data = parseSearch(readFileSync('test/fixtures/rentola-search.html','utf8'));
  const parsed = {listings:data.listings,inspected:data.ids.length,pages:1,available:data.listings.length};
  const run = (input:ListingInput[]) => runRentola(db,service,{destination:'-123',collector:async()=>({...parsed,listings:input})});
  const due = () => db.source.update({where:{id},data:{nextCheckAt:new Date(0)}});
  const jobs = {listing:{sourceId:id}};
  assert.equal((await run(parsed.listings) as any).baseline, true);
  assert.equal(await db.notificationOutbox.count({where:jobs}),0);
  const profile = await db.siteProfile.findUniqueOrThrow({where:{sourceId:id}});
  assert.deepEqual(profile.searchUrls,[SEARCH_URL]); assert.equal(profile.authStrategy,'none');
  await due(); assert.equal((await run(parsed.listings) as any).created,0);
  const home:ListingInput = {...parsed.listings[0]!,externalId:'NEW1',rentPrice:900,canonicalUrl:'https://rentola.nl/en/listings/test-p90001',availabilityStatus:'unknown'};
  await due(); await run([...parsed.listings,home]);
  assert.equal(await db.notificationOutbox.count({where:jobs}),0);
  await due(); await run([...parsed.listings,{...home,availabilityStatus:'available'}]);
  assert.equal(await db.notificationOutbox.count({where:jobs}),1);
  await due(); await run([...parsed.listings,{...home,availabilityStatus:'available'}]);
  assert.equal(await db.notificationOutbox.count({where:jobs}),1);
  await db.searchConfiguration.update({where:{sourceId:id},data:{filters:{...registry.defaults(id),minArea:100}}});
  await due(); await run([{...home,externalId:'NEW2',canonicalUrl:'https://rentola.nl/en/listings/test-p90002',availabilityStatus:'available'}]);
  assert.equal(await db.notificationOutbox.count({where:jobs}),1);
  const before = await db.source.findUniqueOrThrow({where:{id}});
  await due(); await assert.rejects(runRentola(db,service,{destination:'-123',collector:async()=>{throw new FundaError('INCOMPLETE_SEARCH')}}),/INCOMPLETE_SEARCH/);
  const after = await db.source.findUniqueOrThrow({where:{id}});
  assert.equal(after.status,'DEGRADED'); assert.deepEqual(after.baselineAt,before.baselineAt); assert.deepEqual(after.lastSuccessAt,before.lastSuccessAt);
  assert.equal(await db.notificationOutbox.count({where:jobs}),1);
});

test('Rentola lease covers its extended deadline, prevents overlap and rejects an expired worker',async()=>{
  const {runRentola}=await import('../../src/sources/rentola-runner');
  const {SOURCE_ID:id,RUN_TIMEOUT_MS}=await import('../../src/sources/rentola-core');
  await db.source.update({where:{id},data:{nextCheckAt:new Date(0)}});
  let release!:()=>void,entered!:()=>void;
  const waiting=new Promise<void>(resolve=>{release=resolve;});
  const started=new Promise<void>(resolve=>{entered=resolve;});
  const running=runRentola(db,service,{destination:'-123',collector:async()=>{
    entered();await waiting;
    return {listings:[],total:0,inspected:0,pages:0,available:0,searchOrder:'desc' as const,
      diagnostics:{phase:'details' as const,order:'desc' as const,pages:0,detailCandidates:0,detailsCompleted:0,elapsedMs:0}};
  }});
  await started;
  const claimed=await db.source.findUniqueOrThrow({where:{id}});
  const leaseMs=claimed.monitorLeaseUntil!.getTime()-claimed.lastAttemptAt!.getTime();
  assert.equal(leaseMs,300000);assert.equal(leaseMs-RUN_TIMEOUT_MS,60000);
  await db.source.update({where:{id},data:{nextCheckAt:new Date(0)}});
  assert.equal((await runRentola(db,service,{destination:'-123',collector:async()=>{throw Error('overlap');}})).skipped,true);
  const outboxBefore=await db.notificationOutbox.count({where:{listing:{sourceId:id}}});
  await db.source.update({where:{id},data:{monitorLeaseUntil:new Date(0)}});
  const rejected=assert.rejects(running,/LEASE_LOST/);release();await rejected;
  const after=await db.source.findUniqueOrThrow({where:{id}});
  assert.deepEqual(after.lastSuccessAt,claimed.lastSuccessAt);assert.deepEqual(after.baselineAt,claimed.baselineAt);
  assert.equal(await db.notificationOutbox.count({where:{listing:{sourceId:id}}}),outboxBefore);
});

test('Pararius has an independent baseline, strict availability, admin filters and transactional failure handling', async () => {
  const { runPararius } = requireFromRoot('./scripts/pararius-runner.cjs');
  const { ParariusService } = await import('../../src/sources/pararius.service');
  const { parseSearch, SOURCE_ID: id, SEARCH_URL } = requireFromRoot('./scripts/pararius-core.cjs');
  const { readFileSync } = await import('node:fs');
  const registry = requireFromRoot('./scripts/search-settings.cjs');
  const old = process.env.PARARIUS_BROWSER_ORIGIN;
  const oldToken = process.env.PARARIUS_BROWSER_TOKEN;
  try {
    delete process.env.PARARIUS_BROWSER_ORIGIN; delete process.env.PARARIUS_BROWSER_TOKEN;
    assert.equal((await new ParariusService(db,service).tick()).skipped, true);
    assert.equal(await db.source.count({where:{id}}), 0);
  } finally { if (old === undefined) delete process.env.PARARIUS_BROWSER_ORIGIN; else process.env.PARARIUS_BROWSER_ORIGIN = old;
    if(oldToken===undefined) delete process.env.PARARIUS_BROWSER_TOKEN; else process.env.PARARIUS_BROWSER_TOKEN=oldToken; }
  ids.push(id);
  const data = parseSearch(readFileSync('test/fixtures/pararius-last.html','utf8'),SEARCH_URL+'/page-4');
  const parsed = {listings:data.listings.filter(requireFromRoot('./scripts/pararius-core.cjs').candidate),total:data.total,inspected:data.total,pages:4,available:data.listings.length};
  const run = (input:ListingInput[]) => runPararius(db,service,{destination:'-123',collector:async()=>({...parsed,listings:input})});
  const due = () => db.source.update({where:{id},data:{nextCheckAt:new Date(0)}});
  const jobs = {listing:{sourceId:id}};
  assert.equal((await run(parsed.listings) as any).baseline, true);
  assert.equal(await db.notificationOutbox.count({where:jobs}),0);
  const profile = await db.siteProfile.findUniqueOrThrow({where:{sourceId:id}});
  assert.deepEqual(profile.searchUrls,[SEARCH_URL]); assert.equal(profile.authStrategy,'browser-session');
  await due(); assert.equal((await run(parsed.listings) as any).created,0);
  const home:ListingInput = {...parsed.listings[0]!,pricingDetails:{baseRent:true,totalRentPrice:1000},externalId:'NEW1',rentPrice:900,canonicalUrl:'https://www.pararius.nl/appartement-te-huur/groningen/00090001/test',availabilityStatus:'unknown'};
  await due(); await run([...parsed.listings,home]);
  assert.equal(await db.notificationOutbox.count({where:jobs}),0);
  await due(); await run([...parsed.listings,{...home,availabilityStatus:'available'}]);
  assert.equal(await db.notificationOutbox.count({where:jobs}),1);
  const sent=await db.notificationOutbox.findFirstOrThrow({where:jobs});
  assert.match(sent.payload,/Базовая аренда: €900/); assert.match(sent.payload,/Полная стоимость по данным сайта: €1000/);
  const stored=await db.housingListing.findFirstOrThrow({where:{sourceId:id,externalId:'NEW1'}});
  assert.equal(JSON.parse(stored.rawSourceRef!).totalRentPrice,1000);
  await due(); await run([...parsed.listings,{...home,availabilityStatus:'available'}]);
  assert.equal(await db.notificationOutbox.count({where:jobs}),1);
  await db.searchConfiguration.update({where:{sourceId:id},data:{filters:{...registry.defaults(id),minArea:100}}});
  await due(); await run([{...home,externalId:'NEW2',canonicalUrl:'https://www.pararius.nl/appartement-te-huur/groningen/00090002/test',availabilityStatus:'available'}]);
  assert.equal(await db.notificationOutbox.count({where:jobs}),1);
  const before = await db.source.findUniqueOrThrow({where:{id}});
  await due(); await assert.rejects(runPararius(db,service,{destination:'-123',collector:async()=>{throw new FundaError('INCOMPLETE_SEARCH')}}),/INCOMPLETE_SEARCH/);
  const after = await db.source.findUniqueOrThrow({where:{id}});
  assert.equal(after.status,'DEGRADED'); assert.deepEqual(after.baselineAt,before.baselineAt); assert.deepEqual(after.lastSuccessAt,before.lastSuccessAt);
  assert.equal(await db.notificationOutbox.count({where:jobs}),1);
});

test('Pararius recovery deduplicates alerts and resumes after a validated collection', async () => {
  const { SOURCE_ID: PARARIUS_SOURCE_ID } = requireFromRoot('./scripts/pararius-core.cjs');
  const { ParariusService } = await import('../../src/sources/pararius.service');
  process.env.PARARIUS_BROWSER_ORIGIN = 'https://pararius-browser-session-production.up.railway.app';
  process.env.PARARIUS_BROWSER_TOKEN = 'x'.repeat(43);
  const original = globalThis.fetch; let recovered = false, collections = 0;
  globalThis.fetch = async (input, options) => {
    const path = new URL(String(input)).pathname;
    if (path === '/worker/state') return Response.json({humanCheck:!recovered,accessDenied:false,recovered,listingLinks:0,searchReady:recovered});
    if (path === '/worker/recovery') return Response.json({id:'b'.repeat(32),url:process.env.PARARIUS_BROWSER_ORIGIN+'/#key='+'y'.repeat(43)});
    collections++;
    return recovered ? Response.json({listings:[{externalId:'recovered',canonicalUrl:'https://www.pararius.nl/huis-te-huur/groningen/00099999/recovered',title:'Huis',city:'Groningen',rentPrice:900,availabilityStatus:'available'}],inspected:1,settingsFingerprint:requireFromRoot('./scripts/search-settings.cjs').fingerprint(JSON.parse(String(options!.body)).settings)}) : Response.json({category:'HUMAN_CHECK',blocked:true},{status:422});
  };
  try {
    const monitor = new ParariusService(db,service);
    const before = await db.source.findUniqueOrThrow({where:{id:PARARIUS_SOURCE_ID}});
    await db.source.update({where:{id:PARARIUS_SOURCE_ID},data:{nextCheckAt:new Date(0)}});
    await assert.rejects(monitor.tick(),/HUMAN_CHECK/);
    const blocked = await db.source.findUniqueOrThrow({where:{id:PARARIUS_SOURCE_ID}});
    assert.equal(blocked.status,'BLOCKED');assert.deepEqual(blocked.lastSuccessAt,before.lastSuccessAt);
    await monitor.tick();await monitor.tick();assert.equal(collections,1);
    assert.equal(await db.notificationOutbox.count({where:{idempotencyKey:'pararius-recovery:'+'b'.repeat(32)}}),1);
    recovered=true;assert.equal((await monitor.tick()).skipped,false);
    assert.equal((await db.source.findUniqueOrThrow({where:{id:PARARIUS_SOURCE_ID}})).status,'HEALTHY');
    assert.equal(collections,2);
  } finally {
    globalThis.fetch=original;delete process.env.PARARIUS_BROWSER_ORIGIN;delete process.env.PARARIUS_BROWSER_TOKEN;
    await db.notificationOutbox.deleteMany({where:{idempotencyKey:'pararius-recovery:'+'b'.repeat(32)}});
  }
});

test('Wonen123 has an independent baseline, strict availability, admin filters and transactional failure handling', async () => {
  const { runWonen123 } = await import('../../src/sources/wonen123-runner');
  const { Wonen123Service } = await import('../../src/sources/wonen123.service');
  const { parseSearch, SOURCE_ID: id, SEARCH_URL } = await import('../../src/sources/wonen123-core');
  const { readFileSync } = await import('node:fs');
  const registry = requireFromRoot('./scripts/search-settings.cjs');
  const old = process.env.WONEN123_MONITORING_ENABLED;
  try {
    process.env.WONEN123_MONITORING_ENABLED = 'false';
    assert.equal((await new Wonen123Service(db,service).tick()).skipped, true);
    assert.equal(await db.source.count({where:{id}}), 0);
  } finally { if (old === undefined) delete process.env.WONEN123_MONITORING_ENABLED; else process.env.WONEN123_MONITORING_ENABLED = old; }
  ids.push(id);
  const data = parseSearch(readFileSync('test/fixtures/wonen123-search.html','utf8'));
  const parsed = {...data, total: data.listings.length, inspected: data.listings.length, listings: data.listings.filter(x => registry.matches(registry.defaults(id),x,id)).map(({propertyType, ...item}) => item)};
  const run = (input:ListingInput[]) => runWonen123(db,service,{destination:'-123',collector:async()=>({...parsed,listings:input})});
  const due = () => db.source.update({where:{id},data:{nextCheckAt:new Date(0)}});
  const jobs = {listing:{sourceId:id}};
  assert.equal((await run(parsed.listings) as any).baseline, true);
  assert.equal(await db.notificationOutbox.count({where:jobs}),0);
  const profile = await db.siteProfile.findUniqueOrThrow({where:{sourceId:id}});
  assert.deepEqual(profile.searchUrls,[SEARCH_URL]); assert.equal(profile.authStrategy,'none');
  await due(); assert.equal((await run(parsed.listings) as any).created,0);
  const home:ListingInput = {...parsed.listings[0]!,externalId:'NEW1',canonicalUrl:'https://www.123wonen.nl/huur/groningen/appartement/test-90001-2',availabilityStatus:'unknown'};
  await due(); await run([...parsed.listings,home]);
  assert.equal(await db.notificationOutbox.count({where:jobs}),0);
  await due(); await run([...parsed.listings,{...home,availabilityStatus:'available'}]);
  assert.equal(await db.notificationOutbox.count({where:jobs}),1);
  await due(); await run([...parsed.listings,{...home,availabilityStatus:'available'}]);
  assert.equal(await db.notificationOutbox.count({where:jobs}),1);
  await db.searchConfiguration.update({where:{sourceId:id},data:{filters:{...registry.defaults(id),minArea:100}}});
  await due(); await run([{...home,externalId:'NEW2',canonicalUrl:'https://www.123wonen.nl/huur/groningen/appartement/test-90002-2',availabilityStatus:'available'}]);
  assert.equal(await db.notificationOutbox.count({where:jobs}),1);
  const before = await db.source.findUniqueOrThrow({where:{id}});
  await due(); await assert.rejects(runWonen123(db,service,{destination:'-123',collector:async()=>{throw new FundaError('INCOMPLETE_SEARCH')}}),/INCOMPLETE_SEARCH/);
  const after = await db.source.findUniqueOrThrow({where:{id}});
  assert.equal(after.status,'DEGRADED'); assert.deepEqual(after.baselineAt,before.baselineAt); assert.deepEqual(after.lastSuccessAt,before.lastSuccessAt);
  assert.equal(await db.notificationOutbox.count({where:jobs}),1);
});

test('Rotsvast has an independent baseline, strict availability, admin filters and transactional failure handling', async () => {
  const { runRotsvast } = await import('../../src/sources/rotsvast-runner');
  const { RotsvastService } = await import('../../src/sources/rotsvast.service');
  const { parseSearch, SOURCE_ID: id, SEARCH_URL } = await import('../../src/sources/rotsvast-core');
  const { readFileSync } = await import('node:fs');
  const registry = requireFromRoot('./scripts/search-settings.cjs');
  const old = process.env.ROTSVAST_MONITORING_ENABLED;
  try {
    process.env.ROTSVAST_MONITORING_ENABLED = 'false';
    assert.equal((await new RotsvastService(db,service).tick()).skipped, true);
    assert.equal(await db.source.count({where:{id}}), 0);
    const { AdminService } = await import('../../src/admin/admin.service');
    const overview = await new AdminService(db).overview();
    assert.equal(overview.sources.find(x => x.module.id === id)?.runtimeEnabled, false);
  } finally { if (old === undefined) delete process.env.ROTSVAST_MONITORING_ENABLED; else process.env.ROTSVAST_MONITORING_ENABLED = old; }
  ids.push(id);
  const data = parseSearch(readFileSync('test/fixtures/rotsvast-search.html','utf8'));
  const parsed = {...data, total: data.listings.length, inspected: data.listings.length, listings: data.listings.filter(x => registry.matches(registry.defaults(id),x,id)).map(item => item)};
  const run = (input:ListingInput[]) => runRotsvast(db,service,{destination:'-123',collector:async()=>({...parsed,listings:input})});
  const due = () => db.source.update({where:{id},data:{nextCheckAt:new Date(0)}});
  const jobs = {listing:{sourceId:id}};
  assert.equal((await run(parsed.listings) as any).baseline, true);
  assert.equal(await db.notificationOutbox.count({where:jobs}),0);
  const profile = await db.siteProfile.findUniqueOrThrow({where:{sourceId:id}});
  assert.deepEqual(profile.searchUrls,[SEARCH_URL]); assert.equal(profile.authStrategy,'none');
  await due(); assert.equal((await run(parsed.listings) as any).created,0);
  const home:ListingInput = {...parsed.listings[0]!,externalId:'NEW1',canonicalUrl:'https://www.rotsvast.nl/huren/test-groningen-h900001/',availabilityStatus:'unknown'};
  await due(); await run([...parsed.listings,home]);
  assert.equal(await db.notificationOutbox.count({where:jobs}),0);
  await due(); await run([...parsed.listings,{...home,availabilityStatus:'available'}]);
  assert.equal(await db.notificationOutbox.count({where:jobs}),1);
  await due(); await run([...parsed.listings,{...home,availabilityStatus:'available'}]);
  assert.equal(await db.notificationOutbox.count({where:jobs}),1);
  await db.searchConfiguration.update({where:{sourceId:id},data:{filters:{...registry.defaults(id),minArea:100}}});
  await due(); await run([{...home,externalId:'NEW2',canonicalUrl:'https://www.rotsvast.nl/huren/test-groningen-h900002/',availabilityStatus:'available'}]);
  assert.equal(await db.notificationOutbox.count({where:jobs}),1);
  const before = await db.source.findUniqueOrThrow({where:{id}});
  await due(); await assert.rejects(runRotsvast(db,service,{destination:'-123',collector:async()=>{throw new FundaError('INCOMPLETE_SEARCH')}}),/INCOMPLETE_SEARCH/);
  const after = await db.source.findUniqueOrThrow({where:{id}});
  assert.equal(after.status,'DEGRADED'); assert.deepEqual(after.baselineAt,before.baselineAt); assert.deepEqual(after.lastSuccessAt,before.lastSuccessAt);
  assert.equal(await db.notificationOutbox.count({where:jobs}),1);
});

test('Rentbilly has an independent baseline, strict availability, admin filters and transactional failure handling', async () => {
  const { runRentbilly } = await import('../../src/sources/rentbilly-runner');
  const { RentbillyService } = await import('../../src/sources/rentbilly.service');
  const { parseSearch, SOURCE_ID: id, SEARCH_URL } = await import('../../src/sources/rentbilly-core');
  const { readFileSync } = await import('node:fs');
  const registry = requireFromRoot('./scripts/search-settings.cjs');
  const old = process.env.RENTBILLY_MONITORING_ENABLED;
  try {
    process.env.RENTBILLY_MONITORING_ENABLED = 'false';
    assert.equal((await new RentbillyService(db,service).tick()).skipped, true);
    assert.equal(await db.source.count({where:{id}}), 0);
    const { AdminService } = await import('../../src/admin/admin.service');
    const overview = await new AdminService(db).overview();
    assert.equal(overview.sources.find(x => x.module.id === id)?.runtimeEnabled, false);
  } finally { if (old === undefined) delete process.env.RENTBILLY_MONITORING_ENABLED; else process.env.RENTBILLY_MONITORING_ENABLED = old; }
  ids.push(id);
  const {ld,...flight} = JSON.parse(readFileSync('test/fixtures/rentbilly-page1.json','utf8'));
  const data = parseSearch(`<script type="application/ld+json">${JSON.stringify(ld)}</script><script>self.__next_f.push(${JSON.stringify([1,JSON.stringify(flight)])})</script>`);
  const parsed = {...data, pages:data.totalPages, available:0, total: data.listings.length, inspected: data.listings.length, listings: data.listings.filter(x => registry.matches(registry.defaults(id),x,id)).map(item => ({...item,availabilityStatus:'unavailable' as const}))};
  const run = (input:ListingInput[]) => runRentbilly(db,service,{destination:'-123',collector:async()=>({...parsed,listings:input})});
  const due = () => db.source.update({where:{id},data:{nextCheckAt:new Date(0)}});
  const jobs = {listing:{sourceId:id}};
  assert.equal((await run(parsed.listings) as any).baseline, true);
  assert.equal(await db.notificationOutbox.count({where:jobs}),0);
  const profile = await db.siteProfile.findUniqueOrThrow({where:{sourceId:id}});
  assert.deepEqual(profile.searchUrls,[SEARCH_URL]); assert.equal(profile.authStrategy,'none');
  await due(); assert.equal((await run(parsed.listings) as any).created,0);
  const home:ListingInput = {...parsed.listings[0]!,externalId:'NEW1',canonicalUrl:'https://rentbilly.nl/en/listings/test-p900001',availabilityStatus:'unknown'};
  await due(); await run([...parsed.listings,home]);
  assert.equal(await db.notificationOutbox.count({where:jobs}),0);
  await due(); await run([...parsed.listings,{...home,availabilityStatus:'available'}]);
  assert.equal(await db.notificationOutbox.count({where:jobs}),1);
  await due(); await run([...parsed.listings,{...home,availabilityStatus:'available'}]);
  assert.equal(await db.notificationOutbox.count({where:jobs}),1);
  await db.searchConfiguration.update({where:{sourceId:id},data:{filters:{...registry.defaults(id),minArea:100}}});
  await due(); await run([{...home,externalId:'NEW2',canonicalUrl:'https://rentbilly.nl/en/listings/test-p900002',availabilityStatus:'available'}]);
  assert.equal(await db.notificationOutbox.count({where:jobs}),1);
  const before = await db.source.findUniqueOrThrow({where:{id}});
  await due(); await assert.rejects(runRentbilly(db,service,{destination:'-123',collector:async()=>{throw new FundaError('INCOMPLETE_SEARCH')}}),/INCOMPLETE_SEARCH/);
  const after = await db.source.findUniqueOrThrow({where:{id}});
  assert.equal(after.status,'DEGRADED'); assert.deepEqual(after.baselineAt,before.baselineAt); assert.deepEqual(after.lastSuccessAt,before.lastSuccessAt);
  assert.equal(await db.notificationOutbox.count({where:jobs}),1);
});

test('Gohome has an independent baseline, strict availability, admin filters and transactional failure handling', async () => {
  const { runGohome } = await import('../../src/sources/gohome-runner');
  const { GohomeService } = await import('../../src/sources/gohome.service');
  const { parseDetail, SOURCE_ID: id, SEARCH_URL } = await import('../../src/sources/gohome-core');
  const { readFileSync } = await import('node:fs');
  const registry = requireFromRoot('./scripts/search-settings.cjs');
  const old = process.env.GOHOME_MONITORING_ENABLED;
  try {
    process.env.GOHOME_MONITORING_ENABLED = 'false';
    assert.equal((await new GohomeService(db,service).tick()).skipped, true);
    assert.equal(await db.source.count({where:{id}}), 0);
    const { AdminService } = await import('../../src/admin/admin.service');
    const overview = await new AdminService(db).overview();
    assert.equal(overview.sources.find(x => x.module.id === id)?.runtimeEnabled, false);
  } finally { if (old === undefined) delete process.env.GOHOME_MONITORING_ENABLED; else process.env.GOHOME_MONITORING_ENABLED = old; }
  ids.push(id);
  const card = JSON.parse(readFileSync('test/fixtures/gohome-page1.json','utf8')).properties[0];
  const homeDetail = JSON.parse(readFileSync('test/fixtures/gohome-detail.json','utf8'));
  const parsed = {pages:1, available:0, total:1, inspected:1, listings:[{...parseDetail(homeDetail,card)!,availabilityStatus:'unavailable' as const}]};
  const run = (input:ListingInput[]) => runGohome(db,service,{destination:'-123',collector:async()=>({...parsed,listings:input})});
  const due = () => db.source.update({where:{id},data:{nextCheckAt:new Date(0)}});
  const jobs = {listing:{sourceId:id}};
  assert.equal((await run(parsed.listings) as any).baseline, true);
  assert.equal(await db.notificationOutbox.count({where:jobs}),0);
  const profile = await db.siteProfile.findUniqueOrThrow({where:{sourceId:id}});
  assert.deepEqual(profile.searchUrls,[SEARCH_URL]); assert.equal(profile.authStrategy,'none');
  await due(); assert.equal((await run(parsed.listings) as any).created,0);
  const home:ListingInput = {...parsed.listings[0]!,externalId:'NEW1',canonicalUrl:'https://resident.gohome.io/te-huur/test-900001',availabilityStatus:'unknown'};
  await due(); await run([...parsed.listings,home]);
  assert.equal(await db.notificationOutbox.count({where:jobs}),0);
  await due(); await run([...parsed.listings,{...home,availabilityStatus:'available'}]);
  assert.equal(await db.notificationOutbox.count({where:jobs}),1);
  await due(); await run([...parsed.listings,{...home,availabilityStatus:'available'}]);
  assert.equal(await db.notificationOutbox.count({where:jobs}),1);
  await db.searchConfiguration.update({where:{sourceId:id},data:{filters:{...registry.defaults(id),minArea:101}}});
  await due(); await run([{...home,externalId:'NEW2',canonicalUrl:'https://resident.gohome.io/te-huur/test-900002',availabilityStatus:'available'}]);
  assert.equal(await db.notificationOutbox.count({where:jobs}),1);
  // Price filtering is enforced before notifications, even with a custom collector.
  await db.searchConfiguration.update({where:{sourceId:id},data:{filters:{...registry.defaults(id),maxRent:1000}}});
  await due(); await run([{...home,externalId:'EXPENSIVE',canonicalUrl:'https://resident.gohome.io/te-huur/expensive',availabilityStatus:'available'}]);
  assert.equal(await db.notificationOutbox.count({where:jobs}),1);
  await db.searchConfiguration.update({where:{sourceId:id},data:{enabled:false}});
  await due(); assert.equal((await runGohome(db,service,{destination:'-123',collector:async()=>{throw Error('must not collect')}})).skipped,true);
  await db.searchConfiguration.update({where:{sourceId:id},data:{enabled:true}});
  const before = await db.source.findUniqueOrThrow({where:{id}});
  await due(); await assert.rejects(runGohome(db,service,{destination:'-123',collector:async()=>{throw new FundaError('INCOMPLETE_SEARCH')}}),/INCOMPLETE_SEARCH/);
  const after = await db.source.findUniqueOrThrow({where:{id}});
  assert.equal(after.status,'DEGRADED'); assert.deepEqual(after.baselineAt,before.baselineAt); assert.deepEqual(after.lastSuccessAt,before.lastSuccessAt);
  assert.equal(await db.notificationOutbox.count({where:jobs}),1);
});
