import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createBrowserLifecycle, idleTimeout } = require('../scripts/browser-lifecycle.cjs');
function fixture(overrides = {}) {
  let callback, launches = 0, sleeps = 0;
  const events = [];
  const lifecycle = createBrowserLifecycle({
    timeoutMs: 60000,
    launch: async () => ({ generation: ++launches }),
    suspend: async () => { sleeps++; },
    setTimer: cb => { callback = cb; return 1; },
    clearTimer: () => { callback = undefined; },
    onEvent: event => events.push(event), ...overrides,
  });
  return { lifecycle, events, launches: () => launches, sleeps: () => sleeps,
    fire: async () => { const cb = callback; callback = undefined; assert.ok(cb); cb(); await lifecycle.maintenance(() => {}); },
    hasTimer: () => Boolean(callback) };
}
test('idle shutdown releases the browser; maintenance and health state do not wake it; next work restores', async () => {
  const f = fixture();
  assert.equal(await f.lifecycle.run(h => h.generation), 1);
  assert.equal(f.hasTimer(), false); // Startup self-check must complete first.
  f.lifecycle.start(); await f.fire();
  assert.equal(f.lifecycle.state(), 'idle'); assert.equal(f.sleeps(), 1);
  let inspected = false; await f.lifecycle.maintenance(() => { inspected = true; });
  assert.equal(inspected, false); assert.equal(f.launches(), 1);
  assert.equal(await f.lifecycle.run(h => h.generation), 2);
  await f.lifecycle.close(); assert.equal(f.sleeps(), 2);
  await assert.rejects(f.lifecycle.run(() => {}), /BROWSER_UNAVAILABLE/);
});
test('concurrent collections share one browser and idle close waits for current work', async () => {
  const f = fixture(); await f.lifecycle.run(() => {}); f.lifecycle.start();
  let release; const gate = new Promise(resolve => { release = resolve; });
  const order = [];
  let entered; const started = new Promise(resolve => { entered = resolve; });
  const first = f.lifecycle.run(async () => { entered(); order.push('first'); await gate; order.push('done'); });
  await started;
  const second = f.lifecycle.run(() => { order.push('second'); });
  assert.equal(f.hasTimer(), false);
  const closing = f.lifecycle.close();
  release(); await first; await assert.rejects(second, /BROWSER_UNAVAILABLE/); await closing;
  assert.deepEqual(order, ['first', 'done']); assert.equal(f.launches(), 1); assert.equal(f.sleeps(), 1);
});
test('failed archive save prevents relaunch from stale state and shutdown retries saving', async () => {
  let attempts = 0;
  const f = fixture({ suspend: async () => { if (++attempts === 1) throw Error('SAVE_FAILED'); } });
  await f.lifecycle.run(() => {}); f.lifecycle.start(); await f.fire();
  assert.equal(f.lifecycle.state(), 'failed'); assert.ok(f.events.includes('browser-idle-failed'));
  await assert.rejects(f.lifecycle.run(() => {}), /BROWSER_UNAVAILABLE/);
  assert.equal(f.launches(), 1); await f.lifecycle.close(); assert.equal(attempts, 2);
});
test('disabled mode retains existing browser behavior; errors still arm idle cleanup', async () => {
  const disabled = fixture({ timeoutMs: 0 });
  await disabled.lifecycle.run(() => {}); disabled.lifecycle.start(); assert.equal(disabled.hasTimer(), false);
  await disabled.lifecycle.close();
  const f = fixture(); f.lifecycle.start();
  await assert.rejects(f.lifecycle.run(() => { throw Error('COLLECTION_FAILED'); }), /COLLECTION_FAILED/);
  assert.equal(f.hasTimer(), true); await f.fire(); assert.equal(f.lifecycle.state(), 'idle');
});
test('idle configuration fails closed and defaults to disabled', () => {
  assert.equal(idleTimeout({}), 0); assert.equal(idleTimeout({ BROWSER_IDLE_TIMEOUT_SECONDS: '60' }), 60000);
  for (const value of ['-1', '9', '3601', 'foo', 'NaN', '1.5', '']) assert.throws(() => idleTimeout({ BROWSER_IDLE_TIMEOUT_SECONDS: value }));
});
test('queued requests finish in order and the last request arms idle cleanup', async () => {
  const f = fixture(); f.lifecycle.start(); const seen = [];
  await Promise.all(Array.from({ length: 10 }, (_, index) => f.lifecycle.run(h => { seen.push(index); assert.equal(h.generation, 1); })));
  assert.deepEqual(seen, Array.from({ length: 10 }, (_, index) => index));
  assert.equal(f.hasTimer(), true); await f.fire(); assert.equal(f.sleeps(), 1);
});
test('failed launch can be retried and queue pressure rejects additional work', async () => {
  let attempts = 0;
  const f = fixture({ launch: async () => { if (++attempts === 1) throw Error('START_FAILED'); return {}; } });
  await assert.rejects(f.lifecycle.run(() => {}), /START_FAILED/);
  await f.lifecycle.run(() => {}); assert.equal(attempts, 2);
  let release; const gate = new Promise(resolve => { release = resolve; });
  const pending = Array.from({ length: 15 }, () => f.lifecycle.run(() => gate));
  await assert.rejects(f.lifecycle.run(() => {}), /BUSY/);
  release(); await Promise.all(pending); await f.lifecycle.close();
});
test('heartbeat queued behind work cannot suppress idle cleanup or reset an existing timer', async () => {
  const f = fixture(); f.lifecycle.start();
  await Promise.all([f.lifecycle.run(() => {}), f.lifecycle.maintenance(() => {})]);
  assert.equal(f.hasTimer(), true);
  await f.lifecycle.maintenance(() => {}); assert.equal(f.hasTimer(), true);
  await f.fire(); assert.equal(f.lifecycle.state(), 'idle');
});
