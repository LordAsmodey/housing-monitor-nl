import { z } from 'zod';
import type { ListingInput } from '../listings/listings.service';
export const SourceError: new (category: string, blocked?: boolean, retryAfterSeconds?: number) =>
  Error & { category: string; blocked: boolean; retryAfterSeconds: number } =
  require('../../scripts/funda-core.cjs').FundaError;
export const SOURCE_ID = 'vandermeulen:groningen-nieuw';
export const SEARCH_URL = 'https://www.vandermeulenmakelaars.nl/huurwoningen/?_plaats=groningen&_status=nieuw&_prijsbereik=10.00%2C1500.00';
export const FILTERS = { city: 'Groningen', status: 'nieuw', minRent: 10, maxRent: 1500 };
const registry = require('../../scripts/search-settings.cjs');
const attrs = (tag: string): Record<string, string> => Object.fromEntries(
  [...tag.matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map(m => [m[1]!.toLowerCase(), m[2] ?? m[3]!])
);
const hasClass = (tag: string, name: string) => (attrs(tag).class ?? '').split(/\s+/).includes(name);
function text(html: string) {
  return html.replace(/<script\b[^>]*>[\s\S]*?<\/script>|<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]*>/g, ' ').replace(/&nbsp;?/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => Number(n) <= 0x10ffff ? String.fromCodePoint(Number(n)) : '')
    .replace(/\s+/g, ' ').trim();
}
// Balanced divs preserve each complete card despite its nested layout.
export function sections(html: string, className: string) {
  const result: string[] = []; let start: number | undefined; let depth = 0;
  for (const m of html.matchAll(/<\/?div\b[^>]*>/gi)) {
    if (/^<\//.test(m[0])) {
      if (start !== undefined && --depth === 0) { result.push(html.slice(start, m.index! + m[0].length)); start = undefined; }
    } else if (start !== undefined) depth++;
    else if (hasClass(m[0], className)) { start = m.index; depth = 1; }
  }
  if (start !== undefined) throw new SourceError('HTML_TRUNCATED');
  return result;
}
export function allowedDetailUrl(value: string) {
  let u: URL;
  try { u = new URL(value, SEARCH_URL); } catch { throw new SourceError('INVALID_URL'); }
  if (u.protocol !== 'https:' || u.hostname !== 'www.vandermeulenmakelaars.nl' || u.port || u.username || u.password || u.search || u.hash ||
      !/^\/huurwoningen\/[a-z0-9-]+-h\d{1,15}\/$/.test(u.pathname)) throw new SourceError('URL_NOT_ALLOWED');
  return u.href;
}
export function pageUrl(page: number, settings = registry.defaults(SOURCE_ID)) {
  if (!Number.isInteger(page) || page < 1 || page > 100) throw new SourceError('PAGE_LIMIT');
  const u = new URL(registry.queryUrl(SOURCE_ID, SEARCH_URL, settings));
  if (page > 1) u.searchParams.set('_paged', String(page));
  return u.href;
}
export function parseCard(html: string): ListingInput {
  const links = [...html.matchAll(/<a\b[^>]*>/gi)].map(m => attrs(m[0]).href);
  if (links.length !== 1 || !links[0]) throw new SourceError('CARD_STRUCTURE_CHANGED');
  const canonicalUrl = allowedDetailUrl(links[0]);
  const externalId = new URL(canonicalUrl).pathname.match(/-(h\d+)\/$/)![1]!;
  const title = text([...html.matchAll(/<span\b[^>]*>([\s\S]*?)<\/span>/gi)].find(m => hasClass(m[0], 'aw-mimic-h5'))?.[1] ?? '');
  const body = sections(html, 'aw-card-body')[0] ?? '';
  const city = text([...body.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)].find(m => /map-marker-alt-solid\.svg/.test(m[1]!))?.[1] ?? '');
  const specs = sections(html, 'aw-align-center');
  const spec = (icon: string) => text(specs.find(s => s.includes('/' + icon + '.svg')) ?? '');
  const area = spec('ruler-combined-solid').match(/^(\d+(?:[.,]\d+)?) m²$/);
  const rooms = Number(spec('door-open-solid'));
  const price = spec('euro-sign-solid').match(/^(\d{1,3}(?:\.\d{3})*(?:,\d{2})?|\d+(?:,\d{2})?) p\/m$/);
  const areaM2 = Number(area?.[1]?.replace(',', '.'));
  const rentPrice = Number(price?.[1]?.replace(/\./g, '').replace(',', '.'));
  if (!title || title.length > 500 || city !== 'Groningen' || !areaM2 || areaM2 > 999999 || !price || !Number.isFinite(rentPrice) || rentPrice < 0 || rentPrice > 99999999 || !Number.isInteger(rooms) || rooms < 1 || rooms > 999) throw new SourceError('CARD_METADATA_MISSING');
  const badge = text([...html.matchAll(/<span\b[^>]*>([\s\S]*?)<\/span>/gi)].find(m => hasClass(m[0], 'aw_badge'))?.[1] ?? '').toLowerCase();
  const availabilityStatus = badge === 'nieuw' ? 'available' : /^(verhuurd(?: onder voorbehoud)?|onder optie|gereserveerd)$/.test(badge) ? 'unavailable' : 'unknown';
  return { externalId, canonicalUrl, title, address: title, city, areaM2, rooms, rentPrice, availabilityStatus };
}
function state(html: string, name: string) {
  const matches = [...html.matchAll(new RegExp('window\\.' + name + ' = (.+);', 'g'))];
  if (matches.length !== 1) throw new SourceError('SEARCH_STRUCTURE_CHANGED');
  try { return JSON.parse(matches[0]![1]!); } catch { throw new SourceError('INVALID_JSON'); }
}
const pagerSchema = z.object({ page: z.number().int().min(1).max(100), per_page: z.literal(12),
  total_rows: z.number().int().min(0).max(1200), total_pages: z.number().int().min(0).max(100) });
