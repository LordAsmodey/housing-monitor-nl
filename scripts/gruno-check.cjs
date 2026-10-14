'use strict';
const {collect,parseCard}=require('./gruno-core.cjs');
let lastHtml='',lastPath='';
const transport=async(url,options)=>{
  lastPath=new URL(url).pathname;
  const response=await fetch(url,options);
  if(response.ok&&/text\/html/.test(response.headers.get('content-type')??''))lastHtml=await response.clone().text();
  return response;
};
collect({transport}).then(r=>console.log(JSON.stringify({inspected:r.inspected,matched:r.listings.length,available:r.available,total:r.total,pages:r.pages,details:r.details})))
  .catch(e=>{
    console.error(e.category||'LIVE_SMOKE_FAILED');
    const cardErrors=[...lastHtml.matchAll(/<article\b[^>]*>[\s\S]*?<\/article>/g)].flatMap(m=>{try{parseCard(m[0]);return []}catch(error){return [{category:error.category,visible:m[0].replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim().slice(0,1200)}]}});
    console.error(JSON.stringify({cardErrors}));
    // Only public property/pagination URLs; never headers, cookies or form fields.
    console.error(JSON.stringify({lastPath,links:[...new Set([...lastHtml.matchAll(/href="([^"<>]*\/woningaanbod\/[^"<>]*)"/g)].map(m=>m[1]))].slice(0,35)}));
    process.exitCode=1;
  });
