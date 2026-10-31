'use strict';
// All browser work, including idle shutdown, shares one queue. Health probes never wake it.
function idleTimeout(env = process.env) {
  const value = env.BROWSER_IDLE_TIMEOUT_SECONDS ?? '0';
  if (!/^\d+$/.test(value) || Number(value) > 3600 || Number(value) > 0 && Number(value) < 10) throw Error('BROWSER_IDLE_CONFIGURATION');
  return Number(value) * 1000;
}
function createBrowserLifecycle({ launch, suspend, timeoutMs = 0, operationTimeoutMs = 0, onOperationTimeout = () => {}, onEvent = () => {}, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let handle, chain = Promise.resolve(), queued = 0, timer, stopped = false, enabled = false, failed = false, stalled = false;
  async function watch(task) {
    // Start the deadline when work starts, not while it waits in the queue.
    // Do not race/release a hung task: it may still own the browser or state file.
    const deadline = operationTimeoutMs ? setTimeout(() => {
      stalled = true;
      onEvent('browser-operation-timeout');
      onOperationTimeout();
    }, operationTimeoutMs) : undefined;
    try { return await task(); }
    finally { if (deadline !== undefined) clearTimeout(deadline); }
  }
  function serial(task, bounded = true) {
    if (bounded && queued >= 15) return Promise.reject(Error('BUSY'));
    queued++;
    const job = chain.then(() => watch(task));
    chain = job.catch(() => {});
    return job.finally(() => queued--);
  }
  function cancel() { if (timer !== undefined) clearTimer(timer); timer = undefined; }
  async function sleep() {
    if (!handle) return;
    // A failed save must never be followed by launching from an older archive.
    try { await suspend(handle); }
    catch (error) { failed = true; throw error; }
    handle = undefined;
    failed = false;
    onEvent('browser-idle');
  }
  function schedule() {
    cancel();
    if (!enabled || !timeoutMs || stopped || failed || stalled || !handle || queued > 1) return;
    timer = setTimer(() => {
      timer = undefined;
      serial(async () => { if (!stopped && handle) await sleep(); }).catch(() => onEvent('browser-idle-failed'));
    }, timeoutMs);
    timer?.unref?.();
  }
  return {
    state: () => stopped ? 'stopped' : failed || stalled ? 'failed' : handle ? 'active' : 'idle',
    start() { enabled = true; schedule(); },
    run(task) {
      cancel();
      return serial(async () => {
        if (stopped || failed || stalled) throw Error('BROWSER_UNAVAILABLE');
        if (!handle) { handle = await launch(); onEvent('browser-awake'); }
        try { return await task(handle); } finally { schedule(); }
      });
    },
    maintenance(task) {
      return serial(async () => {
        try { if (!stopped && !failed && !stalled && handle) return await task(handle); }
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
