import type { ListingInput } from '../listings/listings.service';
export const SourceError: new (category: string, blocked?: boolean, retryAfterSeconds?: number) =>
  Error & { category: string; blocked: boolean; retryAfterSeconds: number } =
  require('../../scripts/funda-core.cjs').FundaError;
export const SOURCE_ID = 'dcwonen:groningen-homes';
export const SEARCH_URL = 'https://dcwonen.nl/verhuur/page/1';
export const FILTERS = { city: 'Groningen', maxRent: 1500, excludedTypes: ['kamer'] };
const registry = require('../../scripts/search-settings.cjs');
function text(html: string) {
  return html.replace(/<script\b[^>]*>[\s\S]*?<\/script>|<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]*>/g, ' ').replace(/&nbsp;|&#160;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&euro;/g, '€').replace(/\s+/g, ' ').trim();
}
export function allowedDetailUrl(value: string) {
  let u: URL; try { u = new URL(value); } catch { throw new SourceError('URL_NOT_ALLOWED'); }
  if (u.origin !== 'https://dcwonen.nl' || u.username || u.password || u.search || u.hash ||
    !/^\/verhuur\/[a-z0-9-]+-\d+$/.test(u.pathname)) throw new SourceError('URL_NOT_ALLOWED');
  return u.href;
}
export function pageUrl(page: number) {
  if (!Number.isInteger(page) || page < 1 || page > 200) throw new SourceError('PAGE_LIMIT');
  return `https://dcwonen.nl/verhuur/page/${page}`;
}
export function cardSections(html: string) {
  return [...html.matchAll(/<a\b[^>]*class="object -[^"]+"[^>]*>[\s\S]*?<\/a>/gi)].map(m => m[0]);
}
export function parseCard(html: string): ListingInput & { housingType: string } {
  const field = (name: string) => text(html.match(new RegExp(`<span\\b[^>]*class="${name}"[^>]*>([\\s\\S]*?)<\\/span>`, 'i'))?.[1] ?? '');
  const canonicalUrl = allowedDetailUrl(html.match(/href="([^"]+)"/)?.[1] ?? '');
  const title = field('object-name'); const city = field('object-address');
  const housingType = html.match(/class="object -([a-z]+)"/)?.[1] ?? '';
  const visible = text(html);
  const price = field('object-price').match(/^€\s*(\d{1,3}(?:\.\d{3})*,\d{2})\s+(Inclusief|Exclusief)$/i);
  const area = visible.match(/Woonoppervlakte:\s*(\d+(?:[.,]\d+)?)m²/);
  const date = visible.match(/Beschikbaar per:\s*(\d{2}\/\d{2}\/\d{4})/);
  if (!title || title.length > 500 || !city || city.length > 200 || !['woning','appartement','studio','kamer'].includes(housingType) || !area || !date) throw new SourceError('CARD_STRUCTURE_CHANGED');
  const rentPrice = price ? Number(price[1]!.replace(/\./g, '').replace(',', '.')) : NaN;
  const areaM2 = Number(area[1]!.replace(',', '.'));
  if (!Number.isFinite(rentPrice) || rentPrice <= 0 || rentPrice > 99999999) throw new SourceError('INVALID_PRICE');
  if (areaM2 <= 0 || areaM2 > 999999) throw new SourceError('CARD_METADATA_MISSING');
  const unavailable = /\bverhuurd\b|\bonder optie\b|\bgereserveerd\b/i.test(visible);
  return { externalId: canonicalUrl.match(/-(\d+)$/)![1]!, canonicalUrl, title, city, rentPrice, areaM2, housingType, pricingDetails: { baseRent: false },
    availabilityStatus: unavailable ? 'unavailable' : 'available' };
}
export function parseSearch(html: string, page = 1) {
  if (/verify you are human|just a moment|access denied/i.test(text(html))) throw new SourceError('ACCESS_BLOCKED', true);
  if (!/<section class="object-list">/.test(html) || !/<title>Verhuur \| DC Wonen<\/title>/.test(html)) throw new SourceError('SEARCH_STRUCTURE_CHANGED');
  const counts = [...html.matchAll(/<span>(\d+) van (\d+) resultaten<\/span>/g)];
  if (!counts.length || counts.some(m => m[1] !== counts[0]![1] || m[2] !== counts[0]![2])) throw new SourceError('SEARCH_COUNT_MISSING');
  const total = Number(counts[0]![2]); const count = Number(counts[0]![1]);
  if (total > 1000) throw new SourceError('LISTING_LIMIT');
  const pages = Math.max(1, Math.ceil(total / 5));
  const listings = cardSections(html).map(parseCard);
  if (page > pages || count !== listings.length || count !== Math.min(5, Math.max(0, total - (page - 1) * 5))) throw new SourceError('INCOMPLETE_SEARCH');
  const navs = [...html.matchAll(/<nav class="pagination"[\s\S]*?<\/nav>/g)];
  if (!navs.length) throw new SourceError('PAGINATION_CHANGED');
  for (const nav of navs) {
    const current = nav[0].match(/<li class="item active">\s*<a[^>]*s-push-url="([^"]+)"/);
    if (!current || current[1] !== pageUrl(page)) throw new SourceError('PAGINATION_CHANGED');
    const links = [...nav[0].matchAll(/s-push-url="([^"]+)"/g)];
    if (!links.some(m => m[1] === pageUrl(pages))) throw new SourceError('PAGINATION_CHANGED');
    if (links.some(m => !Array.from({length: pages}, (_, i) => pageUrl(i + 1)).includes(m[1]!))) throw new SourceError('PAGINATION_CHANGED');
  }
  return { listings, total, pages };
}
export async function collect({ settings = registry.defaults(SOURCE_ID), transport = fetch, signal = AbortSignal.timeout(120000),
  pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)) }:
  { settings?: Record<string, number | null>; transport?: typeof fetch; signal?: AbortSignal; pause?: (ms: number) => Promise<void> } = {}) {
  registry.validate(SOURCE_ID, settings);
  const all: ReturnType<typeof parseCard>[] = []; let total: number | undefined; let pages = 1;
  for (let page = 1; page <= pages; page++) {
    if (page > 1) await pause(250);
    const parsed = parseSearch(await fetchHtml(pageUrl(page), transport, signal, pause), page);
    if (total !== undefined && total !== parsed.total) throw new SourceError('SEARCH_CHANGED_DURING_RUN');
    total = parsed.total; pages = parsed.pages; all.push(...parsed.listings);
  }
  if (new Set(all.map(x => x.externalId)).size !== all.length || new Set(all.map(x => x.canonicalUrl)).size !== all.length) throw new SourceError('DUPLICATE_CARD');
  const listings = all.filter(x => x.city === 'Groningen' && x.housingType !== 'kamer')
    .map(({housingType, ...listing}) => listing);
  return { listings, inspected: all.length, total, pages, available: listings.filter(x => x.availabilityStatus === 'available').length };
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
