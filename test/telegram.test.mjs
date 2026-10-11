import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TelegramClient, TelegramError, groupIdsFromUpdates } from '../scripts/telegram-client.mjs';

const token = '123456:test_secret';
const bot = { is_bot: true, username: 'Housing_Monitor_NL_bot' };
function mockClient(results) {
  const calls = [];
  const client = new TelegramClient(token, async (url, init) => {
    calls.push({ method: url.split('/').at(-1), body: JSON.parse(init.body), redirect: init.redirect });
    const result = results.shift();
    if (result instanceof Error) throw result;
    return { ok: true, status: 200, json: async () => ({ ok: true, result }) };
  });
  return { client, calls };
}

test('checks identity and rejects another bot', async () => {
  await mockClient([bot]).client.verifyBot('Housing_Monitor_NL_bot');
  await assert.rejects(mockClient([bot]).client.verifyBot('wrongbot'), /different bot/);
});

test('group discovery ignores private messages, deduplicates and handles migrations', () => {
  assert.deepEqual(groupIdsFromUpdates([
    { message: { chat: { id: 123, type: 'private' }, text: 'private contents' } },
    { message: { chat: { id: -1, type: 'group' } } },
    { message: { chat: { id: -1, type: 'group' }, migrate_to_chat_id: -1002 } },
    { my_chat_member: { chat: { id: -1002, type: 'supergroup' } } },
  ]), ['-1002']);
});

test('discovery leaves updates unacknowledged and refuses an active webhook', async () => {
  const { client, calls } = mockClient([{ url: '' }, []]);
  assert.deepEqual(await client.discoverGroups(), []);
  assert.deepEqual(calls[1].body, { timeout: 0, limit: 100 });
  const active = mockClient([{ url: 'https://example.com/secret' }]);
  await assert.rejects(active.client.discoverGroups(), /webhook is active/);
  assert.equal(active.calls.length, 1);
});

test('test delivery validates group and sends once with redirects disabled', async () => {
  const { client, calls } = mockClient([{ type: 'supergroup' }, { message_id: 42 }]);
  assert.equal(await client.sendTest('-100123'), 42);
  assert.deepEqual(calls.map((c) => c.method), ['getChat', 'sendMessage']);
  assert.equal(calls[1].body.chat_id, '-100123');
  assert.equal(calls[1].redirect, 'error');
  await assert.rejects(mockClient([]).client.sendTest('123'), /negative numeric/);
  await assert.rejects(mockClient([{ type: 'private' }]).client.sendTest('-123'), /group or supergroup/);
});

test('transport failures redact secrets and mark delivery uncertain without retry', async () => {
  const { client, calls } = mockClient([{ type: 'group' }, new Error(`https://api.telegram.org/bot${token}/sendMessage`)]);
  await assert.rejects(client.sendTest('-123'), (error) => {
    assert.ok(error instanceof TelegramError);
    assert.equal(error.uncertain, true);
    assert.doesNotMatch(error.stack, /test_secret|api.telegram.org/);
    return true;
  });
  assert.equal(calls.length, 2);
});

test('API errors omit raw descriptions and expose safe retry metadata', async () => {
  const client = new TelegramClient(token, async () => ({
    ok: false, status: 429,
    json: async () => ({ ok: false, error_code: 429, description: token, parameters: { retry_after: 30 } }),
  }));
  await assert.rejects(client.call('getMe'), (error) => {
    assert.equal(error.code, 429);
    assert.equal(error.retryAfter, 30);
    assert.doesNotMatch(error.stack, /test_secret/);
    return true;
  });
});
