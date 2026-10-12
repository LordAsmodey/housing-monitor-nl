import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { SEARCH_URL, FILTERS, allowedUrl, parseSearch, parseDetail, publicationDate, collect } = require('../scripts/funda-core.cjs');

// Synthetic contract fixtures: these are deliberately not presented as live Funda captures.
const now = new Date('2026-10-12T12:00:00Z');
const url = id => `https://www.funda.nl/detail/huur/groningen/appartement-test-${id}/${id}/`;
function search(ids, total = ids.length, next) {
  return `<h1>${total} huurwoningen in Groningen</h1>${ids.map(id => `<a href="${url(id)}">Woning</a>`).join('')}
    ${next ? `<a rel="next" href="${next.replace(/&/g, '&amp;')}">Volgende</a>` : ''}`;
}
function detail({ rent = '1.500', date = '2026-10-11T12:00:00Z', lat = 53.2194,
  lon = 6.5665, status = 'Beschikbaar' } = {}) {
  return `<h1>Teststraat 1</h1><script type="application/ld+json">${JSON.stringify({
    '@type': 'Apartment', address: { '@type': 'PostalAddress', addressLocality: 'Groningen' },
    geo: { '@type': 'GeoCoordinates', latitude: lat, longitude: lon } })}</script>
    <dl><dt>Status</dt><dd>${status}</dd><dt>Huurprijs</dt><dd>€ ${rent} /mnd</dd>
    <dt>Aangeboden sinds</dt><dd>${date}</dd><dt>Wonen</dt><dd>65 m²</dd>
    <dt>Aantal kamers</dt><dd>3 kamers (2 slaapkamers)</dd></dl>`;
}
const response = html => new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
const options = { now, pause: async () => {} };

test('search delegates all agreed filters including today to Funda',()=>{
  const query=new URL(SEARCH_URL);
  assert.equal(query.search,'?selected_area=groningen&radius_search=30&price=0-1500&publication_date=1');
  assert.equal(FILTERS.publication,'today');
  for(const [key,value] of [['selected_area','amsterdam'],['radius_search','50'],['price','0-2000'],['publication_date','3']]){
    const changed=new URL(query);changed.searchParams.set(key,value);
    assert.throws(()=>allowedUrl(changed.href,'search'),/SEARCH_FILTER_CHANGED/);
    const missing=new URL(query);missing.searchParams.delete(key);
    assert.throws(()=>allowedUrl(missing.href,'search'),/SEARCH_FILTER_CHANGED/);
  }
});

test('Dutch dates use Amsterdam midnight across winter, summer and DST transitions', () => {
  assert.equal(publicationDate('12 oktober 2026').toISOString(), '2026-10-11T22:00:00.000Z');
  assert.equal(publicationDate('2026-01-12').toISOString(), '2026-01-11T23:00:00.000Z');
  assert.equal(publicationDate('5-10-2026').toISOString(), '2026-10-04T22:00:00.000Z');
  assert.equal(publicationDate('29 maart 2026').toISOString(), '2026-03-28T23:00:00.000Z');
  assert.equal(publicationDate('25 oktober 2026').toISOString(), '2026-10-24T22:00:00.000Z');
  for (const value of ['31 februari 2026', '3 dagen', 'vandaag', 'Log in om te bekijken', '']) {
    assert.throws(() => publicationDate(value));
  }
});

test('only HTTPS rental URLs are accepted; tracking is removed and English URLs deduplicate', () => {
  assert.equal(allowedUrl(url(1) + '?utm_source=email#photo'), url(1));
  assert.equal(allowedUrl(url(1).replace('/detail/', '/en/detail/')), url(1));
  for (const value of ['http://www.funda.nl/detail/huur/g/a/1/', 'https://www.funda.nl.evil.test/detail/huur/g/a/1/',
    'https://user:secret@www.funda.nl/detail/huur/g/a/1/', 'https://127.0.0.1/detail/huur/g/a/1/',
    'https://www.funda.nl:444/detail/huur/g/a/1/', 'https://www.funda.nl/detail/koop/g/a/1/']) {
    assert.throws(() => allowedUrl(value));
  }
  assert.throws(() => allowedUrl(SEARCH_URL.replace('1500', '2000'), 'search'), /SEARCH_FILTER_CHANGED/);
});

