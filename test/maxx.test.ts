import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseSearch, parseCard, collect, allowedDetailUrl, searchUrl, SOURCE_ID, SEARCH_URL } from '../src/sources/maxx-core';
const registry = require('../scripts/search-settings.cjs');
const html = readFileSync('test/fixtures/maxx-search.html', 'utf8');
const defaults = registry.defaults(SOURCE_ID);
const cards = [...html.matchAll(/<a\b[^>]*class="object w-inline-block"[\s\S]*?<\/a>/g)].map(m => m[0]);
const apartment = cards.find(c => c.includes('id="object-24449"'))!;
function empty() {
  return html.replace('<span class="aantal-woonruimtes">65</span>', '<span class="aantal-woonruimtes">0</span>')
    .replace(/<a\b[^>]*class="object w-inline-block"[\s\S]*?<\/a>/g, '')
    .replace('id="filter-results-container">', 'id="filter-results-container"><p>Er zijn geen woningen gevonden met deze filters.</p>');
}
test('Maxx validates the complete live catalog before excluding rooms and non-housing', () => {
  const result = parseSearch(html);
  assert.equal(result.inspected, 65); assert.equal(result.listings.length, 33); assert.equal(result.available, 3);
  assert.ok(!result.listings.some(x => ['24475','24474','24293','24176','18793'].includes(x.externalId)));
  assert.deepEqual(result.listings.find(x => x.externalId === '24449'), {
    externalId: '24449', canonicalUrl: 'https://maxxhuren.nl/objects/ads/view/id-24449/',
    title: 'Bernoulliplein 23', address: 'Bernoulliplein 23', city: 'Groningen', rentPrice: 875,
    areaM2: 29, rooms: 2, availabilityStatus: 'available',
  });
  assert.equal(result.listings.find(x => x.externalId === '24374')!.rentPrice, 1465);
  assert.equal(result.listings.find(x => x.externalId === '24396')!.areaM2, undefined);
  for (const type of ['Appartement','Studio','Bovenwoning','Eengezinswoning'])
    assert.equal(parseCard(apartment.replace('>Appartement<', `>${type}<`)).type, type);
});
test('Maxx notifies only explicit availability with a matching badge class', () => {
  assert.equal(parseCard(apartment).listing.availabilityStatus, 'available');
  for (const [cls,label,expected] of [
    ['object-beschikbaar','Beschikbaar','available'], ['object-onder-optie','Bijna verhuurd','unavailable'],
    ['object-reeds-verhuurd','Reeds verhuurd','unavailable'], ['object-beschikbaar','Binnenkort','unknown'],
    ['object-beschikbaar','Reeds verhuurd','unknown'], ['object-changed','Beschikbaar','unknown'],
  ]) assert.equal(parseCard(apartment.replace('object-beschikbaar',cls).replace('Nieuw - Beschikbaar',label)).listing.availabilityStatus, expected);
  assert.equal(parseCard(apartment.replace(/<div class="object-beschikbaar">.*?<\/div>/,'')).listing.availabilityStatus,'unknown');
  assert.throws(() => parseCard(apartment.replace('Nieuw - Beschikbaar</div>', 'Nieuw - Beschikbaar</div><div class="object-onder-optie">Bijna verhuurd</div>')));
});
test('Maxx rejects missing, malformed and mismatched card metadata', () => {
  for (const [from,to] of [['>€875,00 per maand<','>€875 per week<'], ['>29m²<','>veel m²<'],
    ['>2 kamers<','>0 kamers<'], ['>Groningen<','>Zwolle<'], ['object-24449','object-999'],
    ['text-block-34','renamed'], ['huurprijs-object','renamed']])
    assert.throws(() => parseCard(apartment.replace(from,to)), from);
  assert.equal(parseCard(apartment.replace('€875,00','€1.055,25')).listing.rentPrice, 1055.25);
  assert.throws(() => parseSearch(html.replace('>€875,00 per maand<','>€1.500,01 per maand<')), /SEARCH_FILTER_CHANGED/);
});
test('Maxx requires count, all cards, complete HTML and explicit empty state', () => {
  assert.equal(parseSearch(empty()).total, 0);
  for (const broken of [html.replace(cards[0]!,''), html.replace(cards[0]!,cards[1]!), html.replace('>65</span>','>64</span>'),
    html.replace('aantal-woonruimtes','renamed'),html.replace('</html>',''),html.slice(0,-1000),
    empty().replace('Er zijn geen woningen gevonden met deze filters.',''),
    html.replace('id="filter-results-container">','id="filter-results-container"><p>Er zijn geen woningen gevonden met deze filters.</p>')])
    assert.throws(() => parseSearch(broken));
  // Even excluded rooms must be complete and valid before their removal.
  assert.throws(() => parseSearch(html.replace('id="object-24475"','id="object-999"')), /CARD_ID_MISMATCH/);
});
test('Maxx verifies search form filters and supports only the site price options', () => {
  for (const broken of [html.replace('value="Groningen" selected','value="Groningen"'),
    html.replace('value="1500" selected','value="1500"'),html.replace('value="Kamer" >','value="Kamer" selected>'),
    html.replace('id="search-form"','id="other-form"')]) assert.throws(() => parseSearch(broken));
  assert.equal(searchUrl(),SEARCH_URL);
  const filters = {...defaults,maxRent:1600,minRent:700,minArea:30};
  assert.equal(new URL(searchUrl(filters)).searchParams.get('max'),'1600');
  assert.equal(parseSearch(html.replace('value="1500" selected','value="1500"').replace('value="1600" >','value="1600" selected>'),filters).total,65);
  for (const maxRent of [0,450,1550,2600]) assert.throws(() => searchUrl({...defaults,maxRent}));
  assert.equal(registry.matches(filters,{rentPrice:650,areaM2:40},SOURCE_ID),false);
  assert.equal(registry.matches(filters,{rentPrice:800},SOURCE_ID),false);
  assert.equal(registry.matches(filters,{rentPrice:800,areaM2:40},SOURCE_ID),true);
});
test('Maxx allows only canonical public detail URLs', () => {
  const path='/objects/ads/view/id-24449/'; assert.equal(allowedDetailUrl(path),'https://maxxhuren.nl'+path);
  for (const url of ['http://maxxhuren.nl'+path,'https://evil.test'+path,'https://user@maxxhuren.nl'+path,
    path+'?x=1',path+'#x','/objects/ads/view/id-0/','/accounts/']) assert.throws(() => allowedDetailUrl(url));
});
const ok = () => new Response(html,{headers:{'content-type':'text/html; charset=UTF-8'}});
test('Maxx collection uses a bounded HTTP request and retries transient failures', async () => {
  let attempts=0; const waits:number[]=[];
  const result = await collect({transport:async (url,opts) => {
    assert.equal(url,SEARCH_URL); assert.equal(opts?.redirect,'manual'); assert.ok(opts?.signal);
    return ++attempts < 3 ? new Response('',{status:503}) : ok();
  },pause:async ms => { waits.push(ms); }});
  assert.equal(attempts,3); assert.equal(waits.length,2); assert.equal(result.inspected,65);
});
test('Maxx never interprets network, HTTP, redirects, challenges or partial responses as empty success', async () => {
  for (const [status,category] of [[403,'ACCESS_BLOCKED'],[429,'RATE_LIMIT'],[302,'HTTP_STATUS'],[500,'HTTP_STATUS']] as const)
    await assert.rejects(collect({transport:async()=>new Response('',{status}),pause:async()=>{}}),new RegExp(category));
  await assert.rejects(collect({transport:async()=>new Response('{}',{headers:{'content-type':'application/json'}})}),/CONTENT_TYPE/);
  await assert.rejects(collect({transport:async()=>new Response('<h1>Verify you are human</h1>',{headers:{'content-type':'text/html'}})}),/ACCESS_BLOCKED/);
  await assert.rejects(collect({transport:async()=>{throw Error('private transport message')},pause:async()=>{}}),/HTTP_TRANSPORT/);
  await assert.rejects(collect({transport:async()=>new Response('x'.repeat(8*1024*1024+1),{headers:{'content-type':'text/html'}})}),/BODY_TOO_LARGE/);
  await assert.rejects(collect({signal:AbortSignal.abort(),transport:async()=>ok()}),/RUN_TIMEOUT/);
});
