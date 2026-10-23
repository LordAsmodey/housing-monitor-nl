import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseSearch,parseCard,parseDetail,parseFeed,collect,distanceKm,allowedDetailUrl,SOURCE_ID,FEED_URL,SEARCH_URL} from '../src/sources/ikwilhuren-core';
const fixture = ()=>JSON.parse(readFileSync('test/fixtures/ikwilhuren.json','utf8'));
const registry = require('../scripts/search-settings.cjs');
const single = (card:string)=>'<link rel="canonical" href="https://ikwilhuren.nu/aanbod/"/>'+('<span class="text-blue-ncs">1</span> huurwoningen'.repeat(2))+card;
test('real nationwide HTML validates total, all pager links and card metadata',()=>{
  const r=parseSearch(fixture().search);assert.equal(r.total,960);assert.equal(r.pages,96);assert.equal(r.listings.length,10);
  assert.equal(r.listings[0]!.rentPrice,1995);assert.equal(r.listings[0]!.city,'Amsterdam');assert.equal(r.listings[0]!.availabilityStatus,'available');
  const f=fixture();const card=parseCard(f.card);const d=parseDetail(f.detail,card);
  assert.equal(d.independent,true);assert.equal(d.item.address,'Oosterhamrikkade 119 17');assert.equal(d.item.rentPrice,1053);assert.equal(d.item.areaM2,56);assert.ok(distanceKm(d.lat,d.lng)<2);
});
test('incomplete pages, wrong counters, current page and broken pagination fail closed',()=>{
  const s=fixture().search;
  for(const x of [s.replace('>960<','>959<'),s.replace('aria-current="page"','data-current="page"'),s.replace('Pagina 96','Pagina 95'),s.replace('card-woning','missing-card'),s.replace('>960<','>0<'),s.replace('https://ikwilhuren.nu/aanbod/','https://evil.test/')]) assert.throws(()=>parseSearch(x));
  assert.throws(()=>parseSearch(s,2));
});
test('availability requires explicit rental status and valid calendar date',()=>{
  const f=fixture();
  for(const value of ['Gereserveerd','Verhuurd','Verhuurd onder voorbehoud','Onder optie']) assert.equal(parseCard(f.card.replace('Te huur',value)).availabilityStatus,'unavailable');
  assert.equal(parseCard(f.card.replace('Te huur','Nieuw status')).availabilityStatus,'unknown');
  assert.equal(parseCard(f.card.replace('31-10-2026','31-02-2026')).availabilityStatus,'unknown');
  assert.equal(parseDetail(f.detail.replace(/(<td>\s*)Te huur(\s*<\/td>)/,'$1Gereserveerd$2'),parseCard(f.card)).item.availabilityStatus,'unavailable');
});
test('details verify identity, price, area and independent housing',()=>{
  const f=fixture(),card=parseCard(f.card);
  const rounded=parseDetail(f.detail.replaceAll('1.053,-','1.053,48').replace('56 m','55 m'),card);
  assert.equal(rounded.item.rentPrice,1053.48);assert.equal(rounded.item.areaM2,55);
  for(const value of [f.detail.replaceAll('1.053','1.054'),f.detail.replaceAll('Oosterhamrikkade 119 17','Other address'),f.detail.replace('data-lat','data-old-lat')]) assert.throws(()=>parseDetail(value,card));
  assert.equal(parseDetail(f.detail.replaceAll('(Appartement)','(Studentenkamer)'),card).independent,false);
  for (const phrase of ['gedeelde keuken','gedeeld sanitair','shared kitchen','shared bathroom','kamer te huur']) assert.equal(parseDetail(f.detail.replace('Goud wonen',phrase+'. Goud wonen'),card).independent,false);
});
test('map feed validates identity and coordinates; radius includes nearby towns and excludes distant cities',()=>{
  const f=fixture();assert.equal(parseFeed(f.feed).size,1);assert.ok(distanceKm(53.162,6.377)<30);assert.ok(distanceKm(52.1,5.1)>30);
  for(const mutate of [(x:any)=>Object.values<any>(x)[0].Lat='0',(x:any)=>Object.values<any>(x)[0].UUId='a'.repeat(32),(x:any)=>x['9']=Object.values(x)[0]]) { const x=fixture().feed;mutate(x);assert.throws(()=>parseFeed(x)); }
  const url=parseCard(f.card).canonicalUrl;assert.equal(allowedDetailUrl(url),url);
  for(const u of [url.replace('https:','http:'),url.replace('ikwilhuren.nu','evil.test'),url+'?x=y',url+'#fragment']) assert.throws(()=>allowedDetailUrl(u));
});
test('collector resolves missing map markers from detail, applies local filters and never notifies unknown availability',async()=>{
  const f=fixture();const calls:string[]=[];
  const transport=async(url:any)=>{calls.push(url);return new Response(url===FEED_URL?JSON.stringify(f.feed):url===SEARCH_URL?single(f.card):f.detail,{headers:{'content-type':url===FEED_URL?'application/json':'text/html'}})};
  const r=await collect({transport,pause:async()=>{}});assert.equal(r.listings.length,1);assert.equal(r.available,1);assert.equal(calls.length,3);
  const filtered=await collect({settings:{...registry.defaults(SOURCE_ID),maxRent:1000},transport,pause:async()=>{}});assert.equal(filtered.listings.length,0);
  const far=await collect({transport:async(url:any)=>url===FEED_URL||url===SEARCH_URL?transport(url):new Response(f.detail.replace('53.23109692','52.1'),{headers:{'content-type':'text/html'}}),pause:async()=>{}});assert.equal(far.listings.length,0);
});
test('HTTP errors, limits, redirects, challenge and malformed JSON fail',async()=>{
  for(const status of [302,401,403,429,500]) await assert.rejects(collect({transport:async()=>new Response('',{status}),pause:async()=>{}}));
  await assert.rejects(collect({transport:async()=>new Response('no json',{headers:{'content-type':'application/json'}}),pause:async()=>{}}));
  await assert.rejects(collect({signal:AbortSignal.abort(),transport:async()=>{throw Error('must not fetch')}}),/RUN_TIMEOUT/);
  await assert.rejects(collect({transport:async()=>new Response(' '.repeat(8*1024*1024+1),{headers:{'content-type':'application/json'}})}),/BODY_TOO_LARGE/);
});
test('missing area stays unknown; bedrooms never become area or room count',()=>{
  const f=fixture();const card=f.card.replace(/<span>56 m<sup>2<\/sup><\/span>/,'');
  const item=parseCard(card);assert.equal(item.areaM2,undefined);assert.equal(item.rooms,undefined);
  assert.equal(registry.matches({...registry.defaults(SOURCE_ID),minArea:20},item,SOURCE_ID),false);
});
test('complete pagination checks totals and duplicate identities before local price filtering',async()=>{
  const f=fixture();
  const page=(n:number)=>f.search.replaceAll('>960<','>20<').replace(/<ul class="pagination[\s\S]*?<\/ul>/,'<ul class="pagination">'+[1,2].map(i=>`<li><a href="/aanbod/?page=${i}" aria-label="Pagina ${i}"${n===i?' aria-current="page"':''}>${i}</a></li>`).join('')+'</ul>').replace('href="https://ikwilhuren.nu/aanbod/"',`href="https://ikwilhuren.nu/aanbod/${n===1?'':'?page=2'}"`);
  const transport = async (url:any)=>new Response(url===FEED_URL?JSON.stringify(f.feed):page(url===SEARCH_URL?1:2),{headers:{'content-type':url===FEED_URL?'application/json':'text/html'}});
  await assert.rejects(collect({transport,pause:async()=>{}}),/DUPLICATE_CARD/);
  await assert.rejects(collect({transport:async(url:any)=>url===SEARCH_URL+'?page=2'?new Response(page(2).replaceAll('>20<','>19<'),{headers:{'content-type':'text/html'}}):transport(url),pause:async()=>{}}));
});
test('real rounded card uses exact detail rent and area; non-housing details need no map coordinates',()=>{
  const f=fixture();const d=parseDetail(f.rounded.detail,parseCard(f.rounded.card));
  assert.equal(d.item.rentPrice,847.48);assert.equal(d.item.areaM2,45);
  assert.equal(parseDetail(f.parking.detail,parseCard(f.parking.card)).independent,false);
});
test('explicitly unavailable search cards are excluded without following archived-detail redirects',async()=>{
  const f=fixture();let calls=0;
  const r=await collect({pause:async()=>{},transport:async(url:any)=>{calls++;assert.ok(url===FEED_URL||url===SEARCH_URL);return new Response(url===FEED_URL?JSON.stringify(f.feed):single(f.card.replace('Te huur','Gereserveerd')),{headers:{'content-type':url===FEED_URL?'application/json':'text/html'}})}});
  assert.equal(r.inspected,1);assert.equal(r.listings.length,0);assert.equal(calls,2);
});
