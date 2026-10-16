import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseSearch, parseCard, sections, collect, allowedDetailUrl, pageUrl, SOURCE_ID, SEARCH_URL } from '../src/sources/vandermeulen-core';
const registry = require('../scripts/search-settings.cjs');
const fixture = (name = 'search') => readFileSync(`test/fixtures/vandermeulen-${name}.html`, 'utf8');
const defaults = registry.defaults(SOURCE_ID);
const response = (body: string) => new Response(body, {headers:{'content-type':'text/html'}});
// Build multi-page cases from the real page's template and embedded FacetWP state.
function page(n: number, total = 13, ids?: number[]) {
  const source = fixture();
  const card = sections(source, 'aw-card')[0]!;
  const count = Math.min(12, Math.max(0, total - (n - 1) * 12));
  const cards = Array.from({length:count}, (_, i) => card.replaceAll('h107120487', `h${ids?.[i] ?? ((n-1)*12+i+1)}`)).join('');
  let html = source.replace(card, cards);
  html = html.replace(/window.FWP_JSON = (.+);/, (_, raw) => {
    const data = JSON.parse(raw); data.preload_data.settings.pager = {page:n,per_page:12,total_rows:total,total_pages:Math.ceil(total/12)};
    return `window.FWP_JSON = ${JSON.stringify(data)};`;
  });
  html = html.replace(/window.FWP_HTTP = (.+);/, (_, raw) => {
    const data = JSON.parse(raw); if(n>1) data.get._paged=String(n);
    return `window.FWP_HTTP = ${JSON.stringify(data)};`;
  });
  return html;
}
test('real filtered page extracts identity, monthly price, area, rooms and explicit Nieuw availability', () => {
  const result = parseSearch(fixture());
  assert.equal(result.total, 1); assert.equal(result.pages, 1);
  assert.deepEqual(result.listings[0], {externalId:'h107120487',canonicalUrl:'https://www.vandermeulenmakelaars.nl/huurwoningen/van-starkenborghstraat-groningen-h107120487/',title:'Van starkenborghstraat',address:'Van starkenborghstraat',city:'Groningen',areaM2:15,rooms:1,rentPrice:406,availabilityStatus:'available'});
  assert.equal(parseCard(sections(fixture(), 'aw-card')[0]!.replace('406 &nbsp', '1.055 &nbsp')).rentPrice, 1055);
  assert.equal(parseCard(sections(fixture(), 'aw-card')[0]!.replace('406 &nbsp', '1.055,50 &nbsp')).rentPrice, 1055.5);
  assert.equal(parseSearch(fixture().replace('>Nieuw<','>Verhuurd<')).listings[0]!.availabilityStatus, 'unavailable');
  assert.equal(parseSearch(fixture().replace('>Nieuw<','>New status<')).listings[0]!.availabilityStatus, 'unknown');
});
test('real empty search requires count, template and exact configured filter echo', () => {
  const settings = {...defaults,minRent:19999,maxRent:20000};
  assert.equal(parseSearch(fixture('empty'),1,settings).total,0);
  assert.throws(()=>parseSearch(fixture('empty')), /SEARCH_FILTER_CHANGED/);
  for(const html of [fixture().replace('window.FWP_JSON','window.OTHER'),fixture().replace('facetwp-template','other'),fixture().replace('"_status":"nieuw"','"_status":"verhuurd"'),fixture().replace('"total_rows":1,','"total_rows":0,'),fixture().replace(sections(fixture(),'aw-card')[0]!,''),fixture().replace('15 m²','m²'),fixture().replace('406 &nbsp','1.5 &nbsp')]) assert.throws(()=>parseSearch(html));
  assert.throws(()=>parseSearch('Access denied'), /ACCESS_BLOCKED/);
  assert.throws(()=>sections(sections(fixture(),'aw-card')[0]!.slice(0,-6),'aw-card'), /HTML_TRUNCATED/);
  assert.throws(()=>parseSearch(page(1,2,[1,1])), /DUPLICATE_CARD/);
});
test('query URLs retain city/status and editable price; detail origins and paths are restricted', () => {
  assert.deepEqual(defaults,{minRent:10,maxRent:1500,minArea:null});
  assert.equal(pageUrl(1),SEARCH_URL);
  const u=new URL(pageUrl(2,{...defaults,minRent:500,maxRent:1200}));
  assert.equal(u.searchParams.get('_prijsbereik'),'500.00,1200.00'); assert.equal(u.searchParams.get('_paged'),'2');
  assert.equal(u.searchParams.get('_status'),'nieuw'); assert.equal(u.searchParams.get('_plaats'),'groningen');
  assert.equal(registry.matches({...defaults,minArea:20},{areaM2:15},SOURCE_ID),false);
  const path='/huurwoningen/test-h123/'; assert.equal(allowedDetailUrl(path),'https://www.vandermeulenmakelaars.nl'+path);
  for(const url of ['http://www.vandermeulenmakelaars.nl'+path,'https://evil.test'+path,'https://user@www.vandermeulenmakelaars.nl'+path,path+'?x=1',path+'#x','/huurwoningen/test/']) assert.throws(()=>allowedDetailUrl(url));
  assert.throws(()=>pageUrl(101),/PAGE_LIMIT/);
});
test('collector reads every page once and rejects count changes and duplicates across pages', async () => {
  let calls=0;
  const result=await collect({pause:async()=>{},transport:async(url,options)=>{
    calls++;assert.equal(String(url),pageUrl(calls));assert.equal(options!.redirect,'manual');return response(page(calls));
  }});
  assert.equal(calls,2); assert.equal(result.inspected,13);assert.equal(result.available,13);
  for(const second of [page(2,14),page(2,13,[1])]) {
    let n=0;await assert.rejects(collect({pause:async()=>{},transport:async()=>response(++n===1?page(1):second)}),/SEARCH_CHANGED_DURING_RUN|DUPLICATE_CARD/);
  }
});
test('HTTP errors and malformed responses fail with diagnostics and bounded retries', async () => {
  let calls=0;await collect({pause:async()=>{},transport:async()=>++calls<3?new Response('',{status:503}):response(fixture())});assert.equal(calls,3);
  for(const [status,category] of [[302,'HTTP_STATUS'],[403,'ACCESS_BLOCKED'],[429,'RATE_LIMIT'],[500,'HTTP_STATUS']] as const) await assert.rejects(collect({transport:async()=>new Response('',{status})}),new RegExp(category));
  await assert.rejects(collect({pause:async()=>{},transport:async()=>{throw Error('network')}}),/HTTP_TRANSPORT/);
  await assert.rejects(collect({transport:async()=>Response.json({})}),/CONTENT_TYPE/);
  await assert.rejects(collect({transport:async()=>response('')}),/SEARCH_STRUCTURE_CHANGED/);
  await assert.rejects(collect({signal:AbortSignal.abort()}),/RUN_TIMEOUT/);
  await assert.rejects(collect({transport:async()=>response(' '.repeat(8*1024*1024+1))}),/BODY_TOO_LARGE/);
});
