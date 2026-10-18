import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const core=require('../scripts/pararius-core.cjs');
const registry=require('../scripts/search-settings.cjs');
const fixture=readFileSync('test/fixtures/pararius-last.html','utf8');
const transparent=readFileSync('test/fixtures/pararius-transparent-card.html','utf8');
const {SEARCH_URL,SOURCE_ID}=core;
const response=body=>new Response(body,{headers:{'content-type':'text/html'}});
const last=()=>core.parseSearch(fixture,SEARCH_URL+'/page-4');
// Synthetic pages keep the observed card layout but vary IDs, total and next URL.
function page(index,total=31) {
  const header=fixture.slice(0,fixture.indexOf('<section')).replace('>100<','>'+total+'<');
  const count=Math.min(30,total-(index-1)*30);
  const cards=Array.from({length:count},(_,i)=>transparent.replaceAll('df704297',((index-1)*30+i+1).toString(16).padStart(8,'0'))).join('');
  return header+cards+(index<Math.ceil(total/30)?`<a class="pagination__link pagination__link--next" href="${SEARCH_URL}/page-${index+1}"><span>Volgende</span></a>`:'');
}
test('observed last page preserves unavailable homes, identifies rooms and parses Dutch prices',()=>{
 const r=last();assert.equal(r.total,100);assert.equal(r.listings.length,10);assert.equal(r.next,undefined);
 assert.equal(r.listings[0].rentPrice,1186);assert.equal(r.listings[0].availabilityStatus,'unavailable');
 const homes=r.listings.filter(core.candidate);assert.equal(homes.length,6);assert.equal(homes.filter(x=>x.availabilityStatus==='available').length,4);
 assert.equal(homes[2].canonicalUrl.includes('/appartement-te-huur/'),true);
});
test('transparent cards retain base rent and reported total without treating utilities as servicekosten',()=>{
 const item=core.parseCard(transparent);assert.equal(item.rentPrice,799);assert.equal(item.pricingDetails.totalRentPrice,979);
 assert.equal(item.pricingDetails.baseRent,true);assert.equal(item.serviceCosts,undefined);
 assert.throws(()=>core.parseCard(transparent.replace('979','700')),/CARD_METADATA_MISSING/);
 assert.equal(core.parseCard(transparent.replace('Nieuw','Onbekend')).availabilityStatus,'unknown');
 assert.equal(core.parseCard(transparent.replace('Nieuw','Verhuurd')).availabilityStatus,'unavailable');
});
test('price and area only narrow the fixed search; apartments, studios and houses pass, rooms never pass',()=>{
 const settings=registry.defaults(SOURCE_ID);const item=core.parseCard(transparent);
 assert.equal(registry.queryUrl(SOURCE_ID,SEARCH_URL,settings),SEARCH_URL);
 for(const type of ['appartement','studio','huis'])assert.equal(core.candidate({...item,canonicalUrl:item.canonicalUrl.replace('appartement-',type+'-')}),true);
 assert.equal(core.candidate({...item,canonicalUrl:item.canonicalUrl.replace('appartement-','kamer-')}),false);
 assert.equal(core.createCore({...settings,maxRent:798}).candidate(item),false);
 assert.equal(core.createCore({...settings,minRent:800}).candidate(item),false);
 assert.equal(core.createCore({...settings,minArea:28}).candidate(item),false);
 assert.equal(core.createCore({...settings,minArea:27,maxRent:799}).candidate(item),true);
 assert.throws(()=>registry.validate(SOURCE_ID,{...settings,maxRent:1501}));
});
test('filter echo, partial pages, missing next, duplicates and ambiguous empty searches fail closed',()=>{
 for(const html of [fixture.replace('value="1500"','value="2000"'),fixture.replace('value="25"','value="10"'),
 fixture.replace('Huurwoningen Groningen','Huurwoningen Amsterdam'),fixture.replace('>100<','>101<'),
 fixture.replace('>100<','>0<'),fixture.replace(/<section[\s\S]*?<\/section>/,'')])assert.throws(()=>core.parseSearch(html,SEARCH_URL+'/page-4'));
 for(const html of [page(1).replace(/<a class="pagination__[\s\S]*$/,''),page(1).replace('00000002','00000001')])assert.throws(()=>core.parseSearch(html));
 assert.throws(()=>core.parseSearch('Just a moment...'),/HUMAN_CHECK/);
 assert.throws(()=>core.parseSearch('Access denied'),/ACCESS_BLOCKED/);
 assert.throws(()=>core.parseSearch(page(1).replaceAll('799','1.501').replaceAll('979','1.600')),/SEARCH_FILTER_CHANGED/);
});
test('search/detail URLs reject SSRF, changed filters, query, hash, unexpected paths and credentials',()=>{
 for(const u of ['http://www.pararius.nl/huurwoningen/groningen/0-1500/straal-25','https://evil.test/x',SEARCH_URL+'?x=1',SEARCH_URL+'#x',SEARCH_URL.replace('1500','2000'),SEARCH_URL+'/page-0','https://user@www.pararius.nl/huurwoningen/groningen/0-1500/straal-25'])assert.throws(()=>core.allowedUrl(u,'search'));
 assert.equal(core.allowedUrl('/huis-te-huur/marum/66f8c2fb/langestraat'),'https://www.pararius.nl/huis-te-huur/marum/66f8c2fb/langestraat');
 assert.throws(()=>core.allowedUrl('/appartement-te-huur/groningen/not-an-id/home'));
});
test('collector validates complete pagination before returning, with independent server filtering',async()=>{
 const calls=[],delays=[];const result=await core.collect({pause:async ms=>{delays.push(ms)},transport:async(url,opts)=>{
  calls.push(url);assert.equal(opts.redirect,'manual');return response(page(url.endsWith('page-2')?2:1));
 }});
 assert.deepEqual(calls,[SEARCH_URL,SEARCH_URL+'/page-2']);assert.deepEqual(delays,[5000]);assert.equal(result.inspected,31);assert.equal(result.listings.length,31);assert.equal(result.pages,2);
 const narrow=await core.collect({settings:{...registry.defaults(SOURCE_ID),maxRent:798},pause:async()=>{},transport:async url=>response(page(url.endsWith('page-2')?2:1))});
 assert.equal(narrow.inspected,31);assert.equal(narrow.listings.length,0);
});
test('collector rejects changed totals, overlapping IDs and resource limits without partial success',async()=>{
 for(const second of [page(2,32),page(2).replace('0000001f','00000001')])await assert.rejects(core.collect({pause:async()=>{},transport:async url=>response(url===SEARCH_URL?page(1):second)}));
 await assert.rejects(core.collect({maxPages:1,pause:async()=>{},transport:async()=>response(page(1))}),/PAGINATION_LIMIT/);
 await assert.rejects(core.collect({maxListings:30,transport:async()=>response(page(1))}),/LISTING_LIMIT/);
});
test('HTTP failures, throttling, timeouts, redirects and oversized bodies never become zero success',async()=>{
 for(const [status,category] of [[302,'UNEXPECTED_REDIRECT'],[403,'ACCESS_BLOCKED'],[429,'RATE_LIMIT'],[500,'HTTP_STATUS']])await assert.rejects(core.collect({transport:async()=>new Response('',{status})}),new RegExp(category));
 await assert.rejects(core.collect({signal:AbortSignal.abort()}),/RUN_TIMEOUT/);
 await assert.rejects(core.collect({transport:async()=>Response.json({})}),/CONTENT_TYPE/);
 await assert.rejects(core.collect({transport:async()=>response(' '.repeat(5*1024*1024+1))}),/BODY_TOO_LARGE/);
 let calls=0;await assert.rejects(core.collect({pause:async()=>{},transport:async()=>{calls++;return new Response('',{status:503})}}),/HTTP_STATUS/);assert.equal(calls,3);
});

test('single-select radius follows the last selected option just like the browser',()=>{
 const duplicated=fixture.replace('<option value="25" selected="selected">25 km</option>', '<option value="0" selected="selected">+0 km</option><option value="25" selected="selected">25 km</option>');
 assert.equal(core.parseSearch(duplicated,SEARCH_URL+'/page-4').total,100);
 const wrongLast=fixture.replace('<option value="25" selected="selected">25 km</option>', '<option value="25" selected="selected">25 km</option><option value="0" selected="selected">+0 km</option>');
 assert.throws(()=>core.parseSearch(wrongLast,SEARCH_URL+'/page-4'),/SEARCH_FILTER_CHANGED/);
 assert.throws(()=>core.parseSearch(duplicated.replace('name="filters[radius][value]"','multiple name="filters[radius][value]"'),SEARCH_URL+'/page-4'),/SEARCH_FILTER_CHANGED/);
});
