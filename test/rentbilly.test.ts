import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseSearch,parseDetail,collect,pageUrl,allowedDetailUrl,SOURCE_ID,SEARCH_URL} from '../src/sources/rentbilly-core';
const registry = require('../scripts/search-settings.cjs');
const defaults = registry.defaults(SOURCE_ID);
const fixture = (name = 'page1') => JSON.parse(readFileSync(`test/fixtures/rentbilly-${name}.json`,'utf8'));
function render(data:any) {const {ld,...flight}=data;return `<script type="application/ld+json">${JSON.stringify(ld)}</script><script>self.__next_f.push(${JSON.stringify([1,JSON.stringify(flight)])})</script>`;}
const response = (s:string) => new Response(s,{headers:{'content-type':'text/html'}});
function single() {
 const d=fixture();d.searchPropertiesData.data=d.searchPropertiesData.data.slice(0,1);
 d.searchPropertiesData.meta.pagination={currentPage:1,totalPages:1,totalCount:1,perPage:21};
 d.ld.mainEntity.itemListElement=d.ld.mainEntity.itemListElement.slice(0,1);return d;
}
const item=()=>parseSearch(render(single())).listings[0]!;
test('real pages validate filters, geography, count and exclude a room labelled studio',()=>{
 const results=[1,2,3,4].map(p=>parseSearch(render(fixture(`page${p}`)),p));
 assert.equal(results.reduce((n,r)=>n+r.ids.length,0),84);
 assert.equal(results[0]!.listings.length,20);assert.ok(!results[0]!.listings.some(x=>x.title.includes('Mooie kamer')));
 assert.equal(results[1]!.listings.find(x=>x.externalId==='40022674')!.areaM2,undefined);
 assert.deepEqual(defaults,{minRent:0,maxRent:1500,minArea:20});assert.equal(pageUrl(),SEARCH_URL);
 assert.equal(new URL(pageUrl(2)).searchParams.get('page'),'2');
 const url=new URL(pageUrl(1,{...defaults,minRent:500,maxRent:1200,minArea:30}));
 assert.equal(url.searchParams.get('rent'),'500-1200');assert.equal(url.searchParams.get('size'),'30');
 assert.equal(new URL(pageUrl(1,{...defaults,minArea:null})).searchParams.has('size'),false);
});
test('real detail matches card, rejects common facilities and fails closed on changed metadata',()=>{
 const card=item();const d=fixture('detail');assert.equal(parseDetail(render(d),card)?.availabilityStatus,'available');
 for(const desc of ['', 'Een kamer.', 'Gedeelde keuken en badkamer.', 'De badkamer wordt gedeeld.', 'Shared bathroom.', 'Onzelfstandige woonruimte.']) {
  const copy=structuredClone(d);copy.propertyAttributes.desc=desc;assert.equal(parseDetail(render(copy),card),undefined);
 }
 const unknown=structuredClone(d);unknown.propertyAttributes.status='mystery';assert.equal(parseDetail(render(unknown),card)?.availabilityStatus,'unknown');
 unknown.propertyAttributes.status='inactive';assert.equal(parseDetail(render(unknown),card)?.availabilityStatus,'unavailable');
 for(const mutate of [(x:any)=>x.propertyAttributes.monthlyRent=1,(x:any)=>x.propertyAttributes.estimatedArea=true,
  (x:any)=>x.ld.offers.itemOffered.address.addressLocality='Assen',(x:any)=>x.ld.offers.priceCurrency='USD',
  (x:any)=>x.propertyAttributes.countryCode='be',(x:any)=>x.propertyAttributes.area='58']) {
  const copy=structuredClone(d);mutate(copy);assert.throws(()=>parseDetail(render(copy),card));
 }
});
test('corrupt search, incomplete pages, duplicates and unconfirmed empty searches fail',()=>{
 for(const mutate of [(x:any)=>x.listingsParams.location='assen',(x:any)=>x.listingsParams.priceMax='1501',
  (x:any)=>x.listingsParams.sizeMin='19',(x:any)=>x.listingsParams.propertyType.push('room'),
  (x:any)=>x.searchPropertiesData.meta.pagination.currentPage=2,(x:any)=>x.searchPropertiesData.meta.pagination.totalCount=20,
  (x:any)=>x.searchPropertiesData.data.pop(),(x:any)=>x.searchPropertiesData.data[1]=x.searchPropertiesData.data[0],
  (x:any)=>x.searchPropertiesData.data[0].relationships.city.data.id='1',(x:any)=>x.ld.mainEntity.itemListElement[0].item.offers.price=1,
  (x:any)=>x.ld.mainEntity.itemListElement[0].item.offers.itemOffered.floorSize.value=1]) {
  const d=fixture();mutate(d);assert.throws(()=>parseSearch(render(d)));
 }
 const empty=single();empty.searchPropertiesData.data=[];assert.throws(()=>parseSearch(render(empty)),/EMPTY_SEARCH_UNCONFIRMED/);
 assert.throws(()=>parseSearch('Access denied'),/ACCESS_BLOCKED/);assert.throws(()=>parseSearch(''),/SEARCH_STRUCTURE_CHANGED/);
});
test('collector validates full scan and cannot persist a partial or changed result',async()=>{
 const d=single();const transport:typeof fetch=async(u,o)=>{
  assert.equal(o!.redirect,'manual');return response(String(u).includes('/listings/')?render(fixture('detail')):render(d));
 };
 const r=await collect({transport,pause:async()=>{}});assert.equal(r.inspected,1);assert.equal(r.listings.length,1);
 let calls=0;await collect({settings:{...defaults,minArea:100},pause:async()=>{},transport:async()=>{
  calls++;const x=single();x.listingsParams.sizeMin='100';x.ld.url=pageUrl(1,{...defaults,minArea:100});return response(render(x));
 }});assert.equal(calls,1);
 await assert.rejects(collect({pause:async()=>{},transport:async(u)=>{
  if(String(u).endsWith('page=2')) {const x=fixture('page2');x.searchPropertiesData.meta.pagination.totalCount=83;return response(render(x));}
  return response(render(fixture()));
 }}),/SEARCH_CHANGED_DURING_RUN/);
 await assert.rejects(collect({pause:async()=>{},transport:async(u)=>String(u).includes('/listings/')?new Response('',{status:503}):response(render(d))}),/HTTP_STATUS/);
});
test('network errors, rate limits, redirects, timeouts and URL boundaries fail closed',async()=>{
 for(const [status,category] of [[403,'ACCESS_BLOCKED'],[429,'RATE_LIMIT'],[302,'HTTP_STATUS']] as const) {
  await assert.rejects(collect({transport:async()=>new Response('',{status}),pause:async()=>{}}),new RegExp(category));
 }
 await assert.rejects(collect({transport:async()=>new Response('{}',{headers:{'content-type':'application/json'}}),pause:async()=>{}}),/CONTENT_TYPE/);
 await assert.rejects(collect({transport:async()=>{throw Error('network')},pause:async()=>{}}),/HTTP_TRANSPORT/);
 await assert.rejects(collect({signal:AbortSignal.abort(),pause:async()=>{}}),/RUN_TIMEOUT/);
 for(const url of ['https://evil.test/en/listings/home-p123abc','http://rentbilly.nl/en/listings/home-p123abc','https://user@rentbilly.nl/en/listings/home-p123abc','/en/listings/home-p123abc?q=1','/en/listings/home-p123abc#x','/en/listings/home']) assert.throws(()=>allowedDetailUrl(url));
});
