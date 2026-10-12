import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TelegramSender, DeliveryError } from '../src/delivery/telegram';
import { parseEnvironment } from '../src/config/environment';
const fake = (body: unknown, status = 200) => (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;
test('delivery transport confirms ID and classifies rejected, rate limited and ambiguous responses', async () => {
  assert.equal(await new TelegramSender('123:test', fake({ ok: true, result: { message_id: 1 } })).send('-123', 'test'), '1');
  for (const [body, status, category, uncertain] of [
    [{ ok: false, error_code: 403 }, 403, 'API_REJECTED', false],
    [{ ok: false, error_code: 429, parameters: { retry_after: 10 } }, 429, 'RATE_LIMIT', false],
    [{ ok: false, error_code: 500 }, 500, 'SERVER_UNCERTAIN', true],
    [{ ok: true, result: {} }, 200, 'INVALID_RESPONSE', true],
  ] as const) {
    await assert.rejects(new TelegramSender('123:test', fake(body, status)).send('-123', 'test'),
      e => e instanceof DeliveryError && e.category === category && e.uncertain === uncertain);
  }
  await assert.rejects(new TelegramSender('123:test', async () => { throw new Error('secret-token'); }).send('-123', 'test'),
    e => e instanceof DeliveryError && e.uncertain && !e.message.includes('secret-token'));
});
test('delivery needs explicit enabling and required secrets; configuration errors redact values', () => {
  const env = { DATABASE_URL: 'postgresql://localhost/test', REDIS_URL: 'redis://localhost', TELEGRAM_CHAT_ID: '-123' };
  assert.equal(parseEnvironment(env).TELEGRAM_DELIVERY_ENABLED, false);
  assert.throws(() => parseEnvironment({ ...env, TELEGRAM_DELIVERY_ENABLED: 'true' }), /TELEGRAM_BOT_TOKEN/);
  assert.throws(() => parseEnvironment({ ...env, TELEGRAM_BOT_TOKEN: 'secret' }), e => e instanceof Error && !e.message.includes('secret'));
});
