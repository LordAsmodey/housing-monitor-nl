"use strict";
const { collect } = require('../dist/sources/maxx-core.js');
collect().then(r => console.log(JSON.stringify({ inspected: r.inspected, matched: r.listings.length, available: r.available })))
  .catch(e => { console.error(e.category || 'LIVE_SMOKE_FAILED'); process.exitCode = 1; });
