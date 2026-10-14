'use strict';
// Temporary read-only research probe, replaced by collector smoke before completion.
const base='https://www.grunoverhuur.nl';
async function read(path) {
  const r=await fetch(base+path,{redirect:'manual',signal:AbortSignal.timeout(30000)});
  console.log('HTTP',path,r.status,r.headers.get('content-type'));
  if(!r.ok)throw Error('HTTP_STATUS');
  return r.text();
}
function clean(html) {
  return html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,'')
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi,'').replace(/<input\b[^>]*>/gi,'').replace(/<!--([\s\S]*?)-->/g,'')
    .replace(/\s(?:src|srcset|style|data-[\w-]+)\s*=\s*(?:"[^"]*"|'[^']*')/gi,'').replace(/\s+/g,' ');
}
(async()=>{
  const catalog=clean(await read('/woningaanbod/groningen'));
  console.log('HEADINGS',catalog.match(/<h[12]\b[^>]*>[\s\S]*?<\/h[12]>/gi));
  const i=catalog.indexOf('jozef-israelsstraat');
  console.log('CATALOG_SAMPLE',catalog.slice(Math.max(0,i-1600),i+16000));
  const detail=clean(await read('/woningaanbod/huur/groningen/jozef-israelsstraat/45-2'));
  const j=detail.indexOf('Referentienummer');
  console.log('DETAIL_SAMPLE',detail.slice(Math.max(0,j-3000),j+22000));
  console.log('ROBOTS',(await read('/robots.txt')).slice(0,5000));
})().catch(e=>{console.error(e.message);process.exitCode=1});
