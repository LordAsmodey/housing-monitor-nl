import 'reflect-metadata';
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PrismaService} from '../../src/database/prisma.service';
import {ListingsService} from '../../src/listings/listings.service';
import {runRentola} from '../../src/sources/rentola-runner';
import {collect, parseSearch, SOURCE_ID, SEARCH_URL, FULL_SCAN_INTERVAL_MS, type CollectOptions} from '../../src/sources/rentola-core';

assert.ok(process.env.DATABASE_URL,'Supply a disposable DATABASE_URL');
const db=new PrismaService(), listings=new ListingsService(db);
const jobs={listing:{sourceId:SOURCE_ID}};
let now=new Date('2026-10-19T12:00:00.000Z');
before(()=>db.$connect());
after(async()=>{
 await db.notificationOutbox.deleteMany({where:jobs});
 await db.housingListing.deleteMany({where:{sourceId:SOURCE_ID}});
 await db.monitoringRun.deleteMany({where:{sourceId:SOURCE_ID}});
 await db.siteProfile.deleteMany({where:{sourceId:SOURCE_ID}});
 await db.source.deleteMany({where:{id:SOURCE_ID}});
 await db.$disconnect();
});
function fixture(ids:number[]) {
 const html=readFileSync('test/fixtures/rentola-search.html','utf8');
 const data=JSON.parse(JSON.parse(html.match(/push\((\[.*\])\)/)![1]!)[1]);
 const ld=JSON.parse(html.match(/type="application\/ld\+json">(.*?)<\/script>/)![1]!);
 const p=data.searchPropertiesData.data[0],c=ld.mainEntity.itemListElement[0];
 data.searchPropertiesData.data=ids.map(id=>({...p,id:String(id),attributes:{...p.attributes,monthlyRent:900,slug:`home-p${id}`}}));
 ld.mainEntity.itemListElement=ids.map(id=>{const x=structuredClone(c);x.url=x.item.url=x.item.offers.url=`https://rentola.nl/en/listings/home-p${id}`;x.item.offers.price=900;return x;});
 return `<script type="application/ld+json">${JSON.stringify(ld)}</script><script>self.__next_f.push(${JSON.stringify([1,JSON.stringify(data)])})</script>`;
}
function collector(ids:number[],calls:string[]=[], fail=false) {
 const body=fixture(ids),items=parseSearch(body).listings;
 return async (options:CollectOptions)=>collect({...options,now,pause:async()=>{},transport:async url=>{
  calls.push(String(url));if(String(url)===SEARCH_URL)return new Response(body,{headers:{'content-type':'text/html'}});
  if(fail)return new Response('',{status:403});
  const item=items.find(x=>x.canonicalUrl===String(url));assert.ok(item);
  return new Response(`<script type="application/ld+json">${JSON.stringify({'@type':'RealEstateListing',url:item.canonicalUrl,name:item.title,
   description:item.externalId==='2'?'Een studentenkamer.':'Een zelfstandige woning met eigen keuken en badkamer.',
   offers:{price:900,priceCurrency:'EUR',availability:'https://schema.org/InStock',itemOffered:{address:{addressLocality:'Groningen'}}}})}</script>`,{headers:{'content-type':'text/html'}});
 }});
}
const due=()=>db.source.update({where:{id:SOURCE_ID},data:{nextCheckAt:new Date(0)}});
const state=()=>db.sourceCollectionState.findUniqueOrThrow({where:{sourceId:SOURCE_ID}});
const run=(ids:number[],calls:string[]=[])=>runRentola(db,listings,{destination:'-123',collector:collector(ids,calls)});

