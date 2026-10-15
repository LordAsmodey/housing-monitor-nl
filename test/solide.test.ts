import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseSearch, parseCard, cardSections, collect, pageUrl, allowedDetailUrl, SOURCE_ID } from '../src/sources/solide-core';
import { parseEnvironment } from '../src/config/environment';
const registry = require('../scripts/search-settings.cjs');
const fixture = (name = 'search') => readFileSync(`test/fixtures/solide-${name}.html`, 'utf8');
const htmlResponse = (html: string) => new Response(html, { headers: { 'content-type': 'text/html' } });
const noPause = async () => {};
const emptySettings = {...registry.defaults(SOURCE_ID),minRent:19000,maxRent:20000};

test('Solide real pages retain IDs, monthly prices, area and conservative availability', () => {
  const first = parseSearch(fixture());
  assert.equal(first.total, 56); assert.equal(first.pages, 6); assert.equal(first.listings.length, 10);
  assert.deepEqual(first.listings[0], { externalId: '17650', canonicalUrl: 'https://solideverhuur.nl/huurwoningen/groningen/2-engelenpoortje-9712zz/', title: 'Engelenpoortje 2', address: 'Engelenpoortje 2', city: 'Groningen', availabilityStatus: 'available', areaM2: 52, rentPrice: 994 });
  assert.equal(first.listings.filter(x => x.availabilityStatus === 'available').length, 5);
  assert.equal(first.listings[5]!.availabilityStatus, 'unavailable');
  assert.equal(first.listings[8]!.rentPrice, undefined);
  assert.equal(first.listings[8]!.availabilityStatus, 'unavailable');
  assert.equal(first.listings[0]!.rooms, undefined);
  assert.equal(first.listings[0]!.publishedAt, undefined);
  assert.equal(parseSearch(fixture('last'), 6).listings.length, 6);
  assert.equal(parseSearch(fixture('zero'), 1, emptySettings).listings.length, 0);
});

test('Solide rejects incomplete search, changed filters, page loops and challenge HTML', () => {
  assert.throws(() => parseSearch('<h1>Zoekresultaten</h1>'), /SEARCH_STRUCTURE_CHANGED/);
  assert.throws(() => parseSearch('Verify you are human'), /ACCESS_BLOCKED/);
  assert.throws(() => parseSearch(fixture().replace('56 resultaten', '67 resultaten')), /PAGINATION_CHANGED/);
  assert.throws(() => parseSearch(fixture(), 2), /PAGINATION_CHANGED/);
  assert.throws(() => parseSearch(fixture().replace('value="20" selected', 'value="32" selected')), /SEARCH_FILTER_CHANGED/);
  assert.throws(() => parseSearch(fixture(), 1, {...registry.defaults(SOURCE_ID),maxRent:1200}), /SEARCH_FILTER_CHANGED/);
  assert.throws(() => parseSearch(fixture().replace('name="post_type"', 'name="changed_type"')), /SEARCH_FILTER_CHANGED/);
  const card = cardSections(fixture())[0]!;
  assert.throws(() => parseSearch(fixture().replace(card, '')), /INCOMPLETE_SEARCH/);
  assert.throws(() => cardSections(card.slice(0, card.lastIndexOf('</li>'))), /CARD_STRUCTURE_CHANGED/);
  assert.throws(() => parseSearch(fixture().replace('https://solideverhuur.nl/page/2/', 'https://evil.example/page/2/')), /URL_NOT_ALLOWED/);
  assert.throws(() => parseSearch(fixture().replace('56 resultaten', '2001 resultaten')), /LISTING_LIMIT/);
});

test('Solide refuses unsafe links and invalid available metadata, unknown statuses never notify', () => {
  const card = cardSections(fixture())[0]!;
  assert.equal(parseCard(card.replace('epl-status-current', 'epl-status-future')).availabilityStatus, 'unknown');
  assert.equal(parseCard(card.replace('Nieuw', 'Onder optie')).availabilityStatus, 'unavailable');
  assert.throws(() => parseCard(card.replace('&euro;994', '&euro;0')), /INVALID_PRICE/);
  assert.throws(() => parseCard(card.replace('52 m<sup>2</sup>', 'm²')), /CARD_METADATA_MISSING/);
  assert.throws(() => parseCard(card.replace('/Maand', '/Week')), /INVALID_PRICE/);
  for (const path of ['http://solideverhuur.nl/huurwoningen/groningen/test/', 'https://evil.example/huurwoningen/groningen/test/', 'https://a@solideverhuur.nl/huurwoningen/groningen/test/', '/huurwoningen/assen/test/', '/huurwoningen/groningen/test/?x=1']) assert.throws(() => allowedDetailUrl(path), /URL_NOT_ALLOWED/);
});

