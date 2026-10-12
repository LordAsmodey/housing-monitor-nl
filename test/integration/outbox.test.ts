import 'reflect-metadata';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaService } from '../../src/database/prisma.service';
import { ListingsService } from '../../src/listings/listings.service';
import { OutboxService } from '../../src/delivery/outbox.service';
import { DeliveryError } from '../../src/delivery/telegram';
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
    return recovered?Response.json({listings:[],inspected:1}):Response.json({category:'HUMAN_CHECK',blocked:true},{status:422});
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

test('Huurwoningen has its own baseline, lease, filters and transactional notification deduplication', async () => {
  ids.push(HUUR_SOURCE_ID);
  const first = { ...item('83108c92'), canonicalUrl: 'https://www.huurwoningen.com/huren/groningen/83108c92/eeldersingel/' };
  const second = { ...item('abcdef12'), canonicalUrl: 'https://www.huurwoningen.com/huren/groningen/abcdef12/andere-straat/' };
  const run = (input: any[]) => runHuurwoningen(db, service, { destination: '-123', collector: async () => ({ listings: input, inspected: input.length }) });
  const baseline = await run([first]); assert.equal(baseline.baseline, true);
  assert.equal(await db.notificationOutbox.count({ where: { listing: { sourceId: HUUR_SOURCE_ID } } }), 0);
  const profile = await db.siteProfile.findUniqueOrThrow({ where: { sourceId: HUUR_SOURCE_ID } });
  assert.deepEqual(profile.searchUrls, [HUUR_SEARCH_URL]);
  assert.deepEqual(profile.filters, {city:'Groningen',radiusKm:25,maxRent:1500,since:'1',availableFrom:'within_3_months',excludedOfferTypes:['homeswap'],filtering:'huurwoningen-search'});
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
    return recovered ? Response.json({listings:[],inspected:0}) : Response.json({category:'HUMAN_CHECK',blocked:true},{status:422});
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

