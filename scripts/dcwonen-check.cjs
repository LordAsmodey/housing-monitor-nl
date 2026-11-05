"use strict";
const { collect, SOURCE_ID } = require('../dist/sources/dcwonen-core.js');
const registry = require('./search-settings.cjs');
collect().then(r => console.log(JSON.stringify({sourceId:SOURCE_ID,inspected:r.inspected,pages:r.pages,
  matched:r.listings.filter(x=>x.availabilityStatus==='available' && registry.matches(registry.defaults(SOURCE_ID),x,SOURCE_ID)).length})))
  .catch(e=>{console.error(e.category || 'LIVE_SMOKE_FAILED');process.exitCode=1;});
