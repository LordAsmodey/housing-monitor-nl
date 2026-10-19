import { z } from 'zod';
import type { ListingInput } from '../listings/listings.service';
export const SourceError: new (category: string, blocked?: boolean, retryAfterSeconds?: number) =>
  Error & { category: string; blocked: boolean; retryAfterSeconds: number } =
  require('../../scripts/funda-core.cjs').FundaError;

export const SOURCE_ID = '123wonen:groningen-homes';
export const SEARCH_URL = 'https://www.123wonen.nl/huurwoningen/in/groningen';
export const FILTERS = { city: 'Groningen', minRent: 0, maxRent: 1500, independentHousing: true };
const registry = require('../../scripts/search-settings.cjs');
const attrs = (tag: string): Record<string, string> => Object.fromEntries(
  [...tag.matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map(m => [m[1]!.toLowerCase(), m[2] ?? m[3]!])
);
const classes = (tag: string) => (attrs(tag).class ?? '').split(/\s+/).filter(Boolean);
function text(html: string) {
  return html.replace(/<script\b[^>]*>[\s\S]*?<\/script>|<style\b[^>]*>[\s\S]*?<\/style>|<!--[\s\S]*?-->/gi, '')
    .replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&sup2;/g, '²').replace(/&euro;/g, '€')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => Number(n) <= 0x10ffff ? String.fromCodePoint(Number(n)) : '')
    .replace(/\s+/g, ' ').trim();
}
// Balanced divs retain each entire card, including nested status and specification blocks.
export function sections(html: string, className: string) {
  const result: string[] = []; let start: number | undefined; let depth = 0;
  for (const m of html.matchAll(/<\/?div\b[^>]*>/gi)) {
    if (/^<\//.test(m[0])) {
      if (start !== undefined && --depth === 0) { result.push(html.slice(start, m.index! + m[0].length)); start = undefined; }
    } else if (start !== undefined) depth++;
    else if (classes(m[0]).includes(className)) { start = m.index; depth = 1; }
  }
  if (start !== undefined) throw new SourceError('HTML_TRUNCATED');
  return result;
}
function url(value: string) {
  let u: URL;
  try { u = new URL(value, SEARCH_URL); } catch { throw new SourceError('INVALID_URL'); }
  if (u.protocol !== 'https:' || u.hostname !== 'www.123wonen.nl' || u.port || u.username || u.password || u.search || u.hash) throw new SourceError('URL_NOT_ALLOWED');
  return u;
}
export function allowedDetailUrl(value: string) {
  const u = url(value);
  if (!/^\/huur\/groningen\/[a-z-]+\/[a-z0-9+%-]+-\d{1,12}-\d{1,8}$/.test(u.pathname)) throw new SourceError('URL_NOT_ALLOWED');
  return u.href;
}
export function pageUrl(page: number) {
  if (!Number.isInteger(page) || page < 1 || page > 100) throw new SourceError('PAGE_LIMIT');
  return SEARCH_URL + (page === 1 ? '' : `/page/${page}`);
}
type Card = ListingInput & { propertyType: string };
export function parseCard(html: string): Card {
  const root = html.match(/^<div\b[^>]*>/i)?.[0] ?? '';
  const links = [...html.matchAll(/<a\b[^>]*>/gi)].map(m => attrs(m[0]).href);
  if (links.length !== 1 || !links[0]) throw new SourceError('CARD_STRUCTURE_CHANGED');
  const canonicalUrl = allowedDetailUrl(links[0]);
  const externalId = new URL(canonicalUrl).pathname.match(/-(\d+-\d+)$/)![1]!;
  const click = attrs(root).onclick?.match(/^location\.href='([^']+)';$/)?.[1];
  if (!classes(root).includes('pandlist-container') || !click || allowedDetailUrl(click) !== canonicalUrl) throw new SourceError('CARD_STRUCTURE_CHANGED');
  const titles = sections(html, 'pand-title');
  const title = text(titles[0] ?? '');
  const address = text(titles[0]?.match(/<span\b[^>]*class="pand-address"[^>]*>([\s\S]*?)<\/span>/)?.[1] ?? '');
  const specs: Record<string, string> = {};
  const specSections = sections(html, 'pand-specs');
  for (const m of (specSections[0] ?? '').matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)) {
    const spans = [...m[1]!.matchAll(/<span\b[^>]*>([\s\S]*?)<\/span>/gi)].map(s => text(s[1]!));
    if (spans.length !== 2 || !spans[0] || specs[spans[0]] !== undefined) throw new SourceError('CARD_METADATA_MISSING');
    specs[spans[0]] = spans[1]!;
  }
  const prices = sections(html, 'pand-price');
  // Some archived cards omit the period. They remain unavailable; active cards must say p/mnd.
  const price = text(prices[0] ?? '').match(/^€\s*(\d{1,3}(?:\.\d{3})*(?:,\d{2}|,-)?|\d+(?:,\d{2}|,-)?)(?:\s*(p\/mnd))?$/);
  const rentPrice = Number(price?.[1]?.replace(/\./g, '').replace(/,-$/, '').replace(',', '.'));
  const area = specs.Woonoppervlakte?.match(/^(\d+(?:[.,]\d+)?) m²$/);
  const areaM2 = Number(area?.[1]?.replace(',', '.'));
  const propertyType = specs.Type ?? '';
  if (titles.length !== 1 || !address || title !== `Groningen, ${address}` || title.length > 500 ||
      prices.length !== 1 || !price || !rentPrice || rentPrice > 99999999 || !areaM2 || areaM2 > 999999 || !propertyType) throw new SourceError('CARD_METADATA_MISSING');
  const badges = [...html.matchAll(/<span\b[^>]*>[\s\S]*?<\/span>/gi)].filter(m => classes(m[0].split('>')[0] + '>').includes('pand-status'));
  const unavailable = classes(root).some(c => ['verhuurd', 'inoptie', 'gereserveerd'].includes(c)) || badges.some(m => /^(Verhuurd(?: onder voorbehoud)?|In optie|Onder optie|Gereserveerd)$/i.test(text(m[0])));
  const knownClasses = classes(root).every(c => ['pandlist-container', 'verhuurd', 'inoptie', 'gereserveerd'].includes(c));
  const availability = specs.Beschikbaarheid ?? '';
  const date = availability.match(/^Vanaf (\d{2})-(\d{2})-(\d{4})$/);
  const validDate = date && validDay(`${date[3]}-${date[2]}-${date[1]}`);
  const availabilityStatus = unavailable ? 'unavailable' : knownClasses && !badges.length && price[2] && (availability === 'Per direct' || validDate) ? 'available' : 'unknown';
  const published = specs['Aangeboden sinds']?.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  const publishedIso = published ? `${published[3]}-${published[2]}-${published[1]}` : '';
  if (!validDay(publishedIso)) throw new SourceError('CARD_METADATA_MISSING');
  // Slaapkamers counts bedrooms, so do not populate the total-rooms field.
  return { externalId, canonicalUrl, title, address, city: 'Groningen', rentPrice, areaM2, availabilityStatus,
    publishedAt: new Date(publishedIso + 'T00:00:00.000Z'), propertyType };
}
function validDay(iso: string) {
  const date = new Date(iso + 'T00:00:00.000Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === iso;
}
export function candidate(item: Card) {
  const types: Record<string, string> = { Appartement: 'appartement', Studio: 'studio', Benedenwoning: 'benedenwoning', Bovenwoning: 'bovenwoning',
    Eengezinswoning: 'eengezinswoning', Tussenwoning: 'tussenwoning', Hoekwoning: 'hoekwoning', Vrijstaandewoning: 'vrijstaandewoning', Maisonette: 'maisonette' };
  return types[item.propertyType] === new URL(item.canonicalUrl).pathname.split('/')[3];
}
const listSchema = z.object({ '@type': z.literal('ItemList'), '@id': z.literal(SEARCH_URL + '#objects'),
  numberOfItems: z.number().int().min(0).max(12), itemListElement: z.array(z.object({ '@type': z.literal('ListItem'),
    position: z.number().int(), url: z.string(), name: z.string() })).max(12) });
export function parseSearch(html: string, page = 1) {
  pageUrl(page);
  if (/verify you are human|just a moment|access denied/i.test(text(html))) throw new SourceError('ACCESS_BLOCKED', true);
  if (!/<h1>Ons aanbod huurwoningen in Groningen<\/h1>/.test(html) ||
      ![...html.matchAll(/<link\b[^>]*>/gi)].some(m => attrs(m[0]).rel === 'canonical' && attrs(m[0]).href === SEARCH_URL)) throw new SourceError('SEARCH_STRUCTURE_CHANGED');
  const location = [...html.matchAll(/<input\b[^>]*>/gi)].map(m => attrs(m[0])).filter(a => a.name === 'location');
  if (location.length !== 1 || location[0]!.value !== 'groningen') throw new SourceError('SEARCH_FILTER_CHANGED');
  let objects: unknown[] = [];
  for (const m of html.matchAll(/<script\b[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)) {
    try { const value = JSON.parse(m[1]!); objects.push(...(Array.isArray(value) ? value : [value])); }
    catch { throw new SourceError('INVALID_JSON'); }
  }
  const lists = objects.filter((o: any) => o?.['@type'] === 'ItemList');
  const parsed = listSchema.safeParse(lists[0]);
  if (lists.length !== 1 || !parsed.success) throw new SourceError('SEARCH_METADATA_CHANGED');
  const data = parsed.data;
  const containers = sections(html, 'pandlist');
  if (containers.length !== 1) throw new SourceError('SEARCH_STRUCTURE_CHANGED');
  const rawCards = sections(containers[0]!, 'pandlist-container');
  // Zero has no verified live contract yet: never overwrite history with an inferred empty result.
  if (!data.numberOfItems && !rawCards.length) throw new SourceError('EMPTY_SEARCH_UNCONFIRMED');
  if (rawCards.length !== data.numberOfItems || data.itemListElement.length !== rawCards.length) throw new SourceError('INCOMPLETE_SEARCH');
  const listings = rawCards.map(parseCard);
  listings.forEach((item, i) => {
    const meta = data.itemListElement[i]!;
    if (meta.position !== i + 1 || allowedDetailUrl(meta.url) !== item.canonicalUrl || meta.name !== `${item.address}, Groningen`) throw new SourceError('SEARCH_METADATA_CHANGED');
  });
  const pagers = sections(html, 'productBrowser'); let pages: number | undefined;
  if (pagers.length !== 2) throw new SourceError('PAGINATION_CHANGED');
  for (const pager of pagers) {
    const numbers = pager.match(/<span class="productBrowserCurrentPage">(\d+)<\/span>\/(\d+)/);
    const count = Number(numbers?.[2]);
    if (Number(numbers?.[1]) !== page || !count || count > 100 || page > count || (pages !== undefined && pages !== count)) throw new SourceError('PAGINATION_CHANGED');
    pages = count;
    const links = [...pager.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)];
    const expected = [ ...(page > 1 ? [['vorige', page - 1] as const] : []), ...(page < count ? [['volgende', page + 1] as const] : []) ];
    if (links.length !== expected.length || links.some((m, i) => text(m[2]!) !== expected[i]![0] || url(attrs(m[1]!).href ?? '').href !== pageUrl(expected[i]![1]))) throw new SourceError('PAGINATION_CHANGED');
  }
  if (page < pages! && listings.length !== 12 || !listings.length) throw new SourceError('INCOMPLETE_SEARCH');
  return { listings, pages: pages! };
}
export async function collect({ settings = registry.defaults(SOURCE_ID), transport = fetch, signal = AbortSignal.timeout(120000),
  pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)) }:
  { settings?: Record<string, number | null>; transport?: typeof fetch; signal?: AbortSignal; pause?: (ms: number) => Promise<void> } = {}) {
  registry.validate(SOURCE_ID, settings);
  const items: Card[] = []; let pages = 1;
  for (let page = 1; page <= pages; page++) {
    if (page > 1) await pause(300);
    const parsed = parseSearch(await fetchHtml(pageUrl(page), transport, signal, pause), page);
    if (page > 1 && pages !== parsed.pages) throw new SourceError('SEARCH_CHANGED_DURING_RUN');
    pages = parsed.pages; items.push(...parsed.listings);
  }
  if (new Set(items.map(x => x.externalId)).size !== items.length || new Set(items.map(x => x.canonicalUrl)).size !== items.length) throw new SourceError('DUPLICATE_CARD');
  const listings = items.filter(item => candidate(item) && registry.matches(settings, item, SOURCE_ID)).map(({ propertyType: _, ...item }) => item);
  return { listings, inspected: items.length, total: items.length, pages, available: listings.filter(x => x.availabilityStatus === 'available').length };
}