test('Rentola persists daily discovery and detail decisions atomically across runs, failures and filter changes',async()=>{
 // A failed initial fill must not create a baseline or a reusable decision.
 await assert.rejects(runRentola(db,listings,{destination:'-123',collector:collector([1,2],[],true)}),/ACCESS_BLOCKED/);
 assert.equal(await db.sourceCollectionState.count({where:{sourceId:SOURCE_ID}}),0);
 assert.equal((await db.source.findUniqueOrThrow({where:{id:SOURCE_ID}})).baselineAt,null);
 await due();const first=await run([1,2]);assert.equal((first as any).baseline,true);
 assert.equal(await db.notificationOutbox.count({where:jobs}),0);
 const initial=(await state()).state as any;
 assert.equal(initial.observations['1'].accepted,true);assert.equal(initial.observations['2'].accepted,false);
 assert.equal((await db.monitoringRun.findUniqueOrThrow({where:{id:(first as any).runId}})).collectionScope,'catalog');

 await due();const calls:string[]=[];const head=await run([1,2,3],calls);
 assert.equal(calls.filter(x=>x.includes('/en/listings/')).length,1);
 assert.equal(await db.notificationOutbox.count({where:jobs}),1);
 assert.equal((await db.monitoringRun.findUniqueOrThrow({where:{id:(head as any).runId}})).collectionScope,'head');
 assert.equal(((await state()).state as any).lastFullScanAt,initial.lastFullScanAt);
 await due();await run([1,2,3]);assert.equal(await db.notificationOutbox.count({where:jobs}),1);

 // Daily revalidation is driven by persisted time, not process uptime.
 now=new Date(now.getTime()+FULL_SCAN_INTERVAL_MS);await due();const dailyCalls:string[]=[];
 const daily=await run([1,2,3,4],dailyCalls);
 assert.equal(dailyCalls.filter(x=>x.includes('/en/listings/')).length,4);
 assert.equal((await db.monitoringRun.findUniqueOrThrow({where:{id:(daily as any).runId}})).collectionScope,'catalog');
 assert.equal(await db.notificationOutbox.count({where:jobs}),2);

 // A commit failure rolls back both decisions and outbox/listings.
 const before=(await state()).state;
 const faulty={recordValidatedRunInTransaction:async(...args:Parameters<ListingsService['recordValidatedRunInTransaction']>)=>{
  await listings.recordValidatedRunInTransaction(...args);throw Error('commit failure');
 }} as ListingsService;
 await due();await assert.rejects(runRentola(db,faulty,{destination:'-123',collector:collector([1,2,3,4,5])}),/RUN_FAILED/);
 assert.deepEqual((await state()).state,before);
 assert.equal(await db.housingListing.count({where:{sourceId:SOURCE_ID,externalId:'5'}}),0);
 assert.equal(await db.notificationOutbox.count({where:jobs}),2);

 // Lease expiry also prevents state from advancing.
 await due();await assert.rejects(runRentola(db,listings,{destination:'-123',collector:async options=>{
  const result=await collector([1,2,3,4,5])(options);
  await db.source.update({where:{id:SOURCE_ID},data:{monitorLeaseUntil:new Date(0)}});return result;
 }}),/LEASE_LOST/);
 assert.deepEqual((await state()).state,before);

 const search=await db.searchConfiguration.findUniqueOrThrow({where:{sourceId:SOURCE_ID}});
 await db.searchConfiguration.update({where:{sourceId:SOURCE_ID},data:{revision:{increment:1},filters:{...(search.filters as object),maxRent:1400}}});
 await due();const changedCalls:string[]=[];const changed=await run([1,2,3,4,5],changedCalls);
 assert.equal(changedCalls.filter(x=>x.includes('/en/listings/')).length,5);
 assert.equal((await db.monitoringRun.findUniqueOrThrow({where:{id:(changed as any).runId}})).collectionScope,'catalog');
 assert.equal(await db.notificationOutbox.count({where:jobs}),2); // quiet filter baseline
 const applied=await db.searchConfiguration.findUniqueOrThrow({where:{sourceId:SOURCE_ID}});
 assert.equal(applied.revision,applied.appliedRevision);
 await due();await run([1,2,3,4,5]);assert.equal(await db.notificationOutbox.count({where:jobs}),2);

 await db.searchConfiguration.update({where:{sourceId:SOURCE_ID},data:{enabled:false}});await due();
 const paused=await runRentola(db,listings,{destination:'-123',collector:async()=>{throw Error('must not collect');}});
 assert.equal(paused.skipped,true);
});
