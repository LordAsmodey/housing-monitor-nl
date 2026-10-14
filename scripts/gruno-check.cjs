'use strict';
const {collect}=require('./gruno-core.cjs');
collect().then(r=>console.log(JSON.stringify({inspected:r.inspected,matched:r.listings.length,available:r.available,unknown:r.listings.filter(x=>x.availabilityStatus==='unknown').length,total:r.total,pages:r.pages,details:r.details})))
  .catch(e=>{console.error(e.category||'LIVE_SMOKE_FAILED');process.exitCode=1});
