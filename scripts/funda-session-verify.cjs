'use strict';
// Bounded agent-side verification using a short-lived UI capability; never reads browser state.
async function main() {
  const origin=process.env.BROWSER_DIAG_ORIGIN, cookie=process.env.BROWSER_DIAG_COOKIE;
  if (!origin || !/^https:\/\/[a-z0-9-]+\.up\.railway\.app$/.test(origin) || !cookie) throw new Error('CONFIGURATION');
  const mode=process.env.BROWSER_DIAG_MODE??'check';
  for(let iteration=1;iteration<=(mode==='check'?2:1);iteration++){
    const response=await fetch(origin+(mode==='check'?'/api/action':'/api/state'),{
      method:mode==='check'?'POST':'GET',redirect:'error',signal:AbortSignal.timeout(40000),
      headers:{Origin:origin,Cookie:'funda_session='+cookie,'Content-Type':'application/json'},
      ...(mode==='check'?{body:JSON.stringify({type:'check'})}:{}),
    });
    const result=await response.json();
    console.log(JSON.stringify({message:'Funda session verification',event:mode,iteration,status:response.status,
      title:result.title??null,path:result.path??null,humanCheck:result.humanCheck??null,
      accessDenied:result.accessDenied??null,listingLinks:result.listingLinks??null,at:new Date().toISOString()}));
    if(!response.ok)throw new Error('VERIFICATION_FAILED');
  }
}
const timeout=setTimeout(()=>process.exit(1),90000);
main().catch(()=>{console.error('Funda session verification failed');process.exitCode=1}).finally(()=>clearTimeout(timeout));