test('search-filtered cards need no coordinates or publication date, but malformed cards and challenges still fail',()=>{
  const minimal=detail().replace(/<dt>Aangeboden sinds<\/dt><dd>.*?<\/dd>/,'').replace(/,"geo":\{[^}]+\}/,'');
  assert.equal(parseDetail(minimal,url(1)).publishedAt,undefined);
  assert.equal(parseDetail(minimal,url(1)).latitude,undefined);
  assert.throws(()=>parseDetail(detail().replace('€ 1.500 /mnd','Prijs op aanvraag'),url(1)),/MONTHLY_RENT_MISSING/);
  assert.throws(()=>parseDetail(detail({status:'Unknown'}),url(1)),/AVAILABILITY_MISSING/);
  assert.equal(parseDetail(detail({status:'Verhuurd'}),url(1)),null);
  assert.equal(parseDetail(detail({status:'Onder bod'}),url(1)),null);
  assert.equal(parseDetail(detail(),url(1).replace('appartement-test-','parkeergelegenheid-test-')),null);
  assert.throws(()=>parseSearch('<h1>Log in</h1>'),/SEARCH_STRUCTURE_CHANGED/);
  assert.throws(()=>parseSearch('<h1>Verify you are human</h1>'),e=>e.category==='HUMAN_CHECK'&&e.blocked);
  assert.throws(()=>parseSearch('<title>Je bent bijna op de pagina die je zoekt [funda]</title>'),/HUMAN_CHECK/);
  assert.equal(parseSearch('<h1>0 huurwoningen in Groningen</h1>').total,0);
});

test('public Op Funda date works when Aangeboden sinds is login-gated', () => {
  const html = detail({ date: 'Log in om te bekijken' }) + '<div>5-10-2026</div><div>Op Funda</div>';
  assert.equal(parseDetail(html, url(1)).publishedAt.toISOString(), '2026-10-04T22:00:00.000Z');
  assert.equal(parseSearch('<h1>Huurwoningen Groningen</h1><span>1 huurwoningen in Groningen</span><a href="' + url(1) + '">Woning</a>').total, 1);
});

test('collector follows filtered pagination and deduplicates without repeating site filters', async () => {
  const next = SEARCH_URL + '&page=2';
  const calls = [];
  const transport = async value => {
    calls.push(value);
    if (value === SEARCH_URL) return response(search([1, 2], 3, next));
    if (value === next) return response(search([2, 3], 3));
    return response(detail(value === url(2) ? { rent: '1.501' } : value === url(3) ? { date: '2026-10-01T00:00:00Z' } : {}));
  };
  const result = await collect({ ...options, transport });
  assert.equal(result.inspected, 3); assert.equal(result.pages, 2);
  assert.deepEqual(result.listings.map(x => x.externalId), ['1','2','3']);
  assert.equal(result.listings[0].publishedAt.toISOString(), '2026-10-11T12:00:00.000Z');
  assert.equal(result.listings[0].latitude, undefined);
  assert.equal(calls.filter(x => x === url(2)).length, 1);
});

test('HTTP blocks, rate limits, redirects and partial pagination never count as success', async () => {
  for (const [status, category] of [[403, 'ACCESS_BLOCKED'], [401, 'ACCESS_BLOCKED'], [429, 'RATE_LIMIT'], [302, 'UNEXPECTED_REDIRECT'], [500, 'HTTP_STATUS']]) {
    await assert.rejects(collect({ ...options, transport: async () => new Response('', { status, headers: { 'retry-after': '7200' } }) }),
      error => error.category === category && (status !== 429 || error.retryAfterSeconds === 7200));
  }
  await assert.rejects(collect({ ...options, transport: async () => response(search([1], 2)) }), /PAGINATION_NOT_ADVANCING/);
  await assert.rejects(collect({ ...options, transport: async () => response(search([1], 1, SEARCH_URL)) }), /PAGINATION_LIMIT/);
  await assert.rejects(collect({ ...options, maxListings: 1, transport: async () => response(search([1, 2])) }), /LISTING_LIMIT/);
  await assert.rejects(collect({ ...options, transport: async () => response('Access denied') }), /HUMAN_CHECK/);
});

test('late detail failure discards earlier findings; only explicit empty searches succeed', async () => {
  await assert.rejects(collect({ ...options, transport: async value => value === SEARCH_URL ? response(search([1, 2]))
    : response(value === url(1) ? detail() : '<h1>Not a listing</h1>') }), /AVAILABILITY_MISSING/);
  assert.deepEqual((await collect({ ...options, transport: async () => response(search([])) })).listings, []);
  await assert.rejects(collect({ ...options, transport: async () => new Response('json', { headers: { 'content-type': 'application/json' } }) }), /CONTENT_TYPE/);
});

test('response size is bounded before parsing', async () => {
  await assert.rejects(collect({ ...options, transport: async () => response('x'.repeat(5 * 1024 * 1024 + 1)) }), /BODY_TOO_LARGE/);
});
