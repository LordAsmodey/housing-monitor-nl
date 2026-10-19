import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {collect,parseSearch,parseDetail,searchBody,detailUrl,SOURCE_ID,SEARCH_URL} from '../src/sources/gohome-core';
const registry=require('../scripts/search-settings.cjs');
const defaults=registry.defaults(SOURCE_ID);
const fixture=(name:string)=>JSON.parse(readFileSync(`test/fixtures/gohome-${name}.json`,'utf8'));
const card=()=>fixture('page1').properties[0];
const detail=()=>fixture('detail');
const response=(v:unknown)=>Response.json(v);
function transport(pages=[fixture('page1'),fixture('page2')],change=(d:any)=>d):typeof fetch {
 return async(_url,options)=>{
  if(options?.method==='POST')return response(pages[JSON.parse(String(options.body)).pageIndex]);
  const c=pages.flatMap(p=>p.properties).find(c=>String(_url).endsWith('/'+c.urlSlug));assert.ok(c);
  const d=detail();Object.assign(d,{id:c.propertyId,title:c.title,urlSlug:c.urlSlug,isRented:c.isRented});
  Object.assign(d.propertyDetails,{minimumRent:c.minimumRent});
  Object.assign(d.propertyFeatures,{livingArea:c.livingArea,noOfRooms:c.nrOfRooms});return response(change(d));
 };
}
test('GoHome decodes user URL filters and generates API search independently of session state',()=>{
 assert.deepEqual(defaults,{minRent:500,maxRent:1500,minArea:null});
 assert.deepEqual(JSON.parse(Buffer.from(new URL(SEARCH_URL).searchParams.get('f')!,'base64url').toString()),{location:'Groningen',minPrice:500,maxPrice:1500});
 assert.deepEqual(searchBody(1,{...defaults,maxRent:1200}),{teamId:1,pageIndex:1,pageSize:15,location:'Groningen',minPrice:500,maxPrice:1200});
 for(const page of [-1,100,0.5])assert.throws(()=>searchBody(page),/PAGE_LIMIT/);
 assert.throws(()=>detailUrl('../private'),/URL_NOT_ALLOWED/);
 assert.equal(parseSearch(fixture('empty')).totalPropertiesCount,0);
});
test('real details preserve advertised price, structured area/date and strict availability',()=>{
 const c=card(),d=detail();const item=parseDetail(d,c)!;
 assert.equal(item.externalId,'9128');assert.equal(item.rentPrice,1083);assert.equal(item.areaM2,100);
 assert.equal(item.availabilityStatus,'available');assert.equal(item.housingDetails?.availableFrom,'2026-11-16');
 assert.equal(item.serviceCosts,undefined); // no guessed description sums
 const second=fixture('detail2578');assert.equal(parseDetail(second,fixture('page1').properties[1])!.areaM2,undefined);
 d.isRented=c.isRented=true;assert.equal(parseDetail(d,c)!.availabilityStatus,'unavailable');
 d.isRented=c.isRented=null;assert.equal(parseDetail(d,c)!.availabilityStatus,'unknown');
 d.isRented=c.isRented=false;d.propertyDetails.published=false;assert.equal(parseDetail(d,c)!.availabilityStatus,'unavailable');
 d.propertyDetails.published=true;
 for(const type of ['ROOM','PARKING','UNKNOWN']){d.propertyDetails.type=type;assert.equal(parseDetail(d,c),null);}
 d.propertyDetails.type='APARTMENT';d.propertyDetails.description='Een studentenkamer met gedeelde keuken';assert.equal(parseDetail(d,c),null);
 d.propertyDetails.description='Een woning met 4 kamers. Delen toegestaan.';assert.ok(parseDetail(d,c));
 d.id=1;assert.throws(()=>parseDetail(d,c),/DETAIL_MISMATCH/);
});
test('full collection validates both pages and every detail; local area filter is conservative',async()=>{
 const result=await collect({transport:transport(),pause:async()=>{}});
 assert.equal(result.inspected,26);assert.equal(result.pages,2);assert.equal(result.listings.length,26);assert.equal(result.available,3);
 const filtered=await collect({settings:{...defaults,minArea:100},transport:transport(),pause:async()=>{}});
 assert.ok(filtered.listings.length<26);assert.ok(filtered.listings.every(x=>x.areaM2!>=100));
 assert.equal((await collect({transport:transport([fixture('empty')]),pause:async()=>{}})).inspected,0);
});
test('partial pages, count changes, duplicate identities, invalid filters and detail failures fail closed',async()=>{
 for(const mutate of [
  (p:any[])=>p[1].properties.pop(),
  (p:any[])=>p[1].totalPropertiesCount++,
  (p:any[])=>p[1].properties[0]=p[0].properties[0],
  (p:any[])=>p[0].properties[0].minimumRent=1501,
  (p:any[])=>p[0].properties[0].location='Amsterdam',
 ]){const pages=[fixture('page1'),fixture('page2')];mutate(pages);await assert.rejects(collect({transport:transport(pages),pause:async()=>{}}));}
 await assert.rejects(collect({transport:transport(undefined,d=>({...d,id:0})),pause:async()=>{}}),/STRUCTURE_CHANGED/);
 const d=detail();d.propertyDetails.availableFromDate='2026-02-30';assert.throws(()=>parseDetail(d,card()),/DATE_INVALID/);
});
test('HTTP failure, redirect, rate limit, body size and timeout cannot become successful zero',async()=>{
 for(const [status,category] of [[302,'HTTP_STATUS'],[403,'ACCESS_BLOCKED'],[429,'RATE_LIMIT'],[500,'HTTP_STATUS']] as const)
  await assert.rejects(collect({transport:async()=>new Response('',{status}),pause:async()=>{}}),new RegExp(category));
 await assert.rejects(collect({transport:async()=>new Response('<html>login</html>',{headers:{'content-type':'text/html'}})}),/CONTENT_TYPE/);
 await assert.rejects(collect({transport:async()=>new Response('x',{headers:{'content-type':'application/json'}})}),/INVALID_JSON/);
 await assert.rejects(collect({transport:async()=>new Response(' '.repeat(4*1024*1024+1),{headers:{'content-type':'application/json'}})}),/BODY_TOO_LARGE/);
 await assert.rejects(collect({signal:AbortSignal.abort()}),/RUN_TIMEOUT/);
 let attempts=0;const base=transport([fixture('empty')]);
 await collect({pause:async()=>{},transport:async(u,o)=>{assert.equal(o?.redirect,'manual');return ++attempts<3?new Response('',{status:503}):base(u,o);}});assert.equal(attempts,3);
});

test('late detail failure discards earlier findings and never returns partial results',async()=>{
 const base=transport();let details=0;
 await assert.rejects(collect({pause:async()=>{},transport:async(u,o)=>{
  if(o?.method==='GET'&&++details===26)return new Response('',{status:403});
  return base(u,o);
 }}),/ACCESS_BLOCKED/);
 assert.equal(details,26);
});
