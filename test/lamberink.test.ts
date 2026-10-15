import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseSearch, collect, API_URL, SOURCE_ID, allowedDetailUrl } from '../src/sources/lamberink-core';
const registry = require('../scripts/search-settings.cjs');
const fixture = () => JSON.parse(readFileSync('test/fixtures/lamberink-search.json', 'utf8'));

test('real Lamberink catalog extracts rental houses and apartments, excludes sales and garages', () => {
  const r = parseSearch(fixture());
  assert.equal(r.inspected, 5); assert.equal(r.listings.length, 3); assert.equal(r.available, 2);
  assert.deepEqual(r.listings.map(x => x.externalId), ['EN102438', 'DN107814', 'AN24599']);
  assert.deepEqual(r.listings.map(x => x.availabilityStatus), ['available', 'available', 'unavailable']);
  assert.equal(r.listings[0]!.rentPrice, 1250); assert.equal(r.listings[0]!.city, 'Erica');
  assert.equal(r.listings[0]!.areaM2, 116); assert.equal(r.listings[0]!.rooms, 5);
  assert.equal(r.listings[0]!.publishedAt!.toISOString(), '2026-10-07T04:00:00.000Z');
  assert.equal(r.listings[0]!.serviceCosts, undefined);
  assert.equal(parseSearch({count:0, objects:[]}).listings.length, 0);
  const x = fixture(); x.objects[1].filters.buy_rent = 'both';
  assert.equal(parseSearch(x).listings.length, 3);
});
test('partial catalogs, malformed rental metadata and duplicate identities fail closed', () => {
  for (const mutate of [
    (x: any) => x.objects.pop(),
    (x: any) => x.count++,
    (x: any) => x.count = '5',
    (x: any) => delete x.objects[0].filters,
    (x: any) => x.objects[1].filters.buy_rent = 'unknown',
    (x: any) => x.objects[1].rent_price = '1250',
    (x: any) => x.objects[1].usable_area_living_function = null,
    (x: any) => x.objects[1].rent_condition = 'per jaar',
    (x: any) => x.objects[1].publish_date = 'not a date',
    (x: any) => delete x.objects[1].is_available,
    (x: any) => x.objects[2] = x.objects[1],
    (x: any) => x.objects[1].url = x.objects[2].url,
  ]) { const x = fixture(); mutate(x); assert.throws(() => parseSearch(x)); }
  assert.throws(() => parseSearch({}));
});
test('availability uses explicit status and restrictive flags, never the misleading is_available alone', () => {
  for (const status of ['verhuurd', 'Verhuurd onder voorbehoud', 'onder optie', 'onder_bod', 'ingetrokken']) {
    const x = fixture(); x.objects[1].availability_status = status;
    assert.equal(parseSearch(x).listings[0]!.availabilityStatus, 'unavailable');
  }
  const x = fixture(); x.objects[1].availability_status = 'new status';
  assert.equal(parseSearch(x).listings[0]!.availabilityStatus, 'unknown');
  for (const [key,value] of [['is_available',false],['is_sold_or_rented',true],['is_forbidden',true]]) {
    const x = fixture(); x.objects[1][key as string] = value;
    assert.equal(parseSearch(x).listings[0]!.availabilityStatus, 'unavailable');
  }
});
test('detail URLs must be HTTPS, same origin, expected path and object identity', () => {
  const path = '/wonen/aanbod/de-voorreep-11-erica-en102438';
  assert.equal(allowedDetailUrl(path, 'EN102438'), 'https://lamberink.nl' + path);
  for (const url of ['https://localhost'+path, 'http://lamberink.nl'+path, 'https://user:pass@lamberink.nl'+path,
    path+'?redirect=x', path+'#x', '//evil.test'+path, '/wonen/aanbod/other-en102439', '/api/EN102438']) {
    assert.throws(() => allowedDetailUrl(url, 'EN102438'));
  }
});
test('one request reads the complete API payload; query paging is entirely client-side', async () => {
  let calls = 0;
  const r = await collect({transport: async (url, options) => {
    calls++; assert.equal(url, API_URL); assert.equal(options!.redirect, 'manual'); assert.equal(options!.method, 'GET');
    assert.equal(options!.body, undefined); return Response.json(fixture());
  }});
  assert.equal(calls, 1); assert.equal(r.listings.length, 3);
  const f = registry.defaults(SOURCE_ID);
  assert.deepEqual(f, {minRent:0,maxRent:null,minArea:null});
  assert.equal(registry.matches(f, r.listings[0], SOURCE_ID), true);
  assert.equal(registry.matches({...f,maxRent:1200}, r.listings[0], SOURCE_ID), false);
  assert.equal(registry.matches({...f,minArea:120}, r.listings[0], SOURCE_ID), false);
});
test('HTTP failures, invalid responses, rate limits and timeouts cannot become an empty success', async () => {
  let calls = 0;
  await collect({pause:async()=>{},transport:async()=> ++calls < 3 ? new Response('',{status:503}) : Response.json(fixture())});
  assert.equal(calls, 3);
  for (const [status, category] of [[302,'HTTP_STATUS'],[401,'ACCESS_BLOCKED'],[403,'ACCESS_BLOCKED'],[429,'RATE_LIMIT'],[500,'HTTP_STATUS']] as const) {
    await assert.rejects(collect({transport:async()=>new Response('',{status})}), e =>
      e instanceof Error && e.message === category && (status !== 403 || (e as any).blocked));
  }
  await assert.rejects(collect({pause:async()=>{},transport:async()=>{throw Error('network')}}), /HTTP_TRANSPORT/);
  await assert.rejects(collect({transport:async()=>new Response('<html>challenge</html>',{headers:{'content-type':'text/html'}})}), /CONTENT_TYPE/);
  await assert.rejects(collect({transport:async()=>new Response('{',{headers:{'content-type':'application/json'}})}), /INVALID_JSON/);
  await assert.rejects(collect({signal:AbortSignal.abort(),transport:async()=>{throw Error('must not fetch')}}), /RUN_TIMEOUT/);
  await assert.rejects(collect({transport:async()=>new Response(' '.repeat(8*1024*1024+1),{headers:{'content-type':'application/json'}})}), /BODY_TOO_LARGE/);
});
