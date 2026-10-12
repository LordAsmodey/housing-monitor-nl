import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createTelemetry, sanitizeEvent } = require('../scripts/telemetry.cjs');
const dsn = 'https://public@example.com/123';
function fakeSdk() {
  const calls = [];
  return { calls, init: options => calls.push(['init', options]),
    onUncaughtExceptionIntegration: () => ({}), onUnhandledRejectionIntegration: () => ({}),
    captureException: (...args) => { calls.push(['error', ...args]); return 'event-id'; },
    captureCheckIn: (...args) => { calls.push(['checkin', ...args]); return 'checkin-id'; },
    flush: async () => true };
}
test('test environment and Node test runner suppress SDK initialization, errors and cron traffic even with a DSN', async () => {
  for (const isolation of [{ NODE_ENV: 'test' }, { NODE_ENV: 'development', NODE_TEST_CONTEXT: 'child-v8' }]) {
    const sdk = fakeSdk();
    const telemetry = createTelemetry(sdk, { SENTRY_DSN: dsn, SENTRY_CRONS_ENABLED: 'true', ...isolation });
    assert.equal(telemetry.report(Error('expected failure'), 'telegram', 'DELIVERY_DEAD_LETTER'), undefined);
    assert.equal(telemetry.start('funda', 900), undefined);
    telemetry.finish('funda', 'existing-id', 'error');
    assert.equal(await telemetry.flush(), false);
    assert.deepEqual(sdk.calls, []);
  }
});
test('runtime init remains disabled when a DSN is loaded inside the test process', async () => {
  const previousDsn = process.env.SENTRY_DSN;
  const previousError = console.error;
  const errors = [];
  try {
    console.error = (...args) => errors.push(args);
    assert.ok(process.env.NODE_TEST_CONTEXT);
    // An invalid DSN would make init emit SENTRY_INIT_FAILED if it tried to load the SDK.
    process.env.SENTRY_DSN = 'not-a-valid-dsn';
    const telemetry = require('../scripts/telemetry.cjs').init();
    assert.equal(telemetry.report(Error('expected failure')), undefined);
    assert.equal(await telemetry.flush(), false);
    assert.deepEqual(errors, []);
  } finally {
    console.error = previousError;
    if (previousDsn === undefined) delete process.env.SENTRY_DSN;
    else process.env.SENTRY_DSN = previousDsn;
  }
});
test('disabled telemetry is inert; SDK failures never break source monitoring', async () => {
  const disabled = createTelemetry(undefined, {});
  assert.equal(disabled.report(Error('secret')), undefined);
  assert.equal(disabled.start('funda', 900), undefined);
  assert.equal(await disabled.flush(), false);
  const sdk = fakeSdk();
  sdk.captureException = sdk.captureCheckIn = () => { throw Error('transport secret'); };
  sdk.flush = async () => { throw Error('transport secret'); };
  const telemetry = createTelemetry(sdk, { SENTRY_DSN: dsn, SENTRY_CRONS_ENABLED: 'true' });
  assert.equal(telemetry.report(Error('secret')), undefined);
  assert.equal(telemetry.start('funda', 900), undefined);
  assert.equal(await telemetry.flush(), false);
});
test('invalid DSNs produce a controlled error without credentials', () => {
  for (const value of ['secret', 'http://public@example.com/123', 'https://public:secret@example.com/123', dsn + '?secret=token']) {
    assert.throws(() => createTelemetry(fakeSdk(), { SENTRY_DSN: value }), /^Error: INVALID_SENTRY_DSN$/);
  }
});
test('cron check-ins are opt-in and paired; browser components cannot create monitors', () => {
  const sdk = fakeSdk();
  const telemetry = createTelemetry(sdk, { SENTRY_DSN: dsn, SENTRY_CRONS_ENABLED: 'true' });
  const id = telemetry.start('funda', 900);
  telemetry.finish('funda', id, 'ok');
  assert.equal(sdk.calls[1][1].status, 'in_progress');
  assert.deepEqual(sdk.calls[1][2].schedule, { type: 'interval', value: 15, unit: 'minute' });
  assert.deepEqual(sdk.calls[2][1], { monitorSlug: 'housing-funda', checkInId: id, status: 'ok' });
  for (const source of ['telegram', 'application', 'unknown']) assert.equal(telemetry.start(source, 900), undefined);
  assert.equal(telemetry.start('funda', NaN), undefined);
  const other = fakeSdk();
  createTelemetry(other, { SENTRY_DSN: dsn }).start('funda', 900);
  createTelemetry(other, { SENTRY_DSN: dsn, SENTRY_CRONS_ENABLED: 'true' }, 'funda-browser').start('funda', 900);
  assert.equal(other.calls.filter(c => c[0] === 'checkin').length, 0);
});
test('privacy filter removes payloads, URLs, identities, source lines and absolute paths', () => {
  const clean = sanitizeEvent({ event_id: 'id', message: 'private-message',
    user: { email: 'private-email' }, request: { url: 'private-url' }, extra: { token: 'private-token' },
    contexts: { trace: { data: 'private-trace' } }, breadcrumbs: [{ message: 'private-breadcrumb' }],
    tags: { source: 'funda', component: 'application', category: 'RUN_FAILED', token: 'private-tag' },
    exception: { values: [{ type: 'private-type', value: 'private-error', stacktrace: { frames: [
      { filename: 'C:\\private-user\\monitor.cjs?private-query', vars: { cookie: 'private-cookie' }, context_line: 'private-line', lineno: 10 },
      { filename: '/private-user/main.js', lineno: 12 },
    ] } }] } });
  assert.doesNotMatch(JSON.stringify(clean), /private-/);
  assert.equal(clean.exception.values[0].stacktrace.frames[0].filename, 'monitor.cjs');
  assert.equal(clean.exception.values[0].stacktrace.frames[1].lineno, 12);
  assert.deepEqual(clean.fingerprint, ['housing-monitor', 'application', 'funda', 'RUN_FAILED']);
});
test('real SDK sends only sanitized error fields through its transport', async () => {
  const Sentry = require('@sentry/node');
  const envelopes = [];
  const wrapped = { ...Sentry, init(options) {
    Sentry.init({ ...options, transport: () => ({ send: async envelope => { envelopes.push(envelope); return { statusCode: 200 }; }, flush: async () => true }) });
  } };
  // Explicit injected environment/transport exercises the SDK without runtime init or networking.
  const telemetry = createTelemetry(wrapped, { SENTRY_DSN: dsn, SENTRY_ENVIRONMENT: 'test' });
  Sentry.setUser({ email: 'private-sdk-email' });
  Sentry.setExtra('cookie', 'private-sdk-cookie');
  const id = telemetry.report(Error('private-sdk-message'), 'telegram', 'DELIVERY_DEAD_LETTER');
  assert.equal(await telemetry.flush(), true);
  const item = envelopes.flatMap(envelope => envelope[1]).find(item => item[0].type === 'event');
  assert.ok(item);
  assert.equal(item[1].event_id, id);
  assert.doesNotMatch(JSON.stringify(item[1]), /private-sdk/);
  assert.equal(item[1].exception.values[0].value, 'DELIVERY_DEAD_LETTER');
  await Sentry.close();
});
