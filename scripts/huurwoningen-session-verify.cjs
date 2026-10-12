'use strict';
async function verify(origin=process.env.HUURWONINGEN_BROWSER_ORIGIN, token=process.env.BROWSER_WORKER_TOKEN??process.env.HUURWONINGEN_BROWSER_TOKEN) {
  const start=Date.now();
  const response=await fetch(new URL('/worker/collect',origin),{method:'POST',redirect:'error',headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(330000)});
  const result=await response.json();
  const summary={event:'huurwoningen-smoke',status:response.status,durationMs:Date.now()-start,category:result.category,inspected:result.inspected,pages:result.pages,matched:result.listings?.length};
  console.log(JSON.stringify(summary));
  if(!response.ok)throw Error('HUUR_SMOKE_FAILED');
  return summary;
}
module.exports={verify};
if(require.main===module)verify().catch(()=>{console.log('HUUR_SMOKE_FAILED');process.exitCode=1});
