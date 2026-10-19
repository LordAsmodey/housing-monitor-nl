import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseSearch,parseDetail,collect,independentHousing,allowedDetailUrl,SOURCE_ID,SEARCH_URL,SearchChangedError,RunTimeoutError,RUN_TIMEOUT_MS} from '../src/sources/rentola-core';
const registry = require('../scripts/search-settings.cjs');
const fixture = (name = 'search') => readFileSync(`test/fixtures/rentola-${name}.html`,'utf8');
const defaults = registry.defaults(SOURCE_ID);
function state(html = fixture()) {return JSON.parse(JSON.parse(html.match(/push\((\[.*\])\)/)![1]!)[1]);}
function ld(html = fixture()) {return JSON.parse(html.match(/type="application\/ld\+json">(.*?)<\/script>/)![1]!);}
function render(data:any, schema = ld()) {return `<script type="application/ld+json">${JSON.stringify(schema)}</script><script>self.__next_f.push(${JSON.stringify([1,JSON.stringify(data)])})</script>`;}
function withOrder(html:string, order:string) {
 const d=state(html), l=ld(html);d.listingsParams.order=order;
 const url=new URL(l.url);url.searchParams.set('order',order);l.url=url.href;
 return render(d,l);
}
function single() {
  const d=state(); d.searchPropertiesData.data=d.searchPropertiesData.data.slice(0,1);
  d.searchPropertiesData.meta.pagination={currentPage:1,totalPages:1,totalCount:1,perPage:21};
  const l=ld(); l.mainEntity.itemListElement=l.mainEntity.itemListElement.slice(0,1);
  return {d,l};
}
const response = (body:string) => new Response(body,{headers:{'content-type':'text/html'}});
const detail = (item:any, description='Een zelfstandig appartement met eigen keuken en badkamer.') => `<script type="application/ld+json">${JSON.stringify({'@type':'RealEstateListing',url:item.canonicalUrl,name:item.title,description,offers:{price:item.rentPrice,priceCurrency:'EUR',availability:'https://schema.org/InStock',itemOffered:{address:{addressLocality:'Groningen'}}}})}</script>`;
test('real first and last page validate count, geography and modern/legacy URLs',()=>{
 const a=parseSearch(fixture()); const b=parseSearch(fixture('last'),14);
 assert.equal(a.totalCount,285); assert.equal(a.totalPages,14); assert.equal(a.ids.length,21); assert.equal(b.ids.length,12);
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
test('corrupt filters, count, partial data, metadata and duplicates fail closed',()=>{
 const mutations=[(d:any)=>d.listingsParams.location='1',(d:any)=>d.listingsParams.priceMax='1500',
 (d:any)=>d.listingsParams.order='asc',(d:any)=>d.listingsParams.page='2',
 (d:any)=>d.searchPropertiesData.meta.pagination.totalCount=300,(d:any)=>d.searchPropertiesData.data.pop(),
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
test('default Rentola deadline covers a bounded full restart and remains cancellable',async t=>{
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
test('collector validates all pages and refuses overlapping or changing results',async()=>{
 const {d,l}=single();d.searchPropertiesData.data=Array(21).fill(null).map((_,i)=>({...d.searchPropertiesData.data[0],id:String(100+i),attributes:{...d.searchPropertiesData.data[0].attributes,slug:`home-p${i}`}}));
 l.mainEntity.itemListElement=d.searchPropertiesData.data.map((p:any)=>({url:`https://rentola.nl/en/listings/${p.attributes.slug}`,item:{...l.mainEntity.itemListElement[0].item,url:`https://rentola.nl/en/listings/${p.attributes.slug}`,offers:{...l.mainEntity.itemListElement[0].item.offers,url:`https://rentola.nl/en/listings/${p.attributes.slug}`}}}));
 d.searchPropertiesData.meta.pagination={currentPage:1,totalPages:2,totalCount:22,perPage:21};const first=render(d,l);
 const last=structuredClone(d);last.listingsParams.page='2';last.searchPropertiesData.data=[d.searchPropertiesData.data[0]];last.searchPropertiesData.meta.pagination.currentPage=2;
 const lastLd=structuredClone(l);lastLd.url=SEARCH_URL+'&page=2';lastLd.mainEntity.itemListElement=[l.mainEntity.itemListElement[0]];
 await assert.rejects(collect({pause:async()=>{},transport:async(url)=>response(String(url)===SEARCH_URL?first:render(last,lastLd))}),/DUPLICATE_CARD/);
 last.searchPropertiesData.meta.pagination.totalCount=23;last.searchPropertiesData.data.push({...last.searchPropertiesData.data[0],id:'999',attributes:{...last.searchPropertiesData.data[0].attributes,slug:'home-p999'}});lastLd.mainEntity.itemListElement.push({...lastLd.mainEntity.itemListElement[0],url:'https://rentola.nl/en/listings/home-p999',item:{...lastLd.mainEntity.itemListElement[0].item,url:'https://rentola.nl/en/listings/home-p999',offers:{...lastLd.mainEntity.itemListElement[0].item.offers,url:'https://rentola.nl/en/listings/home-p999'}}});
 const requests:string[]=[];
 await assert.rejects(collect({pause:async()=>{},transport:async(url)=>{
  requests.push(String(url));const u=new URL(String(url));
  return response(withOrder(u.searchParams.has('page')?render(last,lastLd):first,u.searchParams.get('order')!));
 }}), error => {
  assert.ok(error instanceof SearchChangedError);
  assert.equal(error.category,'SEARCH_CHANGED_DURING_RUN');
  assert.equal(error.page,2);
  assert.deepEqual(error.expected,{totalCount:22,totalPages:2});
  assert.deepEqual(error.actual,{totalCount:23,totalPages:2});
  assert.equal(error.order,'rent_asc');
  return true;
 });
 assert.equal(requests.length,4); // One full restart, never an unbounded retry.
});
test('price-order parsing requires the exact sort echo and JSON-LD URL',()=>{
 const sorted=withOrder(fixture(),'rent_asc');
 assert.equal(parseSearch(sorted,1,'rent_asc').totalCount,285);
 assert.throws(()=>parseSearch(sorted),/SEARCH_FILTER_CHANGED/);
 assert.throws(()=>parseSearch(fixture(),1,'rent_asc'),/SEARCH_FILTER_CHANGED/);
 const d=state(sorted),l=ld(sorted);l.url=SEARCH_URL;
 assert.throws(()=>parseSearch(render(d,l),1,'rent_asc'),/SEARCH_STRUCTURE_CHANGED/);
 assert.throws(()=>parseSearch(withOrder(fixture(),'rent_desc'),1,'rent_desc' as any),/SEARCH_FILTER_CHANGED/);
});
function recoverableSearch() {
 const d=state(),l=ld();d.searchPropertiesData.meta.pagination={currentPage:1,totalPages:2,totalCount:22,perPage:21};
 const next=state(fixture('last')),nextLd=ld(fixture('last'));
 next.listingsParams.page='2';next.searchPropertiesData.data=next.searchPropertiesData.data.slice(0,1);
 next.searchPropertiesData.meta.pagination={currentPage:2,totalPages:2,totalCount:22,perPage:21};
 nextLd.url=SEARCH_URL+'&page=2';nextLd.mainEntity.itemListElement=nextLd.mainEntity.itemListElement.slice(0,1);
 const first=render(d,l),last=render(next,nextLd);
 // A mismatch crossing the page-count boundary, as in the production incident.
 d.searchPropertiesData.meta.pagination={currentPage:1,totalPages:3,totalCount:43,perPage:21};
 return {first,last,stale:render(d,l)};
}
test('inconsistent newest search is discarded; complete price-order scan validates before details',async()=>{
 const {first,last,stale}=recoverableSearch();const requests:string[]=[];const pauses:number[]=[];
 const signal=new AbortController().signal;
 const valid=parseSearch(first).listings;
 const result=await collect({signal,pause:async ms=>{pauses.push(ms);},transport:async(url,options)=>{
  assert.equal(options!.signal,signal);const u=new URL(String(url));requests.push(u.href);
  if(u.pathname.startsWith('/en/listings/')){
   assert.equal(requests.filter(x=>x.includes('/en/rent?')).length,4);
   const item=valid.find(x=>x.canonicalUrl===u.href);assert.ok(item);return response(detail(item));
  }
  const order=u.searchParams.get('order')!;
  const body=u.searchParams.has('page')?last:order==='desc'?stale:first;
  return response(withOrder(body,order));
 }});
 assert.deepEqual(requests.slice(0,4),[SEARCH_URL,SEARCH_URL+'&page=2',SEARCH_URL.replace('order=desc','order=rent_asc'),SEARCH_URL.replace('order=desc','order=rent_asc')+'&page=2']);
 assert.equal(pauses.filter(ms=>ms===1000).length,1);
 assert.equal(result.inspected,22);assert.equal(result.total,22);assert.equal(result.pages,2);
 assert.equal(result.searchOrder,'rent_asc');
 assert.deepEqual(result.recoveredFrom,{page:2,expected:{totalCount:43,totalPages:3},actual:{totalCount:22,totalPages:2}});
 // Only the first page has budget-matching candidates in these fixtures.
 const expected=valid.filter(x=>registry.matches(defaults,x,SOURCE_ID)&&x.availabilityStatus==='available');
 assert.deepEqual(result.listings.map(x=>x.externalId),expected.map(x=>x.externalId));
});
test('restart uses the original deadline and cannot make requests after cancellation',async()=>{
 const {stale,last}=recoverableSearch();const controller=new AbortController();let calls=0;
 await assert.rejects(collect({signal:controller.signal,pause:async ms=>{if(ms===1000)controller.abort();},transport:async(url)=>{
  calls++;return response(String(url)===SEARCH_URL?stale:last);
 }}),/RUN_TIMEOUT/);
 assert.equal(calls,2);
});
test('invalid fallback pages still fail closed without another restart or detail requests',async()=>{
 const {stale,last}=recoverableSearch();const requests:string[]=[];
 await assert.rejects(collect({pause:async()=>{},transport:async(url)=>{
  const u=new URL(String(url));requests.push(u.href);
  if(u.searchParams.get('order')==='rent_asc')return response('Access denied');
  return response(u.searchParams.has('page')?last:stale);
 }}),/ACCESS_BLOCKED/);
 assert.equal(requests.length,3);
});
test('complete pagination succeeds without relying on matched count',async()=>{
 const d=state();const l=ld();d.searchPropertiesData.meta.pagination={currentPage:1,totalPages:2,totalCount:22,perPage:21};
 // Prices above a deliberately low budget avoid detail requests while still validating all cards.
 const next=state(fixture('last'));const nextLd=ld(fixture('last'));
 next.listingsParams.page='2';next.searchPropertiesData.data=next.searchPropertiesData.data.slice(0,1);
 next.searchPropertiesData.meta.pagination={currentPage:2,totalPages:2,totalCount:22,perPage:21};
 nextLd.url=SEARCH_URL+'&page=2';nextLd.mainEntity.itemListElement=nextLd.mainEntity.itemListElement.slice(0,1);
 let requests=0;
 const result=await collect({settings:{...defaults,maxRent:1},pause:async()=>{},transport:async(url)=>{
   requests++;return response(String(url)===SEARCH_URL?render(d,l):render(next,nextLd));
 }});
 assert.equal(requests,2);assert.equal(result.inspected,22);assert.equal(result.pages,2);assert.equal(result.listings.length,0);
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