export function parseSearch(html: string, page = 1, settings = registry.defaults(SOURCE_ID)) {
  if (/verify you are human|just a moment|access denied/i.test(text(html))) throw new SourceError('ACCESS_BLOCKED', true);
  if (!/<h1\b[^>]*>Huurwoningen Groningen<\/h1>/i.test(html)) throw new SourceError('SEARCH_STRUCTURE_CHANGED');
  const json = state(html, 'FWP_JSON'); const http = state(html, 'FWP_HTTP');
  const parsed = pagerSchema.safeParse(json?.preload_data?.settings?.pager);
  if (!parsed.success) throw new SourceError('SEARCH_COUNT_MISSING');
  const expected = Object.fromEntries(new URL(pageUrl(page, settings)).searchParams);
  if (http?.uri !== 'huurwoningen' || JSON.stringify(Object.keys(http.get ?? {}).sort()) !== JSON.stringify(Object.keys(expected).sort()) ||
      Object.entries(expected).some(([key, value]) => http.get[key] !== value)) throw new SourceError('SEARCH_FILTER_CHANGED');
  const { total_rows: total, total_pages: pages, per_page: perPage, page: current } = parsed.data;
  if (current !== page || pages !== Math.ceil(total / perPage) || page > Math.max(1, pages)) throw new SourceError('PAGINATION_CHANGED');
  const templates = sections(html, 'facetwp-template');
  if (templates.length !== 1 || !hasClass(templates[0]!.match(/^<div\b[^>]*>/)![0], 'aw-card-wrapper')) throw new SourceError('SEARCH_STRUCTURE_CHANGED');
  const cards = sections(templates[0]!, 'aw-card');
  if (cards.length !== Math.min(perPage, Math.max(0, total - (page - 1) * perPage))) throw new SourceError('INCOMPLETE_SEARCH');
  const listings = cards.map(parseCard);
  if (new Set(listings.map(x => x.externalId)).size !== listings.length) throw new SourceError('DUPLICATE_CARD');
  if (listings.some(x => x.rentPrice! < settings.minRent! || x.rentPrice! > settings.maxRent!)) throw new SourceError('SEARCH_FILTER_CHANGED');
  return { listings, total, pages: Math.max(1, pages) };
}

export async function collect({ settings = registry.defaults(SOURCE_ID), transport = fetch, signal = AbortSignal.timeout(120000),
  pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)) }:
  { settings?: Record<string, number | null>; transport?: typeof fetch; signal?: AbortSignal; pause?: (ms: number) => Promise<void> } = {}) {
  const listings: ListingInput[] = []; let total: number | undefined; let pages = 1;
  for (let page = 1; page <= pages; page++) {
    if (page > 1) await pause(250);
    const parsed = parseSearch(await fetchHtml(pageUrl(page, settings), transport, signal, pause), page, settings);
    if (total !== undefined && total !== parsed.total) throw new SourceError('SEARCH_CHANGED_DURING_RUN');
    total = parsed.total; pages = parsed.pages; listings.push(...parsed.listings);
  }
  if (listings.length !== total) throw new SourceError('INCOMPLETE_SEARCH');
  if (new Set(listings.map(x => x.externalId)).size !== listings.length || new Set(listings.map(x => x.canonicalUrl)).size !== listings.length) throw new SourceError('DUPLICATE_CARD');
  return { listings, total, inspected: listings.length, pages, available: listings.filter(x => x.availabilityStatus === 'available').length };
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
