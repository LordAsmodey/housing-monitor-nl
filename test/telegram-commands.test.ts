import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatSourceList, isListCommand, TelegramUpdatesClient } from '../src/delivery/telegram-commands';
import { parseEnvironment } from '../src/config/environment';

const now = Date.now();
const update = (text = '/list', chat = { id: -123, type: 'supergroup' }) => ({
  update_id: 10, message: { text, chat, date: Math.floor(now / 1000),
    entities: [{ type: 'bot_command', offset: 0, length: text.trimEnd().length }] },
});

test('list accepts only fresh commands in the configured group addressed to this bot', () => {
  for (const text of ['/list', '/list  ', '/list@Housing_Bot', '/list@HOUSING_BOT']) {
    assert.ok(isListCommand(update(text), '-123', 'Housing_Bot', now));
  }
  for (const text of ['/listing', '/list arg', '/list@other_bot', ' /list', 'hello /list']) {
    assert.equal(isListCommand(update(text), '-123', 'Housing_Bot', now), false);
  }
  for (const value of [null, {}, { edited_message: update().message }, update('/list', { id: -456, type: 'group' }),
    update('/list', { id: -123, type: 'private' }),
    { ...update(), message: { ...update().message, date: Math.floor(now / 1000) - 301 } },
    { ...update(), message: { ...update().message, entities: [] } }]) {
    assert.equal(isListCommand(value, '-123', 'Housing_Bot', now), false);
  }
});

type Overview = Parameters<typeof formatSourceList>[0];
function source(status = 'HEALTHY', extra = {}) {
  return { module: { name: 'Funda' }, ready: true, runtimeEnabled: true, runtimeAvailable: true,
    settings: { enabled: true }, health: { status, running: false, lastSuccessAt: new Date('2026-10-22T12:00:00Z') }, ...extra };
}
const format = (sources: unknown[]) => formatSourceList({ sources } as Overview).join('\n');

test('source list distinguishes runtime configuration, pause, health, running and uninitialized sources', () => {
  assert.match(format([source()]), /Funda — 🟢 Работает\nПоследний успех: 2026-10-22 12:00 UTC/);
  assert.match(format([source('HEALTHY', { runtimeEnabled: false })]), /Отключён в конфигурации/);
  assert.match(format([source('HEALTHY', { runtimeAvailable: false })]), /Не настроено подключение/);
  assert.match(format([source('BLOCKED', { settings: { enabled: false } })]), /Приостановлен/);
  assert.match(format([source('BLOCKED')]), /Заблокирован/);
  assert.match(format([source('DEGRADED')]), /Требует внимания/);
  assert.match(format([source('HEALTHY', { health: { status: 'HEALTHY', running: true } })]), /Проверяется/);
  assert.match(format([source('HEALTHY', { ready: false, health: null })]), /Ожидает запуска/);
  assert.match(format([source('HEALTHY', { health: { status: 'HEALTHY', lastSuccessAt: null } })]), /Ещё нет успешных проверок/);
  assert.match(format([]), /Подключённых источников пока нет/);
  assert.ok(formatSourceList({ sources: Array.from({ length: 200 }, () => source()) } as Overview).every(x => x.length <= 4096));
});

test('polling transport strips tokens and API response details and preserves retry_after', async () => {
  const client = new TelegramUpdatesClient('123:private', async () => { throw Error('https://api.telegram.org/bot123:private'); });
  await assert.rejects(client.call('getMe'), error => {
    assert.doesNotMatch(String((error as Error).stack), /123:private/);
    return true;
  });
  const rateLimited = new TelegramUpdatesClient('123:private', async () => new Response(JSON.stringify({ ok: false, parameters: { retry_after: 120 } }), { status: 429 }));
  await assert.rejects(rateLimited.call('getUpdates'), { retryAfter: 120 });
});

test('command polling defaults on, can be disabled and rejects invalid values', () => {
  const env = { DATABASE_URL: 'postgresql://localhost/test', REDIS_URL: 'redis://localhost', TELEGRAM_CHAT_ID: '-123' };
  assert.equal(parseEnvironment(env).TELEGRAM_COMMANDS_ENABLED, true);
  assert.equal(parseEnvironment({ ...env, TELEGRAM_COMMANDS_ENABLED: 'false' }).TELEGRAM_COMMANDS_ENABLED, false);
  assert.throws(() => parseEnvironment({ ...env, TELEGRAM_COMMANDS_ENABLED: 'yes' }), /TELEGRAM_COMMANDS_ENABLED/);
});
