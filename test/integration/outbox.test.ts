import 'reflect-metadata';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaService } from '../../src/database/prisma.service';
import { ListingsService } from '../../src/listings/listings.service';
import { OutboxService } from '../../src/delivery/outbox.service';
import { DeliveryError } from '../../src/delivery/telegram';

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
