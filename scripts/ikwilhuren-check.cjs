'use strict';
const {collect} = require('../src/sources/ikwilhuren-core.ts');
collect().then(r=>console.log(JSON.stringify({inspected:r.inspected,matched:r.listings.length,available:r.available,pages:r.pages})))
  .catch(e=>{console.error(e.category||'LIVE_SMOKE_FAILED');process.exitCode=1;});
