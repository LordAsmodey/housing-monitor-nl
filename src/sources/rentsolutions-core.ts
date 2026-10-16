import { z } from 'zod';
import type { ListingInput } from '../listings/listings.service';
export const SourceError: new (category: string, blocked?: boolean, retryAfterSeconds?: number) =>
  Error & { category: string; blocked: boolean; retryAfterSeconds: number } =
  require('../../scripts/funda-core.cjs').FundaError;
export const SOURCE_ID = 'rentsolutions:groningen';
export const SEARCH_URL = 'https://rent-solutions.nl/woning-aanbod/?_plaats=groningen&_price=0%2C1500';
export const FILTERS = { city: 'Groningen', minRent: 0, maxRent: 1500 };
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
  if (u.protocol !== 'https:' || u.hostname !== 'rent-solutions.nl' || u.port || u.username || u.password || u.search || u.hash ||
      !/^\/object\/[a-z0-9-]+-h\d{1,15}\/$/.test(u.pathname)) throw new SourceError('URL_NOT_ALLOWED');
  return u.href;
}
export function cards(html: string) {
  const starts = [...html.matchAll(/<a\b[^>]*>/gi)];
  const result = [...html.matchAll(/<a\b[^>]*>[\s\S]*?<\/a>/gi)].map(m => m[0]);
  if (starts.length !== result.length || result.some(c => [...c.matchAll(/<a\b/gi)].length !== 1)) throw new SourceError('HTML_TRUNCATED');
  return result;
}
export function parseCard(html: string): ListingInput {
  const canonicalUrl = allowedDetailUrl(attrs(html.match(/^<a\b[^>]*>/i)?.[0] ?? '').href ?? '');
  const externalId = new URL(canonicalUrl).pathname.match(/-(h\d+)\/$/)![1]!;
  const paragraphs = [...html.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)].map(m => text(m[1]!));
  const [title, location] = paragraphs;
  const city = location?.match(/^\d{4}\s?[A-Z]{2}\s+(.+)$/)?.[1];
  const priceText = text([...html.matchAll(/<h5\b[^>]*>([\s\S]*?)<\/h5>/gi)][0]?.[1] ?? '');
  const price = priceText.match(/^€\s*(\d{1,3}(?:\.\d{3})*(?:,\d{2})?|\d+(?:,\d{2})?)$/);
  const rentPrice = Number(price?.[1]?.replace(/\./g, '').replace(',', '.'));
  const specs = sections(html, 'aw-align-center');
  const spec = (icon: string) => text(specs.find(s => text(s).startsWith(icon + ' ')) ?? '').slice(icon.length).trim();
  const area = spec('square_foot').match(/^(\d+(?:[.,]\d+)?)\s*(?:㎡|m²)$/);
  const areaM2 = Number(area?.[1]?.replace(',', '.'));
  const roomText = spec('meeting_room'); const rooms = Number(roomText);
  if (!title || title.length > 500 || city !== 'Groningen' || !price || !Number.isFinite(rentPrice) || rentPrice <= 0 || rentPrice > 99999999 ||
      !area || !areaM2 || areaM2 > 999999 || !/^\d+$/.test(roomText) || !Number.isInteger(rooms) || rooms < 1 || rooms > 999) throw new SourceError('CARD_METADATA_MISSING');
  const badges = [...html.matchAll(/<span\b[^>]*>([\s\S]*?)<\/span>/gi)].filter(m => /(?:^|\s)bg-badge_col_/.test(attrs(m[0]).class ?? ''));
  const badge = badges.length === 1 ? text(badges[0]![1]!).toLowerCase() : '';
  const availabilityStatus = badge === 'nieuw' ? 'available' : /^(verhuurd(?: onder voorbehoud)?|onder optie|gereserveerd)$/.test(badge) ? 'unavailable' : 'unknown';
  return { externalId, canonicalUrl, title, address: title, city, areaM2, rooms, rentPrice, availabilityStatus };
}
function state(html: string, name: string) {
  const matches = [...html.matchAll(new RegExp('window\\.' + name + ' = (.+);', 'g'))];
  if (matches.length !== 1) throw new SourceError('SEARCH_STRUCTURE_CHANGED');
  try { return JSON.parse(matches[0]![1]!); } catch { throw new SourceError('INVALID_JSON'); }
}
const pagerSchema = z.object({ page: z.literal(1), per_page: z.literal(-1),
  total_rows: z.number().int().min(0).max(10000), total_pages: z.literal(1) });
