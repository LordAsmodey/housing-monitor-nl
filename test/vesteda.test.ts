import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseSearch, collect, searchPayload, API_URL, allowedDetailUrl } from '../src/sources/vesteda-core';

const fixture = () => JSON.parse(readFileSync('test/fixtures/vesteda-search.json', 'utf8'));
test('live Vesteda response validates all counts, excludes complexes and maps rental statuses', () => {
  const r = parseSearch(fixture());
  assert.equal(r.inspected, 15); assert.equal(r.total, 17); assert.equal(r.available, 2);
  assert.equal(r.listings[1]!.rentPrice, 1138.85); // Display price rounds this to 1139.
  assert.equal(r.listings[0]!.title, 'Toxopeusstraat 210');
  assert.equal(r.listings[0]!.areaM2, 75);
  for (const item of r.listings) {
    assert.equal(Object.hasOwn(item, 'publishedAt'), false);
    assert.equal(Object.hasOwn(item, 'rooms'), false); // API contains bedrooms only.
  }
  const newHome = fixture(); newHome.results.objects[0].status = 5;
  assert.equal(parseSearch(newHome).listings[0]!.availabilityStatus, 'available');
});
test('partial, malformed and duplicate results fail instead of producing an empty or partial success', () => {
  const mutations = [
    (x: any) => x.results.objects.pop(),
    (x: any) => x.count++,
    (x: any) => x.results.complexes.pop(),
    (x: any) => x.results.objects[0].status = 0,
    (x: any) => x.results.objects[0].priceUnformatted = '1470',
    (x: any) => x.results.objects[0].size = null,
    (x: any) => x.results.objects[0].entitytypeid = 2,
    (x: any) => x.results.objects[1] = x.results.objects[0],
    (x: any) => x.results.sortType = 2,
  ];
  for (const mutate of mutations) { const x = fixture(); mutate(x); assert.throws(() => parseSearch(x)); }
  assert.throws(() => parseSearch({}));
  const empty = fixture(); empty.results.objects = []; empty.results.objectsCount = 0; empty.count = 2;
  assert.equal(parseSearch(empty).listings.length, 0);
  delete empty.results.objectsCount; assert.throws(() => parseSearch(empty));
});
test('search request matches the supplied URL including empty filters and numeric coordinates', async () => {
  const r = await collect({ transport: async (url, options) => {
    assert.equal(url, API_URL); assert.equal(options!.redirect, 'manual'); assert.equal(options!.method, 'POST');
    assert.deepEqual(JSON.parse(String(options!.body)), searchPayload());
    const p = searchPayload(); assert.deepEqual(p.filters, [0]); assert.equal(p.priceFrom, 500);
    assert.equal(p.priceTo, 1500); assert.equal(p.radius, 20); assert.equal(p.latitude, 53.219383);
    assert.equal(p.longitude, 6.5665016); assert.equal(p.place, 'Groningen, Nederland');
    return Response.json(fixture());
  } });
  assert.equal(r.inspected, 15);
});
test('HTTP failures, invalid JSON, redirects and body limits cannot record a zero result', async () => {
  let calls = 0;
  const r = await collect({ pause: async () => {}, transport: async () => ++calls < 3 ? new Response('', {status:503}) : Response.json(fixture()) });
  assert.equal(r.inspected, 15); assert.equal(calls, 3);
  calls = 0;
  await assert.rejects(collect({ pause: async () => {}, transport: async () => { calls++; throw Error('network'); } }), /HTTP_TRANSPORT/);
  assert.equal(calls, 3);
  for (const status of [301, 401, 403, 429, 500]) {
    await assert.rejects(collect({ transport: async () => new Response('', { status }) }), e =>
      e instanceof Error && ([401,403].includes(status) ? e.message === 'ACCESS_BLOCKED' : true));
  }
  await assert.rejects(collect({ transport: async () => new Response('challenge', {headers:{'content-type':'text/html'}}) }), /CONTENT_TYPE/);
  await assert.rejects(collect({ transport: async () => new Response('{', {headers:{'content-type':'application/json'}}) }), /INVALID_JSON/);
  await assert.rejects(collect({ signal: AbortSignal.abort(), transport: async () => { throw Error('must not fetch'); } }), /RUN_TIMEOUT/);
  await assert.rejects(collect({ transport: async () => new Response(' '.repeat(8 * 1024 * 1024 + 1), {headers:{'content-type':'application/json'}}) }), /BODY_TOO_LARGE/);
});
test('detail URL validation rejects external hosts, credentials and mismatched identity', () => {
  const path = '/nl/huurwoningen-groningen/westerwal/toxopeusstraat-210-groningen-50412';
  assert.equal(allowedDetailUrl(path, 50412), 'https://www.vesteda.com' + path);
  for (const url of ['https://localhost' + path, 'http://www.vesteda.com' + path,
    'https://user:pass@www.vesteda.com' + path, path + '?redirect=other', path + '#other', '/nl/huurwoningen-groningen/westerwal']) {
    assert.throws(() => allowedDetailUrl(url, 50412));
  }
  assert.throws(() => allowedDetailUrl(path, 10));
});
