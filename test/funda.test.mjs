import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { SEARCH_URL, FILTERS, allowedUrl, parseSearch, parseDetail, publicationDate, distanceKm, matches, collect } = require('../scripts/funda-core.cjs');

// Synthetic contract fixtures: these are deliberately not presented as live Funda captures.
const now = new Date('2026-10-12T12:00:00Z');
const url = id => `https://www.funda.nl/detail/huur/groningen/appartement-test-${id}/${id}/`;
function search(ids, total = ids.length, next) {
  return `<h1>${total} huurwoningen in Groningen</h1>${ids.map(id => `<a href="${url(id)}">Woning</a>`).join('')}
    ${next ? `<a rel="next" href="${next.replace(/&/g, '&amp;')}">Volgende</a>` : ''}`;
}
function detail({ rent = '1.500', date = '2026-10-11T12:00:00Z', lat = FILTERS.latitude,
  lon = FILTERS.longitude, status = 'Beschikbaar' } = {}) {
  return `<h1>Teststraat 1</h1><script type="application/ld+json">${JSON.stringify({
    '@type': 'Apartment', address: { '@type': 'PostalAddress', addressLocality: 'Groningen' },
    geo: { '@type': 'GeoCoordinates', latitude: lat, longitude: lon } })}</script>
    <dl><dt>Status</dt><dd>${status}</dd><dt>Huurprijs</dt><dd>€ ${rent} /mnd</dd>
    <dt>Aangeboden sinds</dt><dd>${date}</dd><dt>Wonen</dt><dd>65 m²</dd>
    <dt>Aantal kamers</dt><dd>3 kamers (2 slaapkamers)</dd></dl>`;
}
const response = html => new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
const options = { now, pause: async () => {} };

test('€1500 and 72 hours are inclusive; older, expensive and distant listings are excluded', () => {
  const item = parseDetail(detail({ date: '2026-10-09T12:00:00Z' }), url(1));
  assert.equal(matches(item, now), true);
  assert.equal(matches({ ...item, rentPrice: 1500.01 }, now), false);
  assert.equal(matches({ ...item, publishedAt: new Date('2026-10-09T11:59:59Z') }, now), false);
  assert.equal(matches({ ...item, latitude: 52.1 }, now), false);
  assert.throws(() => matches({ ...item, publishedAt: new Date('2026-10-13T12:00:00Z') }, now), /FUTURE_PUBLICATION_DATE/);
  assert.equal(distanceKm(FILTERS.latitude, FILTERS.longitude), 0);
  const northBoundary = FILTERS.latitude + 30 / 6371.0088 * 180 / Math.PI;
  assert.ok(Math.abs(distanceKm(northBoundary, FILTERS.longitude) - 30) < 1e-9);
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

test('missing publication, rent, coordinates or availability fails validation instead of producing empty findings', () => {
  for (const html of [detail().replace(/<dt>Aangeboden sinds<\/dt><dd>.*?<\/dd>/, ''),
    detail().replace('€ 1.500 /mnd', 'Prijs op aanvraag'), detail().replace('"latitude":53.2194', '"latitude":null'),
    detail({ status: 'Unknown' })]) {
    assert.throws(() => parseDetail(html, url(1)));
  }
  assert.equal(parseDetail(detail({ status: 'Verhuurd' }), url(1)), null);
  assert.equal(parseDetail(detail({ status: 'Onder bod' }), url(1)), null);
  assert.equal(parseDetail(detail(), url(1).replace('appartement-test-', 'parkeergelegenheid-test-')), null);
  assert.throws(() => parseSearch('<h1>Log in</h1>'), /SEARCH_STRUCTURE_CHANGED/);
  assert.throws(() => parseSearch('<h1>Verify you are human</h1>'), /HUMAN_CHECK/);
  assert.throws(() => parseSearch('<title>Je bent bijna op de pagina die je zoekt [funda]</title><h1>Je bent bijna op de pagina die je zoekt</h1>'),
    error => error.category === 'HUMAN_CHECK' && error.blocked === true);
  assert.equal(parseSearch('<h1>0 huurwoningen in Groningen</h1>').total, 0);
});

test('public Op Funda date works when Aangeboden sinds is login-gated', () => {
  const html = detail({ date: 'Log in om te bekijken' }) + '<div>5-10-2026</div><div>Op Funda</div>';
  assert.equal(parseDetail(html, url(1)).publishedAt.toISOString(), '2026-10-04T22:00:00.000Z');
  assert.equal(parseSearch('<h1>Huurwoningen Groningen</h1><span>1 huurwoningen in Groningen</span><a href="' + url(1) + '">Woning</a>').total, 1);
});

test('collector follows pagination, deduplicates links, applies all filters and carries publication date', async () => {
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
  assert.deepEqual(result.listings.map(x => x.externalId), ['1']);
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

// Minimal sanitized capture of the coordinate structure observed on a live detail
// page, 2026-10-12; surrounding listing fixtures above remain synthetic.
test('public Nuxt indexed coordinates validate radius without guessing from the city',()=>{
  const data=[null,{lat:2,lng:3},53.146248,7.0384274];
  const html=detail().replace(/,"geo":\{[^}]+\}/,'')+'<script id="__NUXT_DATA__" type="application/json">'+JSON.stringify(data)+'</script>';
  const item=parseDetail(html,url(1));assert.equal(item.latitude,53.146248);assert.equal(matches(item,now),false);
  assert.throws(()=>parseDetail(html.replace('53.146248','null'),url(1)),/LOCATION_MISSING/);
  const ambiguous=html.replace('[null,', '[{"lat":5,"lng":6},').replace('7.0384274]','7.0384274,null,53.2194,6.5665]');
  assert.throws(()=>parseDetail(ambiguous,url(1)),/LOCATION_AMBIGUOUS/);
});
