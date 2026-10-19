import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseSearch, parseCard, parseDetail, sections, collect, allowedDetailUrl, pageUrl, SOURCE_ID, SEARCH_URL } from '../src/sources/rotsvast-core';
const registry = require('../scripts/search-settings.cjs');
const fixture = (name = 'search') => readFileSync(`test/fixtures/rotsvast-${name}.html`, 'utf8');
const defaults = registry.defaults(SOURCE_ID);
const response = (body: string) => new Response(body, { headers: { 'content-type': 'text/html' } });
const first = () => sections(fixture(), 'card--house', 'a')[0]!;
const transport: typeof fetch = async target => {
  const u = String(target);
  if (u.includes('/page/2/')) return response(fixture('page2'));
  if (u.includes('?search=')) return response(fixture());
  return response(readFileSync(`test/fixtures/rotsvast-details/${new URL(u).pathname.split('/')[2]}.html`, 'utf8'));
};

test('real search pages retain stable IDs, monthly prices, area and explicit unavailable status', () => {
  const a = parseSearch(fixture()); const b = parseSearch(fixture('page2'), 2);
  assert.equal(a.pages,2); assert.equal(a.listings.length,10); assert.equal(b.listings.length,7);
  assert.deepEqual(a.listings[0], { externalId:'h102623947',canonicalUrl:'https://www.rotsvast.nl/huren/pelsterstraat-groningen-h102623947/',
    address:'Pelsterstraat',title:'Pelsterstraat, Groningen',city:'Groningen',rentPrice:1135,areaM2:48,availabilityStatus:'unavailable' });
  assert.equal(parseCard(first().replace('1.135','1.500,50')).rentPrice,1500.5);
  assert.equal(a.listings.every(x=>x.availabilityStatus==='unavailable'),true);
});
test('availability requires a verified date or Direct beschikbaar and known badge/class; unknown never notifies', () => {
  const active = fixture('available-card');
  assert.equal(parseCard(active).availabilityStatus,'available');
  assert.equal(parseCard(active.replace('Beschikbaar vanaf 01-11-2026','Direct beschikbaar')).availabilityStatus,'available');
  for (const html of [active.replace('01-11-2026','31-02-2026'),active.replace('Beschikbaar vanaf','Vanaf'),
    active.replace('>Topper<','>Onbekend<'),active.replace('card card--house ','card card--house pending '),
    active.replace(/<li>\s*<i class="icon-clock"><\/i>[\s\S]*?<\/li>/,'')]) assert.equal(parseCard(html).availabilityStatus,'unknown');
  for(const badge of ['Verhuurd','Verhuurd onder voorbehoud','Onder optie','Gereserveerd']) assert.equal(parseCard(active.replace('>Topper<',`>${badge}<`)).availabilityStatus,'unavailable');
});
test('detail identity and type distinguish homes from parking, rooms and unknown subtypes', () => {
  const card = parseCard(first()); const html = fixture('detail');
  const item = parseDetail(html,card);
  assert.equal(item.independent,true); assert.equal(item.rooms,2); assert.equal(item.propertyType,'Appartement, Portiekwoning, Appartement');
  for(const type of ['Kamer','Parkeergelegenheid','Onbekend','Appartement, Kamer','Appartement, Onbekend']) assert.equal(parseDetail(html.replace('Appartement, Portiekwoning, Appartement',type),card).independent,false);
  for(const body of [html.replace('48 m²','49 m²'),html.replace('<h1 class="h4">Pelsterstraat','<h1 class="h4">Anders'),
    html.replace('>Groningen<','>Assen<'),html.replace('1.135 p.m.','1.136 p.m.'),html.replace('rel="canonical"','rel="other"'),html.replace('Aantal kamers','Aantal onbekend').replace('Oppervlakte','Anders')]) assert.throws(()=>parseDetail(body,card));
  assert.equal(parseDetail(html,{...card,availabilityStatus:'available'}).availabilityStatus,'unavailable');
});
test('complete live fixtures exclude nonhousing before returning results; price and area filters remain configurable', async () => {
  const calls: string[]=[];
  const result = await collect({pause:async()=>{},transport:async(u,o)=>{calls.push(String(u));assert.equal(o!.redirect,'manual');return transport(u,o);}});
  assert.equal(result.inspected,17);assert.equal(result.pages,2);assert.equal(result.available,0);
  assert.equal(calls.length,19);assert.deepEqual(calls.slice(0,2),[SEARCH_URL,pageUrl(2)]);
  assert.equal(result.listings.some(x=>x.externalId==='h102621367'),false); // De Kaai is parking.
  assert.equal(result.listings.length,13);
  for(const id of ['h102624284','h102624290','h102624226']) assert.equal(result.listings.some(x=>x.externalId===id),false);
  assert.equal(registry.matches(defaults,{rentPrice:1500},SOURCE_ID),true);
  assert.equal(registry.matches(defaults,{rentPrice:1500.01},SOURCE_ID),false);
  assert.equal(registry.matches(defaults,{},SOURCE_ID),false);
  assert.equal(registry.matches({...defaults,minArea:50},{rentPrice:1000,areaM2:49},SOURCE_ID),false);
  const settings={...defaults,maxRent:2000,minRent:1100,minArea:45};
  const filtered=await collect({settings,pause:async()=>{},transport:async(u,o)=>{
    const r=await transport(u,o);return response((await r.text()).replaceAll('price_to=1500','price_to=2000'));
  }});
  assert.ok(filtered.listings.length>0); assert.ok(filtered.listings.every(x=>x.rentPrice!>=1100&&x.areaM2!>=45));
});
test('page filters, city, completeness, canonical and both pagination panels fail closed', () => {
  for(const html of [fixture().replace('Aanbod huurwoningen','Anders'),fixture().replace('price_to=1500','price_to=2000'),
    fixture().replace('rel="canonical"','rel="other"'),fixture().replace(first(),''),fixture().replace('48 m²','unknown'),
    fixture().replace('1.135 p.m.','1.13 p.m.'),fixture().replace('>Groningen<','>Assen<'),
    fixture().replaceAll('current">1','current">2'),fixture().replaceAll('/page/2/','/page/3/'),
    fixture().replace('class="next page-numbers"','class="other page-numbers"'),
    fixture().replace('<li><a class="page-numbers" href="https://www.rotsvast.nl/huren/page/2/?search=Groningen&#038;price_to=1500">2</a></li>',''),fixture().replace('class="card card--house ','class="card changed '),
    fixture().replaceAll('search=Groningen','search=Assen')]) assert.throws(()=>parseSearch(html));
  assert.throws(()=>parseSearch(fixture(),2));
  assert.throws(()=>parseSearch('Access denied'),/ACCESS_BLOCKED/);
  assert.throws(()=>sections('<a class="card--house">','card--house','a'),/HTML_TRUNCATED/);
  const empty=fixture().replace(/<a href="[^"]+" class="card card--house [^"]*">[\s\S]*?<\/a>/g,'');
  assert.throws(()=>parseSearch(empty),/EMPTY_SEARCH_UNCONFIRMED/);
  for(const value of ['https://evil.test/huren/home-h123456/','http://www.rotsvast.nl/huren/home-h123456/',
    'https://user@www.rotsvast.nl/huren/home-h123456/','/huren/home-h123456/?x=1','/huren/home-h123456/#x','/kopen/home-h123456/']) assert.throws(()=>allowedDetailUrl(value));
  assert.throws(()=>pageUrl(101),/PAGE_LIMIT/);
});
test('partial traversal, duplicate identity and detail failures never become partial success', async () => {
  for(const broken of ['/page/2/','pelsterstraat-groningen-h102623947/']) await assert.rejects(collect({pause:async()=>{},transport:async(u,o)=>String(u).includes(broken)?new Response('',{status:500}):transport(u,o)}),/HTTP_STATUS/);
  const card=parseSearch(fixture()).listings[0]!;
  const old=parseSearch(fixture('page2'),2).listings[0]!;
  const duplicate=fixture('page2').replaceAll(old.canonicalUrl,card.canonicalUrl);
  await assert.rejects(collect({pause:async()=>{},transport:async(u,o)=>String(u).includes('/page/2/')?response(duplicate):transport(u,o)}),/DUPLICATE_CARD/);
  await assert.rejects(collect({pause:async()=>{},transport:async(u,o)=>String(u).includes('/page/2/')?response(fixture('page2').replace('</ul>\n\n    <ul class="mobile">','<li><a class="next page-numbers" href="https://www.rotsvast.nl/huren/page/3/?search=Groningen&amp;price_to=1500">3</a></li></ul>\n\n    <ul class="mobile">')):transport(u,o)}));
});
test('HTTP retries, rate limits, body caps, content type and timeout are bounded and diagnostic', async () => {
  let calls=0;
  await collect({pause:async()=>{},transport:async(u,o)=>++calls<=2?new Response('',{status:503}):transport(u,o)});
  assert.equal(calls,21);
  for(const [status,category] of [[302,'HTTP_STATUS'],[403,'ACCESS_BLOCKED'],[429,'RATE_LIMIT'],[500,'HTTP_STATUS']] as const) await assert.rejects(collect({transport:async()=>new Response('',{status})}),new RegExp(category));
  await assert.rejects(collect({transport:async()=>Response.json({})}),/CONTENT_TYPE/);
  await assert.rejects(collect({signal:AbortSignal.abort()}),/RUN_TIMEOUT/);
  await assert.rejects(collect({transport:async()=>response(' '.repeat(8*1024*1024+1))}),/BODY_TOO_LARGE/);
  await assert.rejects(collect({transport:async()=>{throw Error('network')},pause:async()=>{}}),/HTTP_TRANSPORT/);
});
