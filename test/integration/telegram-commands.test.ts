import 'reflect-metadata';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { PrismaService } from '../../src/database/prisma.service';
import { AdminService } from '../../src/admin/admin.service';
import { TelegramCommandsService } from '../../src/delivery/telegram-commands.service';
import { Prisma } from '@prisma/client';

assert.ok(process.env.DATABASE_URL, 'Supply a disposable DATABASE_URL; never load .env');
Object.assign(process.env, { REDIS_URL: 'redis://localhost', TELEGRAM_CHAT_ID: '-123',
  TELEGRAM_BOT_TOKEN: '123:mock', TELEGRAM_DELIVERY_ENABLED: 'true', TELEGRAM_COMMANDS_ENABLED: 'true' });
const db = new PrismaService();
const bot = { id: 777001, username: 'Housing_Bot', is_bot: true };
const command = (id: number) => ({ update_id: id, message: { date: Math.floor(Date.now() / 1000), text: '/list',
  chat: { id: -123, type: 'supergroup' }, entities: [{ type: 'bot_command', offset: 0, length: 5 }] } });
type Call = (method: string, parameters?: Record<string, unknown>) => Promise<unknown>;
function service(call: Call, admin = new AdminService(db)) {
  const s = new TelegramCommandsService(db, admin);
  (s as unknown as { client: { call: Call } }).client = { call };
  return s;
}
after(async () => {
  await db.notificationOutbox.deleteMany({ where: { idempotencyKey: { startsWith: `command:${bot.id}:` } } });
  await db.telegramUpdateCursor.deleteMany({ where: { id: String(bot.id) } });
  await db.$disconnect();
});

test('cursor and replies survive restart, discard unrelated updates and rollback together on failure', async () => {
  await db.telegramUpdateCursor.deleteMany({ where: { id: String(bot.id) } });
  const offsets: unknown[] = [];
  const call: Call = async (method, params) => {
    if (method === 'getMe') return bot;
    offsets.push(params?.offset);
    return [command(101), { update_id: 102, message: { ...command(102).message, chat: { id: -999, type: 'group' } } }];
  };
  await service(call).tick();
  const key = `command:${bot.id}:101:0`;
  const reply = await db.notificationOutbox.findUniqueOrThrow({ where: { idempotencyKey: key } });
  assert.equal(reply.destinationRef, '-123');
  assert.match(reply.payload, /Источники объявлений/);
  assert.equal(reply.listingId, null);
  assert.equal((await db.telegramUpdateCursor.findUniqueOrThrow({ where: { id: String(bot.id) } })).offset, 103);
  await service(call).tick();
  assert.deepEqual(offsets, [0, 103]);
  assert.equal(await db.notificationOutbox.count({ where: { idempotencyKey: { startsWith: `command:${bot.id}:` } } }), 1);

  const failing = new AdminService(db);
  failing.overview = async () => { throw Error('database unavailable'); };
  await assert.rejects(service(async method => method === 'getMe' ? bot : [command(103)], failing).tick());
  assert.equal((await db.telegramUpdateCursor.findUniqueOrThrow({ where: { id: String(bot.id) } })).offset, 103);
  assert.equal(await db.notificationOutbox.count({ where: { idempotencyKey: `command:${bot.id}:103:0` } }), 0);
  await service(async method => method === 'getMe' ? bot : [command(103)]).tick();
  assert.equal(await db.notificationOutbox.count({ where: { idempotencyKey: `command:${bot.id}:103:0` } }), 1);

  // Fail after the reply insert, before the cursor write: neither may commit.
  const failingDb = {
    $transaction: (work: (tx: Prisma.TransactionClient) => Promise<void>) => db.$transaction(async tx => {
      const proxy = new Proxy(tx, { get(target, property) {
        if (property === 'telegramUpdateCursor') return {
          upsert: target.telegramUpdateCursor.upsert.bind(target.telegramUpdateCursor),
          update: async () => { throw Error('cursor write failed'); },
        };
        return Reflect.get(target, property);
      } });
      return work(proxy);
    }),
  } as unknown as PrismaService;
  const interrupted = new TelegramCommandsService(failingDb, new AdminService(db));
  (interrupted as unknown as { client: { call: Call } }).client = {
    call: async method => method === 'getMe' ? bot : [command(104)],
  };
  await assert.rejects(interrupted.tick(), /cursor write failed/);
  assert.equal((await db.telegramUpdateCursor.findUniqueOrThrow({ where: { id: String(bot.id) } })).offset, 104);
  assert.equal(await db.notificationOutbox.count({ where: { idempotencyKey: `command:${bot.id}:104:0` } }), 0);
});

test('replicas do not call getUpdates concurrently', async () => {
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const first = service(async method => {
    if (method === 'getMe') return bot;
    entered(); await gate; return [];
  }).tick();
  await started;
  let polls = 0;
  try {
    await service(async method => {
      if (method === 'getMe') return bot;
      polls++; return [];
    }).tick();
    assert.equal(polls, 0);
  } finally { release(); await first; }
});
