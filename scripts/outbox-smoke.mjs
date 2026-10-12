// Runs beside the deployed application; only its existing worker sends the message.
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

export async function smoke(db, listings, destination, runId, wait = delay) {
  assert.match(runId, /^[a-z0-9][a-z0-9-]{7,63}$/);
  const sourceId = `outbox-smoke:${runId}`;
  const source = await db.source.upsert({ where: { id: sourceId }, update: {}, create: {
    id: sourceId, name: 'Production outbox smoke test', baseUrl: 'https://example.invalid',
    allowedDomains: ['example.invalid'], status: 'DISABLED',
  } });
  const scope = { listing: { sourceId } };
  if (!source.baselineAt) {
    await listings.recordValidatedRun(sourceId, [], destination);
    assert.equal(await db.notificationOutbox.count({ where: scope }), 0, 'Baseline queued a notification');
  }
  const item = { externalId: runId, canonicalUrl: `https://example.invalid/outbox-smoke/${runId}`,
    title: `[ТЕСТ] Проверка production-outbox — ${runId}`, city: 'Groningen (тест, не объявление)' };
  await listings.recordValidatedRun(sourceId, [item], destination);
  await listings.recordValidatedRun(sourceId, [item], destination);
  assert.equal(await db.notificationOutbox.count({ where: scope }), 1, 'Duplicate outbox rows');
  const read = () => db.notificationOutbox.findFirstOrThrow({ where: scope,
    select: { id: true, status: true, attempts: true, telegramMessageId: true, sentAt: true, lastErrorCategory: true, destinationRef: true } });
  let job;
  for (let attempt = 0; attempt < 45; attempt++) {
    job = await read();
    assert.equal(job.destinationRef, destination, 'Smoke run belongs to another destination');
    if (['SENT', 'UNCERTAIN', 'DEAD_LETTER'].includes(job.status)) break;
    await wait(1000);
  }
  // Do not reset failures or leases: an ambiguous send needs manual inspection.
  assert.equal(job.status, 'SENT', `Delivery ended in ${job.status}; inspect outbox before any retry`);
  assert.match(job.telegramMessageId ?? '', /^[1-9]\d*$/);
  assert.ok(job.sentAt);
  await listings.recordValidatedRun(sourceId, [item], destination);
  await wait(5000);
  assert.equal(await db.notificationOutbox.count({ where: scope }), 1);
  assert.deepEqual(await read(), job, 'Delivery changed after repeated recording');
  const { destinationRef: _destination, ...safeJob } = job;
  return { runId, sourceId, ...safeJob, baselineVerified: !source.baselineAt, deduplicationVerified: true };
}

async function main() {
  const [runId, confirmation, ...extra] = process.argv.slice(2);
  assert.ok(runId && /^[a-z0-9][a-z0-9-]{7,63}$/.test(runId)
    && confirmation === '--send-test-message' && extra.length === 0,
  'Usage: outbox-smoke.mjs <stable-run-id> --send-test-message');
  const require = createRequire(`${process.cwd()}/package.json`);
  const { parseEnvironment } = require('./dist/config/environment.js');
  const config = parseEnvironment(process.env);
  assert.ok(config.TELEGRAM_DELIVERY_ENABLED, 'Production delivery worker is disabled');
  const { PrismaService } = require('./dist/database/prisma.service.js');
  const { ListingsService } = require('./dist/listings/listings.service.js');
  const db = new PrismaService();
  try {
    await db.$connect();
    console.log(JSON.stringify(await smoke(db, new ListingsService(db), config.TELEGRAM_CHAT_ID, runId), null, 2));
  } finally { await db.$disconnect(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    // Raw database/transport errors may contain secrets. Inspect rows with outbox:admin.
    console.error('Outbox smoke check failed; check configuration and retained outbox state. Do not retry with a new run ID.');
    process.exitCode = 1;
  });
}
