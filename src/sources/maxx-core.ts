import type { ListingInput } from '../listings/listings.service';
export const SourceError: new (category: string, blocked?: boolean, retryAfterSeconds?: number) =>
  Error & { category: string; blocked: boolean; retryAfterSeconds: number } =
  require('../../scripts/funda-core.cjs').FundaError;
export const SOURCE_ID = 'maxx:groningen-homes';
export const SEARCH_URL = 'https://maxxhuren.nl/woonruimte-huren/?city=Groningen&type=&max=1500';
export const FILTERS = { city: 'Groningen', maxRent: 1500, types: ['Appartement', 'Studio', 'Bovenwoning', 'Eengezinswoning'] };
const registry = require('../../scripts/search-settings.cjs');
const attrs = (tag: string): Record<string, string> => Object.fromEntries(
  [...tag.slice(0, tag.indexOf('>') + 1).matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map(m => [m[1]!.toLowerCase(), m[2] ?? m[3]!])
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
  if (u.protocol !== 'https:' || u.hostname !== 'maxxhuren.nl' || u.port || u.username || u.password || u.search || u.hash ||
      !/^\/objects\/ads\/view\/id-[1-9]\d{0,14}\/$/.test(u.pathname)) throw new SourceError('URL_NOT_ALLOWED');
  return u.href;
}
export function searchUrl(settings = registry.defaults(SOURCE_ID)) {
  return registry.queryUrl(SOURCE_ID, SEARCH_URL, settings);
}
function value(html: string, className: string, tag = 'div') {
  const elements = [...html.matchAll(new RegExp('<' + tag + '\\b[^>]*>([^<]*)<\\/' + tag + '>', 'gi'))]
    .filter(m => hasClass(m[0], className));
  if (elements.length !== 1) throw new SourceError('CARD_STRUCTURE_CHANGED');
  return text(elements[0]![1]!);
}
export function parseCard(html: string): { listing: ListingInput; type: string } {
  const links = [...html.matchAll(/<a\b[^>]*>/gi)];
  if (links.length !== 1) throw new SourceError('CARD_STRUCTURE_CHANGED');
  const link = attrs(links[0]![0]);
  const canonicalUrl = allowedDetailUrl(link.href ?? '');
  const externalId = new URL(canonicalUrl).pathname.match(/id-(\d+)\//)![1]!;
  if (link.id !== 'object-' + externalId) throw new SourceError('CARD_ID_MISMATCH');
  const title = value(html, 'text-block-34');
  const city = value(html, 'plaatsnaam-object');
  const type = value(html, 'type-woonruimte-object');
  const price = value(html, 'huurprijs-object').match(/^€(\d{1,3}(?:\.\d{3})*(?:,\d{2})?|\d+(?:,\d{2})?) per maand$/);
  const area = value(html, 'oppervlak-object').match(/^(\d+(?:[.,]\d+)?)?m²$/);
  const roomsMatch = value(html, 'text-block-35').match(/^(?:(\d+) )?kamers$/);
  const rentPrice = Number(price?.[1]?.replace(/\./g, '').replace(',', '.'));
  const areaM2 = area?.[1] ? Number(area[1].replace(',', '.')) : undefined;
  const rooms = roomsMatch?.[1] ? Number(roomsMatch[1]) : undefined;
  if (!title || title.length > 500 || city !== 'Groningen' || !type || !price || !Number.isFinite(rentPrice) || rentPrice < 0 || rentPrice > 99999999 ||
      !area || (areaM2 !== undefined && (areaM2 <= 0 || areaM2 > 999999)) || !roomsMatch ||
      (rooms !== undefined && (rooms < 1 || rooms > 999))) throw new SourceError('CARD_METADATA_MISSING');
  // An explicitly empty area/room value exists on the live site. Keep it unknown.
  const badges = [...html.matchAll(/<div\b[^>]*>([^<]*)<\/div>/gi)]
    .filter(m => ['object-beschikbaar', 'object-onder-optie', 'object-reeds-verhuurd'].some(c => hasClass(m[0], c)));
  if (badges.length > 1) throw new SourceError('CARD_STRUCTURE_CHANGED');
  const badge = badges[0]; const label = text(badge?.[1] ?? '').toLowerCase();
  const availabilityStatus = badge && hasClass(badge[0], 'object-beschikbaar') && /^(nieuw - )?beschikbaar$/.test(label) ? 'available'
    : badge && ((hasClass(badge[0], 'object-onder-optie') && label === 'bijna verhuurd') ||
      (hasClass(badge[0], 'object-reeds-verhuurd') && label === 'reeds verhuurd')) ? 'unavailable' : 'unknown';
  return { type, listing: { externalId, canonicalUrl, title, address: title, city, rentPrice,
    ...(areaM2 === undefined ? {} : { areaM2 }), ...(rooms === undefined ? {} : { rooms }), availabilityStatus } };
}
function selected(html: string, name: string) {
  const selects = [...html.matchAll(/<select\b[^>]*>([\s\S]*?)<\/select>/gi)].filter(m => attrs(m[0]).name === name);
  if (selects.length !== 1) throw new SourceError('SEARCH_STRUCTURE_CHANGED');
  const options = [...selects[0]![1]!.matchAll(/<option\b[^>]*>/gi)];
  const chosen = options.filter(m => /\sselected(?:\s|=|>)/i.test(m[0]));
  if (chosen.length > 1 || !options.length) throw new SourceError('SEARCH_FILTER_CHANGED');
  return attrs((chosen[0] ?? options[0])![0]).value;
}
export function parseSearch(html: string, settings = registry.defaults(SOURCE_ID)) {
  registry.validate(SOURCE_ID, settings);
  if (/verify you are human|just a moment|access denied/i.test(text(html))) throw new SourceError('ACCESS_BLOCKED', true);
  if (!/<h1\b[^>]*>Aanbod<\/h1>/i.test(html) || !/<\/html>\s*$/i.test(html)) throw new SourceError('SEARCH_STRUCTURE_CHANGED');
  const forms = [...html.matchAll(/<form\b[^>]*>([\s\S]*?)<\/form>/gi)].filter(m => attrs(m[0]).id === 'search-form');
  if (forms.length !== 1 || attrs(forms[0]![0]).action !== '/woonruimte-huren/' ||
      selected(forms[0]![1]!, 'city') !== 'Groningen' || selected(forms[0]![1]!, 'type') !== '' ||
      selected(forms[0]![1]!, 'max') !== String(settings.maxRent)) throw new SourceError('SEARCH_FILTER_CHANGED');
  const counts = [...html.matchAll(/<span\b[^>]*>([^<]*)<\/span>/gi)].filter(m => hasClass(m[0], 'aantal-woonruimtes'));
  if (counts.length !== 1 || !/^\d+$/.test(counts[0]![1]!)) throw new SourceError('SEARCH_COUNT_MISSING');
  const total = Number(counts[0]![1]);
  if (total > 5000) throw new SourceError('SEARCH_LIMIT');
  const grids = sections(html, 'object-grid');
  if (grids.length !== 1 || attrs(grids[0]!.match(/^<div\b[^>]*>/)![0]).id !== 'filter-results-container') throw new SourceError('SEARCH_STRUCTURE_CHANGED');
  const grid = grids[0]!;
  const cards = [...grid.matchAll(/<a\b[^>]*>[\s\S]*?<\/a>/gi)].map(m => m[0]);
  const starts = [...grid.matchAll(/<a\b[^>]*>/gi)];
  if (cards.length !== total || starts.length !== total || starts.some(m => !hasClass(m[0], 'object'))) throw new SourceError('INCOMPLETE_SEARCH');
  const empty = /Er zijn geen woningen gevonden met deze filters\./.test(text(grid));
  if ((total === 0) !== empty) throw new SourceError('INCOMPLETE_SEARCH');
  const parsed = cards.map(parseCard);
  const all = parsed.map(x => x.listing);
  if (new Set(all.map(x => x.externalId)).size !== total || new Set(all.map(x => x.canonicalUrl)).size !== total) throw new SourceError('DUPLICATE_CARD');
  if (all.some(x => x.rentPrice! > settings.maxRent!)) throw new SourceError('SEARCH_FILTER_CHANGED');
  const listings = parsed.filter(x => FILTERS.types.includes(x.type)).map(x => x.listing);
  return { listings, total, inspected: total, available: listings.filter(x => x.availabilityStatus === 'available').length };
}
export async function collect({ settings = registry.defaults(SOURCE_ID), transport = fetch, signal = AbortSignal.timeout(120000),
  pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)) }:
  { settings?: Record<string, number | null>; transport?: typeof fetch; signal?: AbortSignal; pause?: (ms: number) => Promise<void> } = {}) {
  return parseSearch(await fetchHtml(searchUrl(settings), transport, signal, pause), settings);
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
