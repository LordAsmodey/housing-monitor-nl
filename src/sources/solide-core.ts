import type { ListingInput } from '../listings/listings.service';
export const SourceError: new (category: string, blocked?: boolean, retryAfterSeconds?: number) =>
  Error & { category: string; blocked: boolean; retryAfterSeconds: number } =
  require('../../scripts/funda-core.cjs').FundaError;

export const SOURCE_ID = 'solide:groningen-rental';
export const SEARCH_URL = 'https://solideverhuur.nl/?action=epl_search&post_type=rental&property_location=20&property_price_to=1500';
export const FILTERS = { city: 'Groningen', locationId: 20, minRent: 0, maxRent: 1500 };
const registry = require('../../scripts/search-settings.cjs');
const attrs = (tag: string): Record<string, string> => Object.fromEntries(
  [...tag.matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map(m => [m[1]!.toLowerCase(), m[2] ?? m[3]!])
);
function text(html: string) {
  return html.replace(/<script\b[^>]*>[\s\S]*?<\/script>|<style\b[^>]*>[\s\S]*?<\/style>|<!--[\s\S]*?-->/gi, '')
    .replace(/<sup>2<\/sup>/gi, '²').replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&euro;/g, '€').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => Number(n) <= 0x10ffff ? String.fromCodePoint(Number(n)) : '')
    .replace(/\s+/g, ' ').trim();
}
function url(value: string) {
  let u: URL;
  try { u = new URL(text(value), 'https://solideverhuur.nl'); } catch { throw new SourceError('INVALID_URL'); }
  if (u.protocol !== 'https:' || u.hostname !== 'solideverhuur.nl' || u.port || u.username || u.password || u.hash) throw new SourceError('URL_NOT_ALLOWED');
  return u;
}
export function allowedDetailUrl(value: string) {
  const u = url(value);
  if (u.search || !/^\/huurwoningen\/groningen\/[a-z0-9-]+\/$/.test(u.pathname)) throw new SourceError('URL_NOT_ALLOWED');
  return u.href;
}
export function pageUrl(page: number, settings = registry.defaults(SOURCE_ID)) {
  if (!Number.isInteger(page) || page < 1 || page > 200) throw new SourceError('PAGE_LIMIT');
  const u = new URL(registry.queryUrl(SOURCE_ID, SEARCH_URL, settings));
  if (page > 1) u.pathname = `/page/${page}/`;
  return u.href;
}
// Cards contain nested <li> specifications; stop only at the matching outer close.
export function cardSections(html: string) {
  const cards: string[] = []; let start: number | undefined; let depth = 0;
  for (const m of html.matchAll(/<\/?li\b[^>]*>/gi)) {
    if (/^<\/li/i.test(m[0])) {
      if (start !== undefined && --depth === 0) { cards.push(html.slice(start, m.index! + m[0].length)); start = undefined; }
    } else if (start !== undefined) depth++;
    else if ((attrs(m[0]).class ?? '').split(/\s+/).includes('epl-listing-post')) { start = m.index; depth = 1; }
  }
  if (start !== undefined) throw new SourceError('CARD_STRUCTURE_CHANGED');
  return cards;
}
export function parseCard(html: string): ListingInput {
  const a = attrs(html.match(/^<li\b[^>]*>/i)?.[0] ?? '');
  const externalId = a.id?.match(/^post-(\d+)$/)?.[1];
  const title = text(html.match(/<span\b[^>]*class="street-name"[^>]*>([\s\S]*?)<\/span>/i)?.[1] ?? '');
  const postal = text(html.match(/<small\b[^>]*class="postal-code"[^>]*>([\s\S]*?)<\/small>/i)?.[1] ?? '');
  const href = html.match(/<a\b[^>]*href="([^"]+)"/i)?.[1];
  if (!externalId || !title || title.length > 500 || !/^\d{4}\s?[A-Z]{2} Groningen$/.test(postal) || !href || !a.class?.split(/\s+/).includes('type-rental')) throw new SourceError('CARD_STRUCTURE_CHANGED');
  const canonicalUrl = allowedDetailUrl(href);
  const links = [...html.matchAll(/<a\b[^>]*href="([^"]+)"/gi)];
  if (links.some(m => allowedDetailUrl(m[1]!) !== canonicalUrl)) throw new SourceError('CARD_STRUCTURE_CHANGED');
  const visible = text(html);
  const status = a.class.match(/\bepl-status-([a-z-]+)\b/)?.[1];
  const unavailable = ['leased', 'under-reservation', 'sold', 'withdrawn'].includes(status ?? '') || /\bVerhuurd\b|\bOnder optie\b/i.test(visible);
  const availabilityStatus = unavailable ? 'unavailable' : status === 'current' ? 'available' : 'unknown';
  const price = visible.match(/€\s*([\d.,]+)\s*\/Maand/i)?.[1];
  const rentPrice = price && /^\d{1,3}(?:\.\d{3})*(?:,\d{2})?$|^\d+(?:,\d{2})?$/.test(price) ? Number(price.replace(/\./g, '').replace(',', '.')) : undefined;
  if ((price && rentPrice === undefined) || (availabilityStatus === 'available' && (!rentPrice || rentPrice > 99999999))) throw new SourceError('INVALID_PRICE');
  const area = visible.match(/\b(\d+(?:[.,]\d+)?)\s*m²/)?.[1];
  const areaM2 = area ? Number(area.replace(',', '.')) : undefined;
  if (!areaM2 || areaM2 > 999999) throw new SourceError('CARD_METADATA_MISSING');
  // The bed icon counts bedrooms, not total rooms. No publication date is exposed.
  return { externalId, canonicalUrl, title, address: title, city: 'Groningen', availabilityStatus, areaM2,
    ...(rentPrice === undefined ? {} : { rentPrice }) };
}
export function parseSearch(html: string, page = 1, settings = registry.defaults(SOURCE_ID)) {
  const visible = text(html);
  if (/verify you are human|just a moment|access denied|bevestig.{0,20}mens/i.test(visible)) throw new SourceError('ACCESS_BLOCKED', true);
  if (!/<h1\b[^>]*>\s*Zoekresultaten\s*<\/h1>/i.test(html) || !/<main\b[^>]*id="main"/i.test(html)) throw new SourceError('SEARCH_STRUCTURE_CHANGED');
  const inputs = [...html.matchAll(/<input\b[^>]*>/gi)].map(m => attrs(m[0]));
  if (!inputs.some(a => a.name === 'post_type' && a.value === 'rental') || !inputs.some(a => a.name === 'action' && a.value === 'epl_search')) throw new SourceError('SEARCH_FILTER_CHANGED');
  const count = html.match(/<div\b[^>]*id="search-count"[^>]*>([\s\S]*?)<\/div>/i)?.[1];
  const found = text(count ?? '').match(/^(\d+) (?:resultaten|resultaat)$/);
  if (!found) throw new SourceError('SEARCH_COUNT_MISSING');
  const total = Number(found[1]);
  if (total > 2000) throw new SourceError('LISTING_LIMIT');
  const location = html.match(/<select\b[^>]*name="property_location"[^>]*>([\s\S]*?)<\/select>/i)?.[1] ?? '';
  const selected = [...location.matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/gi)].find(m => /\bselected\b/.test(m[1]!));
  if (!selected || attrs(selected[1]!).value !== '20' || !text(selected[2]!).startsWith('Groningen')) throw new SourceError('SEARCH_FILTER_CHANGED');
  for (const [field, expected] of [['property_price_from', settings.minRent ? String(settings.minRent) : ''], ['property_price_to', String(settings.maxRent)]] as const) {
    const select = [...html.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/gi)].find(m => attrs(m[1]!).name === field);
    if (!select) throw new SourceError('SEARCH_FILTER_CHANGED');
    const options = [...select[2]!.matchAll(/<option\b([^>]*)>/gi)].map(m => m[1]!);
    // The backend accepts numeric prices absent from the dropdown; verify echo when representable.
    if (options.some(o => attrs(o).value === expected) && attrs(options.find(o => /\bselected\b/.test(o)) ?? options[0] ?? '').value !== expected) throw new SourceError('SEARCH_FILTER_CHANGED');
  }
  const listings = cardSections(html).map(parseCard);
  const pages = Math.max(1, Math.ceil(total / 10));
  if (page > pages || listings.length !== Math.min(10, Math.max(0, total - (page - 1) * 10))) throw new SourceError('INCOMPLETE_SEARCH');
  const nav = html.match(/<nav\b[^>]*id="nav-pagination"[^>]*>([\s\S]*?)<\/nav>/i)?.[1] ?? '';
  for (const m of nav.matchAll(/<a\b[^>]*href="([^"]+)"/gi)) {
    const u = url(m[1]!);
    const n = u.pathname === '/' ? 1 : Number(u.pathname.match(/^\/page\/(\d+)\/$/)?.[1]);
    if (!n || n > pages || u.href !== pageUrl(n, settings)) throw new SourceError('PAGINATION_CHANGED');
  }
  if (pages > 1) {
    const current = nav.match(/<li\b[^>]*class="active page-item[^\"]*"[^>]*>\s*<a\b[^>]*href="([^"]+)"/i)?.[1];
    if (!current || url(current).href !== pageUrl(page, settings) || !nav.includes(`/page/${pages}/`)) throw new SourceError('PAGINATION_CHANGED');
  }
  return { listings, total, pages };
}

export async function collect({ settings = registry.defaults(SOURCE_ID), transport = fetch, signal = AbortSignal.timeout(120000),
  pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)) }:
  { settings?: Record<string, number | null>; transport?: typeof fetch; signal?: AbortSignal; pause?: (ms: number) => Promise<void> } = {}) {
  const listings: ListingInput[] = []; let total: number | undefined; let pages = 1;
  for (let page = 1; page <= pages; page++) {
    if (page > 1) await pause(250);
    const html = await fetchHtml(pageUrl(page, settings), transport, signal, pause);
    const parsed = parseSearch(html, page, settings);
    if (total !== undefined && parsed.total !== total) throw new SourceError('SEARCH_CHANGED_DURING_RUN');
    total = parsed.total; pages = parsed.pages; listings.push(...parsed.listings);
  }
  if (new Set(listings.map(x => x.externalId)).size !== listings.length || new Set(listings.map(x => x.canonicalUrl)).size !== listings.length) throw new SourceError('DUPLICATE_CARD');
  return { listings, inspected: listings.length, total, pages, available: listings.filter(x => x.availabilityStatus === 'available').length };
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
