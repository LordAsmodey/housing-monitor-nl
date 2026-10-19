import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseSearch,parseDetail,collect,independentHousing,allowedDetailUrl,SOURCE_ID,SEARCH_URL,RunTimeoutError,RUN_TIMEOUT_MS,FULL_SCAN_INTERVAL_MS,readCollectionState} from '../src/sources/rentola-core';
const registry = require('../scripts/search-settings.cjs');
const fixture = (name = 'search') => readFileSync(`test/fixtures/rentola-${name}.html`,'utf8');
const defaults = registry.defaults(SOURCE_ID);
function state(html = fixture()) {return JSON.parse(JSON.parse(html.match(/push\((\[.*\])\)/)![1]!)[1]);}
function ld(html = fixture()) {return JSON.parse(html.match(/type="application\/ld\+json">(.*?)<\/script>/)![1]!);}
function render(data:any, schema = ld()) {return `<script type="application/ld+json">${JSON.stringify(schema)}</script><script>self.__next_f.push(${JSON.stringify([1,JSON.stringify(data)])})</script>`;}
function single() {
  const d=state(); d.searchPropertiesData.data=d.searchPropertiesData.data.slice(0,1);
  d.searchPropertiesData.meta.pagination={currentPage:1,totalPages:1,totalCount:1,perPage:21};
  const l=ld(); l.mainEntity.itemListElement=l.mainEntity.itemListElement.slice(0,1);
  return {d,l};
}
const response = (body:string) => new Response(body,{headers:{'content-type':'text/html'}});
const detail = (item:any, description='Een zelfstandig appartement met eigen keuken en badkamer.') => `<script type="application/ld+json">${JSON.stringify({'@type':'RealEstateListing',url:item.canonicalUrl,name:item.title,description,offers:{price:item.rentPrice,priceCurrency:'EUR',availability:'https://schema.org/InStock',itemOffered:{address:{addressLocality:'Groningen'}}}})}</script>`;
test('real first and last page validate geography and modern/legacy URLs',()=>{
 const a=parseSearch(fixture()); const b=parseSearch(fixture('last'),14);
 assert.equal(a.ids.length,21); assert.equal(b.ids.length,12);
 assert.equal(a.listings.length,12); assert.equal(b.listings.length,10);
 assert.equal(b.listings.at(-1)!.areaM2,undefined); // estimated area is not a known area
 assert.equal(a.listings[0]!.rentPrice,2150); assert.equal(a.listings[0]!.externalId,'40341090');
});
test('independent housing rejects rooms, shared homes, student and ambiguous categories',()=>{
 for(const [type,title] of [['room','Studio'],['student apartment','Appartement'],['house','1 bedroom Surface Area: 12m2'],['apartment','Kamer te huur'],['apartment','Twee kamers in studentenhuis'],['apartment','Shared apartment']]) assert.equal(independentHousing(type!,title!),false);
 for(const type of ['apartment','studio','house']) assert.equal(independentHousing(type,'Zelfstandige woning'),true);
});
test('real room description overrides misleading apartment category',()=>{
 const room=JSON.parse(readFileSync('test/fixtures/rentola-room-detail.json','utf8'));
 const item=parseSearch(fixture('last'),14).listings.find(x=>x.title.includes('Jennerstraat'))!;
 assert.equal(parseDetail(`<script type="application/ld+json">${JSON.stringify(room)}</script>`,item),false);
 const home=parseSearch(fixture()).listings[0]!;
 assert.equal(parseDetail(detail(home),home),true);
 assert.equal(parseDetail(detail(home,''),home),false);
 for(const desc of ['Een studentenkamer.','Gedeelde keuken en badkamer.','Shared bathroom.','Gezamenlijke keuken.','De badkamer wordt gedeeld.','Onzelfstandige woonruimte.','Drie kamers.']) assert.equal(parseDetail(detail(home,desc),home),false);
 assert.throws(()=>parseDetail(detail(home).replace('"EUR"','"USD"'),home),/DETAIL_METADATA_MISMATCH/);
 assert.throws(()=>parseDetail('<html/>',home),/DETAIL_STRUCTURE_CHANGED/);
});
test('corrupt filters, metadata and duplicates fail closed',()=>{
 const mutations=[(d:any)=>d.listingsParams.location='1',(d:any)=>d.listingsParams.priceMax='1500',
 (d:any)=>d.listingsParams.order='asc',(d:any)=>d.listingsParams.page='2',
 (d:any)=>d.searchPropertiesData.data[0].attributes.rentCurrency='USD',
 (d:any)=>d.searchPropertiesData.data[0].relationships.city.data.id='1',
 (d:any)=>d.searchPropertiesData.data[1]=d.searchPropertiesData.data[0]];
 for(const mutate of mutations){const d=state();mutate(d);assert.throws(()=>parseSearch(render(d)));}
 const l=ld();l.mainEntity.itemListElement[0].item.offers.price=1;assert.throws(()=>parseSearch(render(state(),l)),/CARD_METADATA_MISMATCH/);
 assert.throws(()=>parseSearch('Access denied'),/ACCESS_BLOCKED/);
 assert.throws(()=>parseSearch(''),/SEARCH_STRUCTURE_CHANGED/);
 const {d,l:empty}=single();d.searchPropertiesData.data=[];d.searchPropertiesData.meta.pagination.totalCount=0;empty.mainEntity.itemListElement=[];
 assert.throws(()=>parseSearch(render(d,empty)),/EMPTY_SEARCH_UNCONFIRMED/);
});
test('URLs reject foreign domains, credentials, query, hash and insecure protocol',()=>{
 for(const path of ['/en/listings/home-p123abc','/en/listings/home-123abc']) assert.equal(allowedDetailUrl(path),'https://rentola.nl'+path);
 for(const url of ['https://evil.test/en/listings/home-p123abc','http://rentola.nl/en/listings/home-p123abc','https://user@rentola.nl/en/listings/home-p123abc','/en/listings/home-p123abc?q=1','/en/listings/home-p123abc#x','/en/listings/home']) assert.throws(()=>allowedDetailUrl(url));
});
test('underscore slugs validate even on excluded student cards without weakening URL checks',()=>{
 const {d,l}=single();
 const slug='student_apartment-for-rent-at-bottelroosstraat-1-groningen-p39bae8';
 d.searchPropertiesData.data[0].attributes.slug=slug;
 const url='https://rentola.nl/en/listings/'+slug;
 const item=l.mainEntity.itemListElement[0];item.url=item.item.url=item.item.offers.url=url;
 assert.equal(parseSearch(render(d,l)).listings[0]!.canonicalUrl,url);
 d.searchPropertiesData.data[0].attributes.propertyType='student apartment';
 assert.equal(parseSearch(render(d,l)).listings.length,0);
 assert.equal(parseSearch(render(d,l)).ids.length,1);
 for(const value of [url+'?x=1',url+'#x',url.replace('rentola.nl','evil.example'),url.replace('student_apartment','student%2Fapartment')]) assert.throws(()=>allowedDetailUrl(value));
});
test('collector preserves exact search; price and area boundaries apply before details',async()=>{
 const {d,l}=single();d.searchPropertiesData.data[0].attributes.monthlyRent=1500;l.mainEntity.itemListElement[0].item.offers.price=1500;
 const body=render(d,l);const item=parseSearch(body).listings[0]!;let calls=0;
 const transport:typeof fetch=async(url,opts)=>{calls++;assert.equal(opts!.redirect,'manual');assert.equal((opts!.headers as any)['Accept-Language'],'en');
 if(String(url)===SEARCH_URL)return response(body);assert.equal(String(url),item.canonicalUrl);return response(detail(item));};
 const r=await collect({transport,pause:async()=>{}});assert.equal(r.listings.length,1);assert.equal(calls,2);
 calls=0;const narrow=await collect({settings:{...defaults,maxRent:1499},transport,pause:async()=>{}});assert.equal(narrow.listings.length,0);assert.equal(calls,1);
 assert.equal(registry.matches({...defaults,minArea:63},item,SOURCE_ID),false);
});
test('unavailable and unknown cards are fully parsed without fetching descriptions that cannot qualify',async()=>{
 for(const availability of ['https://schema.org/OutOfStock','https://schema.org/SoldOut','https://schema.org/PreOrder']){
  const {d,l}=single();d.searchPropertiesData.data[0].attributes.monthlyRent=900;
  l.mainEntity.itemListElement[0].item.offers.price=900;
  l.mainEntity.itemListElement[0].item.offers.availability=availability;
  let calls=0;
  const result=await collect({pause:async()=>{},transport:async url=>{
   calls++;assert.equal(String(url),SEARCH_URL);return response(render(d,l));
  }});
  assert.equal(calls,1);assert.equal(result.inspected,1);assert.equal(result.listings.length,0);
  assert.equal(result.diagnostics.detailCandidates,0);
 }
});
test('default Rentola deadline bounds daily revalidation and remains cancellable',async t=>{
 const budgets:number[]=[];
 t.mock.method(AbortSignal,'timeout',(ms:number)=>{budgets.push(ms);return AbortSignal.abort();});
 await assert.rejects(collect(),RunTimeoutError);
 assert.deepEqual(budgets,[240000]);assert.equal(RUN_TIMEOUT_MS,240000);
});
test('timeout reports only technical phase and progress for the original cancellation signal',async()=>{
 const {d,l}=single();d.searchPropertiesData.data[0].attributes.monthlyRent=900;
 l.mainEntity.itemListElement[0].item.offers.price=900;
 const controller=new AbortController();let calls=0;
 await assert.rejects(collect({signal:controller.signal,pause:async()=>{},transport:async(url,options)=>{
  calls++;assert.equal(options!.signal,controller.signal);
  if(String(url)===SEARCH_URL)return response(render(d,l));
  controller.abort();throw Error('network aborted');
 }}),error=>{
  assert.ok(error instanceof RunTimeoutError);assert.equal(error.category,'RUN_TIMEOUT');
  const {elapsedMs,...progress}=error.progress;
  assert.ok(Number.isFinite(elapsedMs)&&elapsedMs>=0);
  assert.deepEqual(progress,{phase:'details',order:'desc',pages:1,detailCandidates:1,detailsCompleted:0});
  return true;
 });
 assert.equal(calls,2);
});
test('runner rejects invalid source budgets before acquiring a lease',async()=>{
 const {runFunda}=require('../scripts/funda-runner.cjs');
 for(const runTimeoutMs of [0,999,-1,300001,Infinity,NaN,1000.5]){
  await assert.rejects(runFunda({}, {}, {destination:'-123',definition:{SOURCE_ID,SEARCH_URL,FILTERS:{},runTimeoutMs}}),/RUN_BUDGET_INVALID/);
 }
});
const clock = new Date('2026-10-19T12:00:00.000Z');
function pageHtml(page:number, ids:number[], price=900, metadata:Record<string,unknown>={}) {
 const {d,l}=single(); const property=d.searchPropertiesData.data[0], card=l.mainEntity.itemListElement[0];
 d.listingsParams.page=String(page);
 d.searchPropertiesData.data=ids.map(id=>({...structuredClone(property),id:String(id),attributes:{...property.attributes,slug:`home-p${id}`,monthlyRent:price}}));
 d.searchPropertiesData.meta.pagination={currentPage:page,perPage:21,totalCount:999,totalPages:999,...metadata};
 l.url=page===1?SEARCH_URL:SEARCH_URL+'&page='+page;
 l.mainEntity.itemListElement=ids.map(id=>{const item=structuredClone(card);item.url=item.item.url=item.item.offers.url=`https://rentola.nl/en/listings/home-p${id}`;item.item.offers.price=price;return item;});
 return render(d,l);
}
const range=(start:number,count=21)=>Array.from({length:count},(_,i)=>start+i);
function transportFor(pages:Record<number,string>, calls:string[]=[], description?:string):typeof fetch {
 const items=Object.values(pages).flatMap(body=>parseSearch(body,Number(state(body).listingsParams.page)).listings);
 return async url=>{
  const u=new URL(String(url));calls.push(u.href);
  if(u.pathname==='/en/rent') {const body=pages[Number(u.searchParams.get('page')??1)];assert.ok(body,'Unexpected search '+u.href);return response(body);}
  const item=items.find(x=>x.canonicalUrl===u.href);assert.ok(item);return response(detail(item,description));
 };
}
async function seed(settings=defaults) {
 const pages={1:pageHtml(1,[1])};
 return (await collect({settings,now:clock,pause:async()=>{},transport:transportFor(pages)})).collectionState;
}
test('count and totalPages never determine validity or end of the crawl',async()=>{
 const a=pageHtml(1,range(1),900,{totalCount:1,totalPages:0});
 const b=pageHtml(2,[22],900,{totalCount:'invalid',totalPages:null});
 const r=await collect({settings:{...defaults,maxRent:1},pause:async()=>{},transport:transportFor({1:a,2:b})});
 assert.equal(r.inspected,22);assert.equal(r.pages,2);assert.equal(r.mode,'full');assert.equal(r.coverage,'catalog');
 assert.equal(r.listings.length,0);
});
test('normal run fetches exactly two full search pages in newest order',async()=>{
 const previousState=await seed();const calls:string[]=[];
 const result=await collect({now:clock,previousState,pause:async()=>{},transport:transportFor({1:pageHtml(1,range(1)),2:pageHtml(2,range(22))},calls)});
 assert.equal(result.mode,'head');assert.equal(result.coverage,'head');assert.equal(result.inspected,42);
 assert.deepEqual(calls.filter(x=>x.includes('/en/rent?')),[SEARCH_URL,SEARCH_URL+'&page=2']);
 assert.equal(result.diagnostics.detailsReused,1);assert.equal(result.diagnostics.detailsCompleted,41);
 assert.equal(result.collectionState.lastFullScanAt,previousState.lastFullScanAt);
});
test('unchanged accepted and rejected descriptions survive restart and are reused',async()=>{
 const calls:string[]=[];const pages={1:pageHtml(1,[1,2])};
 const t:typeof fetch=async url=>{calls.push(String(url));if(String(url)===SEARCH_URL)return response(pages[1]);
  const item=parseSearch(pages[1]).listings.find(x=>x.canonicalUrl===String(url))!;
  return response(detail(item,item.externalId==='1'?undefined:'Een studentenkamer met gedeelde keuken.'));};
 const first=await collect({now:clock,pause:async()=>{},transport:t});assert.equal(first.listings.length,1);
 calls.length=0;
 const restored=readCollectionState(JSON.parse(JSON.stringify(first.collectionState)));assert.ok(restored);
 const next=await collect({now:new Date(clock.getTime()+900000),previousState:restored,pause:async()=>{},transport:t});
 assert.deepEqual(calls,[SEARCH_URL]);assert.deepEqual(next.listings.map(x=>x.externalId),['1']);
 assert.equal(next.diagnostics.detailsReused,2);assert.equal(next.diagnostics.detailsCompleted,0);
});
test('new and changed candidates get fresh details while unchanged ones are reused',async()=>{
 const previousState=await seed();const calls:string[]=[];
 const next=await collect({now:clock,previousState,pause:async()=>{},transport:transportFor({1:pageHtml(1,[1,2],950)},calls)});
 assert.equal(next.diagnostics.detailsCompleted,2);assert.equal(next.diagnostics.detailsReused,0);
 assert.equal(next.listings[0]!.rentPrice,950);
});
test('daily full scan finds deep candidates, rechecks descriptions and prunes absent cache',async()=>{
 const previousState=await seed();const calls:string[]=[];
 const r=await collect({now:new Date(clock.getTime()+FULL_SCAN_INTERVAL_MS),previousState,pause:async()=>{},
  transport:transportFor({1:pageHtml(1,range(2)),2:pageHtml(2,range(23)),3:pageHtml(3,[99])},calls,'Een studentenkamer.')});
 assert.equal(r.mode,'full');assert.equal(r.pages,3);assert.equal(r.inspected,43);
 assert.equal(r.diagnostics.detailsCompleted,43);assert.equal(r.listings.length,0);
 assert.equal(r.collectionState.observations['1'],undefined);
 assert.equal(r.collectionState.observations['99']!.accepted,false);
 assert.notEqual(r.collectionState.lastFullScanAt,previousState.lastFullScanAt);
});
test('filter changes and explicit baseline force a full scan with fresh descriptions',async()=>{
 const previousState=await seed();
 for(const extra of [{settings:{...defaults,maxRent:1400}},{forceFull:true}]) {
  const result=await collect({now:clock,previousState,...extra,pause:async()=>{},transport:transportFor({1:pageHtml(1,[1])})});
  assert.equal(result.mode,'full');assert.equal(result.diagnostics.detailsCompleted,1);
 }
 assert.equal(readCollectionState({version:100}),undefined);
});
test('cross-page overlap is deduplicated, latest availability invalidates the cache',async()=>{
 const previousState=await seed();const next=pageHtml(2,[21,22]);const d=state(next),l=ld(next);
 l.mainEntity.itemListElement[0].item.offers.availability='https://schema.org/OutOfStock';
 const r=await collect({now:clock,previousState,pause:async()=>{},transport:transportFor({1:pageHtml(1,range(1)),2:render(d,l)})});
 assert.equal(r.inspected,22);assert.equal(r.diagnostics.duplicates,1);
 assert.equal(r.listings.some(x=>x.externalId==='21'),false);
 assert.equal(r.collectionState.observations['21'],undefined);
});
test('a later excluded category overrides an earlier qualifying card',async()=>{
 const second=pageHtml(2,[21,22]);const d=state(second),l=ld(second);
 d.searchPropertiesData.data[0].attributes.propertyType='room';
 const r=await collect({now:clock,pause:async()=>{},transport:transportFor({1:pageHtml(1,range(1)),2:render(d,l)})});
 assert.equal(r.listings.some(x=>x.externalId==='21'),false);
});
test('unavailable then available must be validated again before admission',async()=>{
 const previousState=await seed();const body=pageHtml(1,[1]),l=ld(body);
 l.mainEntity.itemListElement[0].item.offers.availability='https://schema.org/OutOfStock';
 const unavailable=await collect({now:clock,previousState,pause:async()=>{},transport:transportFor({1:render(state(body),l)})});
 assert.equal(unavailable.collectionState.observations['1'],undefined);
 const available=await collect({now:clock,previousState:unavailable.collectionState,pause:async()=>{},transport:transportFor({1:body})});
 assert.equal(available.diagnostics.detailsCompleted,1);
});
test('empty trailing page requires filter echo and matching empty JSON-LD; empty first page remains unconfirmed',async()=>{
 const empty=pageHtml(2,[],900,{currentPage:1});const d=state(empty);delete d.searchPropertiesData.included;
 const r=await collect({settings:{...defaults,maxRent:1},pause:async()=>{},transport:transportFor({1:pageHtml(1,range(1)),2:render(d,ld(empty))})});
 assert.equal(r.inspected,21);assert.equal(r.pages,2);
 assert.throws(()=>parseSearch(pageHtml(1,[])),/EMPTY_SEARCH_UNCONFIRMED/);
 assert.throws(()=>parseSearch(render(d,ld(pageHtml(1,[]))),2),/SEARCH_STRUCTURE_CHANGED/);
});
test('repeated pages and page limit fail without advancing daily state',async()=>{
 const first=pageHtml(1,range(1)),repeated=pageHtml(2,range(1));
 await assert.rejects(collect({pause:async()=>{},transport:transportFor({1:first,2:repeated})}),/PAGINATION_LOOP/);
 let calls=0;
 await assert.rejects(collect({settings:{...defaults,maxRent:1},pause:async()=>{},transport:async url=>{
  calls++;const p=Number(new URL(String(url)).searchParams.get('page')??1);return response(pageHtml(p,range((p-1)*21+1)));
 }}),/PAGE_LIMIT/);assert.equal(calls,100);
});
test('cancellation during search prevents further requests',async()=>{
 const controller=new AbortController();let calls=0;
 await assert.rejects(collect({signal:controller.signal,pause:async()=>{controller.abort();},transport:async()=>{
  calls++;return response(pageHtml(1,range(1)));
 }}),/RUN_TIMEOUT/);assert.equal(calls,1);
});
test('detail requests are bounded to two and settle before a failed run returns',async()=>{
 const {d,l}=single();const p=structuredClone(d.searchPropertiesData.data[0]);p.id='999';p.attributes.slug='home-p999';
 d.searchPropertiesData.data.push(p);d.searchPropertiesData.data.forEach((x:any)=>x.attributes.monthlyRent=900);
 d.searchPropertiesData.meta.pagination.totalCount=2;
 const first=l.mainEntity.itemListElement[0];first.item.offers.price=900;
 const second=structuredClone(first);second.url=second.item.url=second.item.offers.url='https://rentola.nl/en/listings/home-p999';l.mainEntity.itemListElement.push(second);
 const body=render(d,l);const items=parseSearch(body).listings;let active=0,max=0;
 await assert.rejects(collect({pause:async()=>{},transport:async(url)=>{
  if(String(url)===SEARCH_URL)return response(body);
  active++;max=Math.max(max,active);
  try {await new Promise(resolve=>setTimeout(resolve,String(url)===items[0]!.canonicalUrl?1:15));
    return String(url)===items[0]!.canonicalUrl?new Response('',{status:403}):response(detail(items[1]));
  } finally {active--;}
 }}),/ACCESS_BLOCKED/);
 assert.equal(max,2);assert.equal(active,0);
});
test('HTTP failures, timeouts, redirects and oversized bodies never become empty success',async()=>{
 for(const [status,category] of [[302,'HTTP_STATUS'],[403,'ACCESS_BLOCKED'],[429,'RATE_LIMIT'],[500,'HTTP_STATUS']] as const) await assert.rejects(collect({transport:async()=>new Response('',{status})}),new RegExp(category));
 await assert.rejects(collect({signal:AbortSignal.abort()}),/RUN_TIMEOUT/);
 await assert.rejects(collect({transport:async()=>Response.json({})}),/CONTENT_TYPE/);
 await assert.rejects(collect({pause:async()=>{},transport:async()=>{throw Error('network')}}),/HTTP_TRANSPORT/);
 await assert.rejects(collect({transport:async()=>response(' '.repeat(8*1024*1024+1))}),/BODY_TOO_LARGE/);
 let calls=0;await assert.rejects(collect({pause:async()=>{},transport:async()=>{calls++;return new Response('',{status:503})}}),/HTTP_STATUS/);assert.equal(calls,3);
});
