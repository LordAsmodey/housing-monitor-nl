'use strict';
const fs = require('node:fs/promises');
const INTERVAL = 15 * 60 * 1000, DURATION = 24 * 60 * 60 * 1000;
function createExperiment({ file = '/data/experiment.json', now = Date.now,
  schedule = setInterval, cancel = clearInterval, emit = data => console.log(JSON.stringify({ event: 'experiment-sample', ...data })) } = {}) {
  let state = { status: 'not-started' }, collect, active = false, timer;
  async function persist() { await fs.writeFile(file + '.tmp', JSON.stringify(state), { mode: 0o600 }); await fs.rename(file + '.tmp', file); }
  async function tick() {
    if (active || state.status !== 'running' || now() < state.nextCheckAt) return;
    active = true;
    try {
      if (now() >= state.endsAt) {
        state.status = state.samples.length === 96 && state.samples.every(s => s.ok) && state.restoredRestarts > 0 ? 'passed' : 'incomplete';
        await persist(); emit({ status: state.status, checks: state.samples.length, restoredRestarts: state.restoredRestarts }); return;
      }
      const slot = Math.floor((now() - state.startedAt) / INTERVAL);
      if (slot !== state.samples.length) { state.status = 'incomplete'; await persist(); emit({ status: state.status, reason: 'MISSED_INTERVAL' }); return; }
      let sample;
      try {
        const result = await collect();
        sample = { at: now(), ok: true, inspected: result.inspected, pages: result.pages };
      } catch (error) {
        const category = /^[A-Z_]{1,60}$/.test(error.category ?? '') ? error.category : 'BROWSER_FAILED';
        sample = { at: now(), ok: false, category };
        state.status = error.blocked ? 'blocked' : 'failed';
      }
      state.samples.push(sample); state.nextCheckAt = state.startedAt + state.samples.length * INTERVAL;
      await persist(); emit({ ...sample, status: state.status, checks: state.samples.length });
    } finally { active = false; }
  }
  return {
    state: () => structuredClone(state),
    async init(options) {
      collect = options.collect;
      try { state = JSON.parse(await fs.readFile(file, 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw Error('EXPERIMENT_STATE_INVALID'); }
      if (state.status === 'running') { state.restoredRestarts += options.profileRestored ? 1 : 0; await persist(); }
      if (!timer) timer = schedule(() => tick().catch(() => emit({ category: 'EXPERIMENT_IO_FAILED' })), 5000);
      if (state.status === 'not-started') await this.start();
    },
    async start() {
      if (!collect) throw Error('EXPERIMENT_NOT_READY');
      if (active) throw Error('EXPERIMENT_BUSY');
      if (state.status !== 'running') {
        state = { status: 'running', startedAt: now(), endsAt: now() + DURATION, nextCheckAt: now(), restoredRestarts: 0, samples: [] };
        await persist();
      }
      await tick();
    },
    tick,
    stop() { if (timer) cancel(timer); timer = undefined; },
  };
}
module.exports = { createExperiment, INTERVAL, DURATION };
