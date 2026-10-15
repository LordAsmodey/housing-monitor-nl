'use strict';
const { collect } = require('../dist/sources/solide-core.js');
collect().then(r => console.log(JSON.stringify({ inspected: r.inspected, available: r.available, total: r.total, pages: r.pages })))
  .catch(e => { console.error(e.category || 'LIVE_SMOKE_FAILED'); process.exitCode = 1; });