test('Solide collects all pages and rejects duplicate cards or totals changing mid-run', async () => {
  // Two full real pages reduced to a coherent 16-result catalog for transport tests.
  const first = fixture().replaceAll('56 resultaten', '16 resultaten').replaceAll('/page/6/', '/page/2/').replaceAll('/page/3/', '/page/2/');
  const last = fixture('last').replaceAll('56 resultaten', '16 resultaten').replaceAll('/page/6/', '/page/2/').replaceAll('/page/5/', '/page/1/').replaceAll('/page/4/', '/page/1/').replaceAll('/page/3/', '/page/1/').replaceAll('https://solideverhuur.nl/page/1/', 'https://solideverhuur.nl/');
  const requested: string[] = [];
  const transport: typeof fetch = async target => { requested.push(String(target)); return htmlResponse(requested.length === 1 ? first : last); };
  const result = await collect({ transport, pause: noPause });
  assert.equal(result.inspected, 16); assert.equal(result.pages, 2); assert.equal(result.available, 5);
  assert.deepEqual(requested, [pageUrl(1), pageUrl(2)]);
  const duplicate = last.replace(cardSections(last)[0]!, cardSections(first)[0]!);
  let i = 0;
  await assert.rejects(collect({ transport: async () => htmlResponse(++i === 1 ? first : duplicate), pause: noPause }), /DUPLICATE_CARD/);
  i = 0;
  await assert.rejects(collect({ transport: async () => htmlResponse(++i === 1 ? first : last.replace('16 resultaten', '15 resultaten')), pause: noPause }), /INCOMPLETE_SEARCH|SEARCH_CHANGED_DURING_RUN/);
  await assert.rejects(collect({ transport: async () => htmlResponse(first), pause: noPause }), /INCOMPLETE_SEARCH|PAGINATION_CHANGED/);
});

test('Solide handles HTTP retries, rate limits, redirects and malformed responses', async () => {
  let attempts = 0;
  assert.equal((await collect({ settings:emptySettings, transport: async () => ++attempts < 3 ? new Response('', {status:503}) : htmlResponse(fixture('zero')), pause:noPause })).inspected, 0);
  assert.equal(attempts, 3);
  for (const [status, category] of [[403,'ACCESS_BLOCKED'],[429,'RATE_LIMIT'],[302,'HTTP_STATUS'],[500,'HTTP_STATUS']] as const) {
    await assert.rejects(collect({transport:async()=>new Response('',{status}),pause:noPause}), new RegExp(category));
  }
  await assert.rejects(collect({transport:async()=>Response.json({}),pause:noPause}), /CONTENT_TYPE/);
  await assert.rejects(collect({transport:async()=>htmlResponse('x'.repeat(8 * 1024 * 1024 + 1)),pause:noPause}), /BODY_TOO_LARGE/);
  await assert.rejects(collect({transport:async()=>{throw Error('network')},pause:noPause}), /HTTP_TRANSPORT/);
  await assert.rejects(collect({signal:AbortSignal.abort(),pause:noPause}), /RUN_TIMEOUT/);
});

test('Solide admin settings preserve Groningen and apply rent to query and area before delivery', () => {
  const settings = {...registry.defaults(SOURCE_ID), minRent:500, maxRent:1200, minArea:40};
  const u = new URL(pageUrl(2, settings));
  assert.equal(u.searchParams.get('property_location'), '20');
  assert.equal(u.searchParams.get('property_price_from'), '500');
  assert.equal(u.searchParams.get('property_price_to'), '1200');
  assert.equal(registry.matches(settings, {areaM2:30}, SOURCE_ID), false);
  const env = { DATABASE_URL:'postgresql://u:p@localhost/db', TELEGRAM_CHAT_ID:'-123', REDIS_URL:'redis://localhost:6379' };
  assert.equal(parseEnvironment(env).SOLIDE_MONITORING_ENABLED, true);
  assert.equal(parseEnvironment({...env,SOLIDE_MONITORING_ENABLED:'false'}).SOLIDE_MONITORING_ENABLED, false);
});
