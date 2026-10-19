'use strict';
// node --import tsx scripts/rentola-check.cjs: no database or Telegram.
const { collect, SearchChangedError, RunTimeoutError } = require('../src/sources/rentola-core.ts');
collect().then(result => console.log(JSON.stringify({
  inspected: result.inspected, matched: result.listings.length, available: result.available,
  pages: result.pages, searchOrder: result.searchOrder, recoveredFrom: result.recoveredFrom,
  diagnostics: result.diagnostics,
}))).catch(error => {
  console.error(JSON.stringify({ category: error.category || 'LIVE_SMOKE_FAILED',
    ...(error instanceof SearchChangedError ? { order: error.order, page: error.page,
      expected: error.expected, actual: error.actual } : {}),
    ...(error instanceof RunTimeoutError ? { progress: error.progress } : {}),
  }));
  process.exitCode = 1;
});
