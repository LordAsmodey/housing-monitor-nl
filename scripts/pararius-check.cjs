'use strict';
// Read-only smoke against the deployed worker: no PostgreSQL and no Telegram.
const {browserClient}=require('./funda-browser-client.cjs');
const core=require('./pararius-core.cjs');
async function main() {
  const client=browserClient(process.env.PARARIUS_BROWSER_ORIGIN,process.env.PARARIUS_BROWSER_TOKEN);
  const result=await client.collect({settings:require('./search-settings.cjs').defaults(core.SOURCE_ID)});
  console.log(JSON.stringify({inspected:result.inspected,matched:result.listings.length,pages:result.pages,
    available:result.listings.filter(x=>x.availabilityStatus==='available').length}));
}
if(require.main===module)main().catch(error=>{console.error(/^[A-Z_]+$/.test(error.category??'')?error.category:'PARARIUS_CHECK_FAILED');process.exitCode=1});
module.exports={main};
