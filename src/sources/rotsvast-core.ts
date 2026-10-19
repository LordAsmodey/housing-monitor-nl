import type { ListingInput } from '../listings/listings.service';
export const SourceError: new (category: string, blocked?: boolean, retryAfterSeconds?: number) =>
  Error & { category: string; blocked: boolean; retryAfterSeconds: number } =
  require('../../scripts/funda-core.cjs').FundaError;
export const SOURCE_ID = 'rotsvast:groningen-homes';
export const SEARCH_URL = 'https://www.rotsvast.nl/huren/?search=Groningen&price_to=1500';
export const FILTERS = { city: 'Groningen', minRent: 0, maxRent: 1500, independentHousing: true };
const registry = require('../../scripts/search-settings.cjs');
type Settings = Record<string, number | null>;
const attrs = (tag: string): Record<string, string> => Object.fromEntries(
  [...tag.matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map(m => [m[1]!.toLowerCase(), m[2] ?? m[3]!])
);
const classes = (tag: string) => (attrs(tag).class ?? '').split(/\s+/).filter(Boolean);
export function text(html: string) {
  return html.replace(/<script\b[^>]*>[\s\S]*?<\/script>|<style\b[^>]*>[\s\S]*?<\/style>|<!--[\s\S]*?-->/gi, '')
    .replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&sup2;/g, '²').replace(/&euro;/g, '€')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => Number(n) <= 0x10ffff ? String.fromCodePoint(Number(n)) : '')
    .replace(/\s+/g, ' ').trim();
}
// Balanced elements prevent nested markup or a truncated final card from being silently lost.
export function sections(html: string, className: string, tag = 'div') {
  const result: string[] = []; let start: number | undefined; let depth = 0;
  for (const m of html.matchAll(new RegExp(`<\\/?${tag}\\b[^>]*>`, 'gi'))) {
    if (/^<\//.test(m[0])) {
      if (start !== undefined && --depth === 0) { result.push(html.slice(start, m.index! + m[0].length)); start = undefined; }
    } else if (start !== undefined) depth++;
    else if (classes(m[0]).includes(className)) { start = m.index; depth = 1; }
  }
  if (start !== undefined) throw new SourceError('HTML_TRUNCATED');
  return result;
}
function one(html: string, cls: string, tag = 'div') {
  const parts = sections(html, cls, tag);
  if (parts.length !== 1) throw new SourceError('STRUCTURE_CHANGED');
  return parts[0]!;
}
function safeUrl(value: string) {
  let u: URL;
  try { u = new URL(text(value), SEARCH_URL); } catch { throw new SourceError('INVALID_URL'); }
  if (u.protocol !== 'https:' || u.hostname !== 'www.rotsvast.nl' || u.port || u.username || u.password || u.hash) throw new SourceError('URL_NOT_ALLOWED');
  return u;
}
export function allowedDetailUrl(value: string) {
  const u = safeUrl(value);
  if (u.search || !/^\/huren\/[a-z0-9-]+-h\d{6,14}\/$/.test(u.pathname)) throw new SourceError('URL_NOT_ALLOWED');
  return u.href;
}
export function pageUrl(page: number, settings: Settings = registry.defaults(SOURCE_ID)) {
  if (!Number.isInteger(page) || page < 1 || page > 100) throw new SourceError('PAGE_LIMIT');
  const u = new URL(registry.queryUrl(SOURCE_ID, SEARCH_URL, settings));
  if (page > 1) u.pathname = `/huren/page/${page}/`;
  return u.href;
}
function pageNumber(value: string, settings: Settings) {
  const u = safeUrl(value);
  const page = u.pathname === '/huren/' ? 1 : Number(u.pathname.match(/^\/huren\/page\/(\d+)\/$/)?.[1]);
  const expected = new URL(pageUrl(page, settings));
  if ([...u.searchParams].length !== [...expected.searchParams].length || [...expected.searchParams].some(([k,v]) => u.searchParams.get(k) !== v)) throw new SourceError('SEARCH_FILTER_CHANGED');
  return page;
}
function canonical(html: string, expected: string) {
  const links = [...html.matchAll(/<link\b[^>]*>/gi)].map(m => attrs(m[0])).filter(a => a.rel === 'canonical');
  if (links.length !== 1 || links[0]!.href !== expected) throw new SourceError('CANONICAL_CHANGED');
}
function blocked(html: string) {
  if (/verify you are human|just a moment|access denied/i.test(text(html))) throw new SourceError('ACCESS_BLOCKED', true);
}
function price(value: string) {
  const m = value.match(/^€\s*(\d{1,3}(?:\.\d{3})*|\d+)(?:,(\d{2}))? p\.m\.$/);
  const n = Number(m?.[1]?.replace(/\./g, '')) + Number(m?.[2] ?? 0) / 100;
  if (!m || !n || n > 99999999) throw new SourceError('PRICE_INVALID');
  return n;
}
function area(value: string) {
  const m = value.match(/^(\d+(?:[.,]\d+)?)\s*m²$/); const n = Number(m?.[1]?.replace(',', '.'));
  if (!m || !n || n > 999999) throw new SourceError('AREA_INVALID');
  return n;
}
function badges(html: string) {
  return [...html.matchAll(/<span\b[^>]*>[\s\S]*?<\/span>/gi)].filter(m => classes(m[0].split('>')[0] + '>').includes('label')).map(m => text(m[0]));
}
const unavailable = (labels: string[]) => labels.some(x => /^(Verhuurd(?: onder voorbehoud)?|Onder optie|In optie|Gereserveerd)$/i.test(x));
function validAvailability(value: string) {
  if (value === 'Direct beschikbaar') return true;
  const m = value.match(/^Beschikbaar vanaf (\d{2})-(\d{2})-(\d{4})$/);
  if (!m) return false;
  const iso = `${m[3]}-${m[2]}-${m[1]}`; const d = new Date(iso + 'T00:00:00Z');
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0,10) === iso;
}
export function parseCard(html: string): ListingInput {
  const root = html.match(/^<a\b[^>]*>/i)?.[0] ?? '';
  const canonicalUrl = allowedDetailUrl(attrs(root).href ?? '');
  const externalId = new URL(canonicalUrl).pathname.match(/-(h\d+)\/$/)![1]!;
  const content = one(html, 'card-house__content');
  const values = sections(content, 'card-house__text').map(text);
  const address = text(one(content, 'card-house__title'));
  const spec = one(content, 'card-house__list', 'ul');
  const surface = [...spec.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)].filter(m => /class="icon-surface"/.test(m[1]!));
  const clock = [...spec.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)].filter(m => /class="icon-clock"/.test(m[1]!));
  if (values.length !== 2 || !values[0] || !address || address.length > 400 || surface.length !== 1 || clock.length > 1) throw new SourceError('CARD_METADATA_MISSING');
  const labels = badges(one(html, 'card-house__label'));
  const knownLabels = labels.every(x => ['Topper', 'Topwoning', 'Nieuw', 'Beschikbaar'].includes(x));
  const knownClasses = classes(root).every(x => ['card', 'card--house'].includes(x));
  const availabilityStatus = unavailable(labels) ? 'unavailable' : knownClasses && knownLabels && clock.length === 1 && validAvailability(text(clock[0]![1]!)) ? 'available' : 'unknown';
  return { externalId, canonicalUrl, address, title: `${address}, ${values[0]}`, city: values[0], rentPrice: price(values[1]!), areaM2: area(text(surface[0]![1]!)), availabilityStatus };
}
export function parseSearch(html: string, page = 1, settings: Settings = registry.defaults(SOURCE_ID)) {
  blocked(html); pageUrl(page, settings);
  canonical(html, page === 1 ? 'https://www.rotsvast.nl/huren/' : `https://www.rotsvast.nl/huren/page/${page}/`);
  if (!/Aanbod huurwoningen/.test(text(html))) throw new SourceError('SEARCH_STRUCTURE_CHANGED');
  const views = [...html.matchAll(/<a\b[^>]*>/gi)].filter(m => classes(m[0]).includes('view-type-button') && classes(m[0]).includes('active'));
  // Filter inputs are populated by client JS, so verify the server-rendered active grid URL.
  if (views.length !== 1 || pageNumber(attrs(views[0]![0]).href ?? '', settings) !== 1) throw new SourceError('SEARCH_FILTER_CHANGED');
  const container = one(html, 'house-list__overview__items');
  const raw = sections(container, 'card--house', 'a');
  const anchors = [...container.matchAll(/<a\b/gi)].length;
  if (raw.length !== anchors) throw new SourceError('CARD_STRUCTURE_CHANGED');
  if (!raw.length) throw new SourceError('EMPTY_SEARCH_UNCONFIRMED');
  const listings = raw.map(parseCard);
  if (listings.some(x => x.city !== 'Groningen' || !new URL(x.canonicalUrl).pathname.includes('-groningen-h'))) throw new SourceError('CITY_CHANGED');
  const pager = one(html, 'pagination');
  const desktop = one(pager, 'desktop', 'ul'); const mobile = one(pager, 'mobile', 'ul');
  let pages = page;
  for (const panel of [desktop, mobile]) {
    const current = [...panel.matchAll(/<span\b[^>]*>[\s\S]*?<\/span>/gi)].filter(m => classes(m[0].split('>')[0] + '>').includes('current'));
    if (current.length !== 1 || text(current[0]![0]) !== String(page)) throw new SourceError('PAGINATION_CHANGED');
    const links = [...panel.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)];
    let next = 0, previous = 0;
    for (const m of links) {
      const target = pageNumber(attrs(m[1]!).href ?? '', settings); const cls = classes(m[1]!);
      pages = Math.max(pages, target);
      if (cls.includes('next')) { next++; if (target !== page + 1) throw new SourceError('PAGINATION_CHANGED'); }
      else if (cls.includes('prev')) { previous++; if (target !== page - 1) throw new SourceError('PAGINATION_CHANGED'); }
      else if (panel === desktop && text(m[2]!) !== String(target)) throw new SourceError('PAGINATION_CHANGED');
    }
    if (previous !== (page > 1 ? 1 : 0) || next !== (pages > page ? 1 : 0)) throw new SourceError('PAGINATION_CHANGED');
  }
  const numbers = [...desktop.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)].filter(m => !classes(m[1]!).some(x => ['next', 'prev'].includes(x))).map(m => Number(text(m[2]!)));
  const expectedNumbers = Array.from({ length: pages }, (_, i) => i + 1).filter(n => n !== page);
  if (JSON.stringify(numbers) !== JSON.stringify(expectedNumbers)) throw new SourceError('PAGINATION_CHANGED');
  if (listings.length > 10 || page < pages && listings.length !== 10) throw new SourceError('INCOMPLETE_SEARCH');
  return { listings, pages };
}
export function parseDetail(html: string, card: ListingInput) {
  blocked(html); canonical(html, card.canonicalUrl);
  const top = one(html, 'house-detail__top');
  const title = [...top.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi)];
  if (title.length !== 1 || text(title[0]![1]!) !== card.address || text(one(top, 'house-detail__subtitle')) !== card.city || price(text(one(top, 'house-detail__price'))) !== card.rentPrice) throw new SourceError('DETAIL_MISMATCH');
  const spec = one(html, 'house-features__date', 'ul'); const fields: Record<string, string> = {};
  for (const m of spec.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)) {
    const key = text(m[1]!.match(/<span\b[^>]*>([\s\S]*?)<\/span>/i)?.[1]?.replace(/<small\b[^>]*>[\s\S]*?<\/small>/gi, '') ?? '');
    const value = text(m[1]!.match(/<strong\b[^>]*>([\s\S]*?)<\/strong>/i)?.[1] ?? '');
    if (!key || !value || fields[key] !== undefined) throw new SourceError('DETAIL_METADATA_MISSING');
    fields[key] = value;
  }
  if (!fields.Type || !fields.Oppervlakte || area(fields.Oppervlakte) !== card.areaM2) throw new SourceError('DETAIL_MISMATCH');
  const propertyType = fields.Type;
  const types = propertyType.split(',').map(x => x.trim());
  const homes = ['Appartement', 'Portiekwoning', 'Galerijflat', 'Dubbel bovenhuis', 'Bovenwoning', 'Benedenwoning', 'Maisonnette', 'Maisonette', 'Studio', 'Woonhuis', 'Eengezinswoning', 'Tussenwoning', 'Hoekwoning', 'Vrijstaande woning', 'Twee onder één kapwoning'];
  // Every component must be known; a room/parking/unknown subtype never becomes independent housing.
  const independent = types.every(x => homes.includes(x));
  const labels = badges(one(html, 'house-gallery__label'));
  const availabilityStatus: ListingInput['availabilityStatus'] = unavailable(labels) || card.availabilityStatus === 'unavailable' ? 'unavailable' : labels.every(x => ['Topper', 'Topwoning', 'Nieuw', 'Beschikbaar'].includes(x)) ? card.availabilityStatus : 'unknown';
  const rooms = fields['Aantal kamers'];
  if (rooms && !/^[1-9]\d{0,2}$/.test(rooms)) throw new SourceError('DETAIL_METADATA_MISSING');
  return { ...card, ...(rooms ? { rooms: Number(rooms) } : {}), availabilityStatus, independent, propertyType };
}

