'use strict';
// No database or Telegram: exercise a full fill, then reuse its decisions for the head.
const { collect, RunTimeoutError } = require('../src/sources/rentola-core.ts');
async function check() {
  const full = await collect();
  const head = await collect({previousState:full.collectionState});
  for (const result of [full,head]) console.log(JSON.stringify({
    inspected: result.inspected, matched: result.listings.length, available: result.available,
    pages: result.pages, searchOrder: result.searchOrder, mode: result.mode,
    diagnostics: result.diagnostics,
  }));
}
check().catch(error => {
  console.error(JSON.stringify({ category: error.category || 'LIVE_SMOKE_FAILED',
    ...(error instanceof RunTimeoutError ? { progress: error.progress } : {}),
  }));
  process.exitCode = 1;
});
