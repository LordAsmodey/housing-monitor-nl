import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseSearch, parseCard, sections, candidate, collect, allowedDetailUrl, pageUrl, SOURCE_ID, SEARCH_URL } from '../src/sources/wonen123-core';
const registry = require('../scripts/search-settings.cjs');
const fixture = (name = 'search') => readFileSync(`test/fixtures/wonen123-${name}.html`, 'utf8');
const defaults = registry.defaults(SOURCE_ID);
const response = (body: string) => new Response(body, { headers: { 'content-type': 'text/html' } });
const first = () => sections(fixture(), 'pandlist-container')[0]!;
const transport: typeof fetch = async target => response(fixture(String(target).endsWith('/2') ? 'page2' : String(target).endsWith('/3') ? 'last' : 'search'));

test('real Groningen cards use stable compound IDs, monthly rent, area and publication date; bedrooms are not rooms', () => {
  const parsed = parseSearch(fixture());
  assert.equal(parsed.pages, 3); assert.equal(parsed.listings.length, 12);
  assert.deepEqual(parsed.listings[0], { externalId: '5423-2', canonicalUrl: 'https://www.123wonen.nl/huur/groningen/benedenwoning/lissabonstraat-5423-2',
    title: 'Groningen, Lissabonstraat', address: 'Lissabonstraat', city: 'Groningen', rentPrice: 2150, areaM2: 62,
    availabilityStatus: 'available', publishedAt: new Date('2026-10-16T00:00:00Z'), propertyType: 'Benedenwoning' });
  assert.equal(parseCard(first().replace('2.150,-', '1.500,50')).rentPrice, 1500.5);
  assert.equal(parsed.listings[7]!.availabilityStatus, 'unavailable');
  // Emmasingel has no visible badge, only the inoptie root class.
  assert.equal(parsed.listings[8]!.availabilityStatus, 'unavailable');
  assert.equal(parsed.listings[9]!.availabilityStatus, 'unavailable');
  assert.equal(parseSearch(fixture('last'), 3).listings.length, 3);
});
test('availability requires a monthly price and explicit availability with no unknown status', () => {
  for (const card of [first().replace('pandlist-container ', 'pandlist-container nieuwstatus'), first().replace('Per direct', 'Onbekend'),
    first().replace('<span>p/mnd</span>', ''), first().replace('Per direct', 'Vanaf 31-02-2027'),
    first().replace('Per direct', ''), first().replace('</div>', '<span class="pand-status">Onbekend</span></div>')])
    assert.equal(parseCard(card).availabilityStatus, 'unknown');
  assert.equal(parseCard(first().replace('Per direct', 'Vanaf 01-01-2027')).availabilityStatus, 'available');
});
test('full traversal validates all pages before excluding rooms and applying configured price and area', async () => {
  const calls: string[] = [];
  const result = await collect({ pause: async () => {}, transport: async (u, o) => { calls.push(String(u)); assert.equal(o!.redirect, 'manual'); return transport(u, o); } });
  assert.deepEqual(calls, [SEARCH_URL, pageUrl(2), pageUrl(3)]);
  assert.equal(result.inspected, 27); assert.equal(result.pages, 3); assert.equal(result.listings.length, 9); assert.equal(result.available, 0);
  const broad = await collect({ settings: { ...defaults, maxRent: 3000 }, transport, pause: async () => {} });
  assert.equal(broad.listings.length, 27); assert.equal(broad.available, 7);
  assert.equal(registry.matches(defaults, { rentPrice: 1500 }, SOURCE_ID), true);
  assert.equal(registry.matches(defaults, { rentPrice: 1500.01 }, SOURCE_ID), false);
  assert.equal(registry.matches(defaults, {}, SOURCE_ID), false);
  assert.equal(registry.matches({ ...defaults, minArea: 80 }, { rentPrice: 900, areaM2: 79 }, SOURCE_ID), false);
  assert.equal(candidate(parseCard(first().replaceAll('benedenwoning/', 'kamer/').replace('>Benedenwoning<', '>Kamer<'))), false);
  assert.equal(candidate(parseCard(first().replace('>Benedenwoning<', '>Onbekend<'))), false);
  assert.equal(candidate(parseCard(first().replace('>Benedenwoning<', '>Appartement<'))), false);
});
test('page identity, filters, structured data, count, URL and truncated cards fail closed', () => {
  for (const html of [fixture().replace('<h1>', '<h2>'), fixture().replace('value="groningen"', 'value="assen"'),
    fixture().replace('rel="canonical"', 'rel="other"'), fixture().replace('"numberOfItems":12', '"numberOfItems":11'),
    fixture().replace('"position":1', '"position":2'), fixture().replace('"name":"Lissabonstraat, Groningen"', '"name":"Other, Groningen"'),
    fixture().replace(first(), ''), fixture().replace('62 m&sup2;', 'm&sup2;'), fixture().replace('2.150,-', '1.5,-'),
    fixture().replace('16-10-2026', '31-02-2026'), fixture().replace('>Groningen,', '>Assen,'),
    fixture().replaceAll('productBrowserCurrentPage">1', 'productBrowserCurrentPage">2'), fixture().replaceAll('/page/2', '/page/3'),
    fixture().replaceAll('/page/2', 'https://evil.test/page/2')]) assert.throws(() => parseSearch(html));
  assert.throws(() => parseSearch(fixture(), 2), /PAGINATION_CHANGED/);
  assert.throws(() => parseSearch('Access denied'), /ACCESS_BLOCKED/);
  assert.throws(() => sections('<div class="pandlist-container">', 'pandlist-container'), /HTML_TRUNCATED/);
  assert.throws(() => parseSearch(fixture().replace(/"numberOfItems":12/, '"numberOfItems":0').replace(first(), '')), /INCOMPLETE_SEARCH/);
  for (const value of ['http://www.123wonen.nl/huur/groningen/studio/test-1-2', 'https://evil.test/huur/groningen/studio/test-1-2',
    'https://user@www.123wonen.nl/huur/groningen/studio/test-1-2', '/huur/groningen/studio/test-1-2?x=1', '/huur/groningen/studio/test-1-2#x', '/huur/assen/studio/test-1-2']) assert.throws(() => allowedDetailUrl(value));
  assert.equal(allowedDetailUrl('/huur/groningen/studio/jan+van+galen-1-2'), 'https://www.123wonen.nl/huur/groningen/studio/jan+van+galen-1-2');
  assert.throws(() => pageUrl(101), /PAGE_LIMIT/);
});
test('partial collection, changing page count and duplicates never return partial success', async () => {
  await assert.rejects(collect({ pause: async () => {}, transport: async u => String(u).endsWith('/3') ? new Response('', { status: 500 }) : transport(u) }), /HTTP_STATUS/);
  await assert.rejects(collect({ pause: async () => {}, transport: async u => response(fixture(String(u).endsWith('/2') ? 'page2' : 'search').replaceAll('</span>/3', String(u).endsWith('/2') ? '</span>/4' : '</span>/3')) }), /SEARCH_CHANGED_DURING_RUN/);
  // Derive the real first second-page URL and name rather than depending on its archived ID.
  const second = parseSearch(fixture('page2'), 2).listings[0]!;
  const duplicatePage = fixture('page2').replaceAll(second.canonicalUrl, parseCard(first()).canonicalUrl).replaceAll(second.address!, 'Lissabonstraat');
  await assert.rejects(collect({ pause: async () => {}, transport: async u => String(u).endsWith('/2') ? response(duplicatePage) : transport(u) }), /DUPLICATE_CARD/);
});
test('HTTP retries, rate limits, invalid bodies and timeout are bounded and diagnostic', async () => {
  let calls = 0;
  await collect({ transport: async u => ++calls <= 2 ? new Response('', { status: 503 }) : transport(u), pause: async () => {} });
  assert.equal(calls, 5);
  for (const [status, category] of [[302, 'HTTP_STATUS'], [403, 'ACCESS_BLOCKED'], [429, 'RATE_LIMIT'], [500, 'HTTP_STATUS']] as const)
    await assert.rejects(collect({ transport: async () => new Response('', { status }) }), new RegExp(category));
  await assert.rejects(collect({ transport: async () => Response.json({}) }), /CONTENT_TYPE/);
  await assert.rejects(collect({ transport: async () => response('') }), /SEARCH_STRUCTURE_CHANGED/);
  await assert.rejects(collect({ signal: AbortSignal.abort() }), /RUN_TIMEOUT/);
  await assert.rejects(collect({ transport: async () => response(' '.repeat(8 * 1024 * 1024 + 1)) }), /BODY_TOO_LARGE/);
  await assert.rejects(collect({ transport: async () => { throw Error('network'); }, pause: async () => {} }), /HTTP_TRANSPORT/);
});