async function fetchHtml(target: string, transport: typeof fetch, signal: AbortSignal, pause: (ms: number) => Promise<void>) {
  let response: Response | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (signal.aborted) throw new SourceError('RUN_TIMEOUT');
    try { response = await transport(target, { redirect: 'manual', signal, headers: { Accept: 'text/html', 'Accept-Language': 'nl-NL' } }); }
    catch { if (attempt === 2 || signal.aborted) throw new SourceError(signal.aborted ? 'RUN_TIMEOUT' : 'HTTP_TRANSPORT'); await pause(1000); continue; }
    if (![502, 503, 504].includes(response.status) || attempt === 2) break;
    await response.body?.cancel(); await pause(1000);
  }
  if (!response) throw new SourceError('HTTP_TRANSPORT');
  if ([401, 403].includes(response.status)) throw new SourceError('ACCESS_BLOCKED', true);
  if (response.status === 429) throw new SourceError('RATE_LIMIT', false, 900);
  if (!response.ok) throw new SourceError('HTTP_STATUS');
  if (!/text\/html/i.test(response.headers.get('content-type') ?? '')) throw new SourceError('CONTENT_TYPE');
  const reader = response.body?.getReader(); if (!reader) throw new SourceError('EMPTY_BODY');
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length;
      if (size > 8 * 1024 * 1024) { await reader.cancel(); throw new SourceError('BODY_TOO_LARGE'); }
      chunks.push(value);
    }
  } catch (error) { if (error instanceof SourceError) throw error; throw new SourceError(signal.aborted ? 'RUN_TIMEOUT' : 'HTTP_TRANSPORT'); }
  return Buffer.concat(chunks).toString('utf8');
}
