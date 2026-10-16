import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseSearch, parseCard, sections, cards, collect, allowedDetailUrl, SOURCE_ID, SEARCH_URL } from '../src/sources/rentsolutions-core';
const registry = require('../scripts/search-settings.cjs');
const fixture = (name = 'search') => readFileSync(`test/fixtures/rentsolutions-${name}.html`, 'utf8');
const defaults = registry.defaults(SOURCE_ID);
const response = (body: string) => new Response(body, {headers:{'content-type':'text/html'}});
const first = () => cards(sections(fixture(),'facetwp-template')[0]!)[0]!;
test('real price-filtered Groningen search extracts all four rented properties', () => {
  const result = parseSearch(fixture());
  assert.equal(result.total,4); assert.equal(result.available,0);
  assert.deepEqual(result.listings[0], {externalId:'h106970027',canonicalUrl:'https://rent-solutions.nl/object/waldeck-pyrmontplein-groningen-h106970027/',title:'Waldeck-Pyrmontplein 11 b',address:'Waldeck-Pyrmontplein 11 b',city:'Groningen',areaM2:79,rooms:3,rentPrice:1120,availabilityStatus:'unavailable'});
  assert.equal(parseCard(first().replace('1.120','1.120,50')).rentPrice,1120.5);
  for(const [label,status] of [['Nieuw','available'],['Verhuurd onder voorbehoud','unavailable'],['Onder optie','unavailable'],['New status','unknown'],['','unknown']] as const)
    assert.equal(parseCard(first().replace('>Verhuurd<',`>${label}<`)).availabilityStatus,status);
});
test('real zero-price response requires exact filters and empty template with zero count', () => {
  assert.equal(parseSearch(fixture('empty'),{...defaults,maxRent:1}).total,0);
  assert.throws(()=>parseSearch(fixture('empty')),/SEARCH_FILTER_CHANGED/);
  assert.throws(()=>parseSearch(fixture('empty').replace('Geen resultaten gevonden',''),{...defaults,maxRent:1}),/EMPTY_SEARCH_UNCONFIRMED/);
});
test('count, filter, pagination, metadata and URL corruption fail closed', () => {
  for (const html of [fixture().replace('window.FWP_JSON','window.OTHER'),fixture().replace('facetwp-template','other'),fixture().replace('"_plaats":"groningen"','"_plaats":"marum"'),fixture().replace('"price":["0","1500"]','"price":["0","2000"]'),fixture().replace('"start":[0,1500]','"start":[0,2000]'),fixture().replace('"total_rows":4','"total_rows":3'),fixture().replace('"per_page":-1','"per_page":12'),fixture().replace(first(),''),fixture().replace('79&#13217;','&#13217;'),fixture().replace('1.120','1.5'),fixture().replace('9722GP Groningen','9722GP Marum'),fixture().replace('1.120','1.501')]) assert.throws(()=>parseSearch(html));
  const duplicate = fixture().replace(first(),first()+first()).replace('"total_rows":4','"total_rows":5');
  assert.throws(()=>parseSearch(duplicate),/DUPLICATE_CARD/);
  assert.throws(()=>parseSearch('Access denied'),/ACCESS_BLOCKED/);
  assert.throws(()=>sections('<div class="facetwp-template">','facetwp-template'),/HTML_TRUNCATED/);
  assert.throws(()=>cards('<a href="/object/test-h1/">'),/HTML_TRUNCATED/);
  const path='/object/test-h123/'; assert.equal(allowedDetailUrl(path),'https://rent-solutions.nl'+path);
  for(const url of ['http://rent-solutions.nl'+path,'https://evil.test'+path,'https://user@rent-solutions.nl'+path,path+'?x=1',path+'#x','/object/test/']) assert.throws(()=>allowedDetailUrl(url));
});
test('configured price is sent to site; budget includes €1500 and area stays a server filter', async () => {
  assert.deepEqual(defaults,{minRent:0,maxRent:1500,minArea:null});
  assert.equal(registry.queryUrl(SOURCE_ID,SEARCH_URL,defaults),SEARCH_URL);
  const html=fixture().replace('1.120','1.500');assert.equal(parseSearch(html).listings[0]!.rentPrice,1500);
  assert.equal(registry.matches(defaults,{rentPrice:1500},SOURCE_ID),true);
  assert.equal(registry.matches(defaults,{rentPrice:1500.01},SOURCE_ID),false);
  assert.equal(registry.matches({...defaults,minArea:80},{rentPrice:1120,areaM2:79},SOURCE_ID),false);
  let calls=0;
  const result=await collect({settings:{...defaults,maxRent:1},transport:async(url,options)=>{
    calls++;assert.equal(new URL(String(url)).searchParams.get('_price'),'0,1');assert.equal(options!.redirect,'manual');return response(fixture('empty'));
  }});
  assert.equal(calls,1); assert.equal(result.inspected,0);
});
test('HTTP failures never become empty success; transient retries and body limits are bounded', async () => {
  let calls=0; await collect({pause:async()=>{},transport:async()=>++calls<3?new Response('',{status:503}):response(fixture())});assert.equal(calls,3);
  for(const [status,category] of [[302,'HTTP_STATUS'],[403,'ACCESS_BLOCKED'],[429,'RATE_LIMIT'],[500,'HTTP_STATUS']] as const) await assert.rejects(collect({transport:async()=>new Response('',{status})}),new RegExp(category));
  await assert.rejects(collect({pause:async()=>{},transport:async()=>{throw Error('network')}}),/HTTP_TRANSPORT/);
  await assert.rejects(collect({transport:async()=>Response.json({})}),/CONTENT_TYPE/);
  await assert.rejects(collect({transport:async()=>response('')}),/SEARCH_STRUCTURE_CHANGED/);
  await assert.rejects(collect({signal:AbortSignal.abort()}),/RUN_TIMEOUT/);
  await assert.rejects(collect({transport:async()=>response(' '.repeat(8*1024*1024+1))}),/BODY_TOO_LARGE/);
});