export async function collect({ settings = registry.defaults(SOURCE_ID), transport = fetch, signal = AbortSignal.timeout(120000),
  pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)) }:
  { settings?: Settings; transport?: typeof fetch; signal?: AbortSignal; pause?: (ms: number) => Promise<void> } = {}) {
  registry.validate(SOURCE_ID, settings);
  const cards: ListingInput[] = []; let pages = 1;
  for (let page = 1; page <= pages; page++) {
    if (page > 1) await pause(300);
    const parsed = parseSearch(await fetchHtml(pageUrl(page, settings), transport, signal, pause), page, settings);
    if (page > 1 && pages !== parsed.pages) throw new SourceError('SEARCH_CHANGED_DURING_RUN');
    pages = parsed.pages; cards.push(...parsed.listings);
  }
  if (new Set(cards.map(x => x.externalId)).size !== cards.length || new Set(cards.map(x => x.canonicalUrl)).size !== cards.length) throw new SourceError('DUPLICATE_CARD');
  const listings: ListingInput[] = [];
  for (const card of cards) {
    // Parse every detail, including archived cards, before a successful baseline is persisted.
    await pause(300);
    const { independent, propertyType: _, ...item } = parseDetail(await fetchHtml(card.canonicalUrl, transport, signal, pause), card);
    if (independent && registry.matches(settings, item, SOURCE_ID)) listings.push(item);
  }
  return { listings, inspected: cards.length, total: cards.length, pages, available: listings.filter(x => x.availabilityStatus === 'available').length };
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
