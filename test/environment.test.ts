import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseEnvironment } from '../src/config/environment';

const valid = { DATABASE_URL: 'postgresql://user:password@localhost:5432/housing', REDIS_URL: 'redis://localhost:6379', TELEGRAM_CHAT_ID: '-123' };

test('defaults to a 15 minute monitoring interval', () => {
  assert.equal(parseEnvironment(valid).MONITOR_INTERVAL_SECONDS, 900);
});

test('Vesteda monitoring defaults to enabled and can be explicitly paused', () => {
  assert.equal(parseEnvironment(valid).VESTEDA_MONITORING_ENABLED, true);
  assert.equal(parseEnvironment({...valid,VESTEDA_MONITORING_ENABLED:'false'}).VESTEDA_MONITORING_ENABLED, false);
  assert.equal(parseEnvironment({...valid,VESTEDA_MONITORING_ENABLED:'true'}).VESTEDA_MONITORING_ENABLED, true);
  assert.throws(() => parseEnvironment({...valid,VESTEDA_MONITORING_ENABLED:'yes'}), /VESTEDA_MONITORING_ENABLED/);
});

test('Huurwoningen is opt-in and requires its own origin and token pair', () => {
  assert.equal(parseEnvironment(valid).HUURWONINGEN_BROWSER_ORIGIN, undefined);
  assert.throws(() => parseEnvironment({ ...valid, HUURWONINGEN_BROWSER_ORIGIN: 'https://huur.up.railway.app' }), /HUURWONINGEN_BROWSER_ORIGIN/);
  assert.throws(() => parseEnvironment({ ...valid, HUURWONINGEN_BROWSER_TOKEN: 'x'.repeat(43) }), /HUURWONINGEN_BROWSER_ORIGIN/);
  assert.equal(parseEnvironment({ ...valid, HUURWONINGEN_BROWSER_ORIGIN: 'https://huur.up.railway.app', HUURWONINGEN_BROWSER_TOKEN: 'x'.repeat(43) }).HUURWONINGEN_BROWSER_TOKEN?.length, 43);
});

test('Funda monitoring requires a Telegram destination even when delivery is paused', () => {
  const { TELEGRAM_CHAT_ID: _chat, ...withoutChat } = valid;
  assert.throws(() => parseEnvironment(withoutChat), /TELEGRAM_CHAT_ID/);
  assert.equal(parseEnvironment(valid).TELEGRAM_CHAT_ID, '-123');
});

test('rejects invalid configuration without leaking secrets', () => {
  assert.throws(() => parseEnvironment({ ...valid, DATABASE_URL: 'https://user:secret@example.com' }), (error: Error) => {
    assert.match(error.message, /DATABASE_URL/);
    assert.doesNotMatch(error.message, /secret|example.com/);
    return true;
  });
  assert.throws(() => parseEnvironment({ ...valid, PORT: 65536 }));
  assert.throws(() => parseEnvironment({ ...valid, MONITOR_INTERVAL_SECONDS: 0 }));
});


test('Gruno monitoring defaults to enabled and can be paused without resetting source state', () => {
  assert.equal(parseEnvironment(valid).GRUNO_MONITORING_ENABLED, true);
  assert.equal(parseEnvironment({...valid,GRUNO_MONITORING_ENABLED:'false'}).GRUNO_MONITORING_ENABLED, false);
  assert.throws(() => parseEnvironment({...valid,GRUNO_MONITORING_ENABLED:'yes'}), /GRUNO_MONITORING_ENABLED/);
});
