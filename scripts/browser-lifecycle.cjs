'use strict';
// All browser work, including idle shutdown, shares one queue. Health probes never wake it.
function idleTimeout(env = process.env) {
  const value = env.BROWSER_IDLE_TIMEOUT_SECONDS ?? '0';
  if (!/^\d+$/.test(value) || Number(value) > 3600 || Number(value) > 0 && Number(value) < 10) throw Error('BROWSER_IDLE_CONFIGURATION');
  return Number(value) * 1000;
}
function createBrowserLifecycle({ launch, suspend, timeoutMs = 0, onEvent = () => {}, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let handle, chain = Promise.resolve(), queued = 0, timer, stopped = false, enabled = false, failed = false;
  function serial(task, bounded = true) {
    if (bounded && queued >= 15) return Promise.reject(Error('BUSY'));
    queued++;
    const job = chain.then(task);
    chain = job.catch(() => {});
    return job.finally(() => queued--);
  }
  function cancel() { if (timer !== undefined) clearTimer(timer); timer = undefined; }
  async function sleep() {
    if (!handle) return;
    // A failed save must never be followed by launching from an older archive.
    failed = true;
    await suspend(handle);
    handle = undefined;
    failed = false;
    onEvent('browser-idle');
  }
  function schedule() {
    cancel();
    if (!enabled || !timeoutMs || stopped || failed || !handle || queued > 1) return;
    timer = setTimer(() => {
      timer = undefined;
      serial(async () => { if (!stopped && handle) await sleep(); }).catch(() => onEvent('browser-idle-failed'));
    }, timeoutMs);
    timer?.unref?.();
  }
  return {
    state: () => stopped ? 'stopped' : failed ? 'failed' : handle ? 'active' : 'idle',
    start() { enabled = true; schedule(); },
    run(task) {
      cancel();
      return serial(async () => {
        if (stopped || failed) throw Error('BROWSER_UNAVAILABLE');
        if (!handle) { handle = await launch(); onEvent('browser-awake'); }
        try { return await task(handle); } finally { schedule(); }
      });
    },
    maintenance(task) {
      return serial(async () => {
        try { if (!stopped && !failed && handle) return await task(handle); }
        finally { if (timer === undefined) schedule(); }
      });
    },
    close() {
      stopped = true; cancel();
      return serial(sleep, false);
    },
  };
}
module.exports = { idleTimeout, createBrowserLifecycle };