export function parseSearch(html: string, settings = registry.defaults(SOURCE_ID)) {
  registry.validate(SOURCE_ID, settings);
  if (/verify you are human|just a moment|access denied/i.test(text(html))) throw new SourceError('ACCESS_BLOCKED', true);
  if (!/<h1\b[^>]*>[\s\S]*?Woning aanbod[\s\S]*?<\/h1>/i.test(html)) throw new SourceError('SEARCH_STRUCTURE_CHANGED');
  const json = state(html, 'FWP_JSON'); const http = state(html, 'FWP_HTTP');
  const parsed = pagerSchema.safeParse(json?.preload_data?.settings?.pager);
  if (!parsed.success) throw new SourceError('PAGINATION_CHANGED');
  const expected = Object.fromEntries(new URL(registry.queryUrl(SOURCE_ID, SEARCH_URL, settings)).searchParams);
  if (http?.uri !== 'woning-aanbod' || Object.keys(http.get ?? {}).length !== 2 ||
      Object.entries(expected).some(([key, value]) => http.get[key] !== value) ||
      Object.keys(http.url_vars ?? {}).length !== 2 || JSON.stringify(http.url_vars.plaats) !== JSON.stringify(['groningen']) ||
      JSON.stringify(http.url_vars.price) !== JSON.stringify([String(settings.minRent), String(settings.maxRent)]) ||
      JSON.stringify(json?.preload_data?.settings?.price?.start) !== JSON.stringify([settings.minRent, settings.maxRent])) throw new SourceError('SEARCH_FILTER_CHANGED');
  const templates = sections(html, 'facetwp-template');
  if (templates.length !== 1 || !hasClass(templates[0]!.match(/^<div\b[^>]*>/)![0], 'aw-card-wrapper')) throw new SourceError('SEARCH_STRUCTURE_CHANGED');
  const items = cards(templates[0]!); const total = parsed.data.total_rows;
  if (items.length !== total) throw new SourceError('INCOMPLETE_SEARCH');
  // This site renders an empty template with explicit zero pager metadata (no visible message).
  if (!total && (text(templates[0]!) || json.no_results_text !== 'Geen resultaten gevonden')) throw new SourceError('EMPTY_SEARCH_UNCONFIRMED');
  const listings = items.map(parseCard);
  if (new Set(listings.map(x => x.externalId)).size !== total || new Set(listings.map(x => x.canonicalUrl)).size !== total) throw new SourceError('DUPLICATE_CARD');
  if (listings.some(x => x.rentPrice! < settings.minRent! || x.rentPrice! > settings.maxRent!)) throw new SourceError('SEARCH_FILTER_CHANGED');
  return { listings, total, inspected: total, pages: 1, available: listings.filter(x => x.availabilityStatus === 'available').length };
}
export async function collect({ settings = registry.defaults(SOURCE_ID), transport = fetch, signal = AbortSignal.timeout(120000),
  pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)) }:
  { settings?: Record<string, number | null>; transport?: typeof fetch; signal?: AbortSignal; pause?: (ms: number) => Promise<void> } = {}) {
  registry.validate(SOURCE_ID, settings);
  return parseSearch(await fetchHtml(registry.queryUrl(SOURCE_ID, SEARCH_URL, settings), transport, signal, pause), settings);
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
