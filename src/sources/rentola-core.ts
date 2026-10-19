import { z } from 'zod';
import type { ListingInput } from '../listings/listings.service';
export const SourceError: new (category: string, blocked?: boolean, retryAfterSeconds?: number) =>
  Error & { category: string; blocked: boolean; retryAfterSeconds: number } = require('../../scripts/funda-core.cjs').FundaError;
export const SOURCE_ID = 'rentola:groningen-homes';
export const SEARCH_URL = 'https://rentola.nl/en/rent?location=240117&order=desc';
export const FILTERS = { city: 'Groningen', minRent: 0, maxRent: 1500, independentHousing: true };
type SearchOrder = 'desc' | 'rent_asc';
function searchUrl(order: SearchOrder, page = 1) {
  const target = new URL(SEARCH_URL);
  target.searchParams.set('order', order);
  if (page > 1) target.searchParams.set('page', String(page));
  return target.href;
}
export class SearchChangedError extends SourceError {
  constructor(public readonly page: number,
    public readonly expected: { totalCount: number; totalPages: number },
    public readonly actual: { totalCount: number; totalPages: number },
    public readonly order: SearchOrder = 'desc') {
    super('SEARCH_CHANGED_DURING_RUN');
  }
}
const registry = require('../../scripts/search-settings.cjs');
const positive = z.number().positive().finite();
const property = z.object({ id: z.string().regex(/^\d{1,15}$/), type: z.literal('properties'),
  relationships: z.object({city:z.object({data:z.object({id:z.literal('240117'),type:z.literal('geocomponents')})})}),
  attributes: z.object({title:z.string().min(1).max(500),address:z.string().min(1).max(500),
    propertyType:z.string().min(1),monthlyRent:positive.max(99999999),rentCurrency:z.literal('EUR'),
    rentFrequency:z.literal('monthly'),countryCode:z.literal('nl'),slug:z.string().regex(/^[a-z0-9_-]+-(?:p[a-z0-9]+|[a-f0-9]{6})$/),
    area:z.string().regex(/^\d+(?:\.\d+)?$/).nullable(),rooms:positive.max(999).nullable(),estimatedArea:z.boolean()}) });
const searchSchema = z.object({data:z.array(property), included:z.array(z.object({id:z.string(),type:z.string(),
  attributes:z.object({name:z.string(),countryCode:z.string(),level:z.string()})})),
  meta:z.object({pagination:z.object({currentPage:z.number().int().min(1),totalPages:z.number().int().min(0).max(100),
    totalCount:z.number().int().min(0).max(2100),perPage:z.literal(21)})})});
function json(value: string): any { try { return JSON.parse(value); } catch { throw new SourceError('INVALID_JSON'); } }
// Decode public Next.js string chunks as data; never evaluate page JavaScript.
function flight(html: string) {
  const chunks: string[] = [];
  for (const m of html.matchAll(/<script\b[^>]*>self\.__next_f\.push\((\[.*?\])\)<\/script>/g)) {
    const value = json(m[1]!);
    if (value[0] === 1 && typeof value[1] === 'string') chunks.push(value[1]);
  }
  return chunks.join('');
}
function objectField(stream: string, field: string) {
  const token = '"' + field + '":{'; const start = stream.indexOf(token);
  if (start < 0 || stream.indexOf(token, start + token.length) >= 0) throw new SourceError('SEARCH_STRUCTURE_CHANGED');
  const begin = start + token.length - 1;
  let depth = 0, quoted = false, escaped = false;
  for (let i = begin; i < stream.length; i++) {
    const c = stream[i];
    if (quoted) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') quoted = false; }
    else if (c === '"') quoted = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return json(stream.slice(begin, i + 1));
  }
  throw new SourceError('HTML_TRUNCATED');
}
export function allowedDetailUrl(value: string) {
  let u: URL; try { u = new URL(value, SEARCH_URL); } catch { throw new SourceError('INVALID_URL'); }
  if (u.protocol !== 'https:' || u.hostname !== 'rentola.nl' || u.port || u.username || u.password || u.search || u.hash ||
      !/^\/en\/listings\/[a-z0-9_-]+-(?:p[a-z0-9]+|[a-f0-9]{6})$/.test(u.pathname)) throw new SourceError('URL_NOT_ALLOWED');
  return u.href;
}
export function independentHousing(type: string, title: string) {
  // Rentola imports inconsistent categories, including rooms labelled house.
  if (/\b(kamer|kamers|room|rooms|studentenkamer|studentenhuis|gedeeld|shared|house\s*share|hospita|parkeerplaats|garage)\b/i.test(title)) return false;
  if (type === 'apartment' || type === 'studio') return true;
  return type === 'house' && /\b(house|woning|eengezinswoning|woonhuis|appartement|apartment|studio)\b/i.test(title);
}
export function parseSearch(html: string, page = 1, order: SearchOrder = 'desc') {
  if (/just a moment|verify you are human|access denied|captcha challenge/i.test(html)) throw new SourceError('ACCESS_BLOCKED', true);
  const stream = flight(html); const params = objectField(stream, 'listingsParams');
  if (!['desc', 'rent_asc'].includes(order) || params.location !== '240117' || params.order !== order || params.page !== String(page) ||
      ['priceMin','priceMax','sizeMin','sizeMax','roomMin','roomMax','rentPer'].some(k => params[k] !== '') ||
      !Array.isArray(params.propertyType) || params.propertyType.some((x: unknown) => x !== '') ||
      !Array.isArray(params.facility) || params.facility.length) throw new SourceError('SEARCH_FILTER_CHANGED');
  const parsed = searchSchema.safeParse(objectField(stream, 'searchPropertiesData'));
  if (!parsed.success) throw new SourceError('SEARCH_METADATA_CHANGED');
  const data = parsed.data; const pager = data.meta.pagination;
  if (!data.included.some(x => x.type === 'geocomponents' && x.id === '240117' && x.attributes.name === 'Groningen' &&
      x.attributes.countryCode === 'nl' && x.attributes.level === 'city')) throw new SourceError('SEARCH_FILTER_CHANGED');
  if (pager.currentPage !== page || pager.totalPages !== Math.max(1, Math.ceil(pager.totalCount / pager.perPage)) ||
      page > pager.totalPages) throw new SourceError('PAGINATION_CHANGED');
  if (data.data.length !== Math.min(pager.perPage, Math.max(0, pager.totalCount - (page - 1) * pager.perPage))) throw new SourceError('INCOMPLETE_SEARCH');
  const ld = [...html.matchAll(/<script\b[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)]
    .map(m => json(m[1]!)).filter(x => x['@type'] === 'SearchResultsPage');
  if (ld.length !== 1 || ld[0].url !== searchUrl(order, page) || ld[0].mainEntity?.['@type'] !== 'ItemList' ||
      !Array.isArray(ld[0].mainEntity.itemListElement) || ld[0].mainEntity.itemListElement.length !== data.data.length) throw new SourceError('SEARCH_STRUCTURE_CHANGED');
  // Zero is deliberately not accepted until an actual empty page contract is verified.
  if (!pager.totalCount) throw new SourceError('EMPTY_SEARCH_UNCONFIRMED');
  const listings: ListingInput[] = []; const ids = new Set<string>(); const urls = new Set<string>();
  data.data.forEach((p, index) => {
    const a = p.attributes; const canonicalUrl = allowedDetailUrl('/en/listings/' + a.slug);
    if (ids.has(p.id) || urls.has(canonicalUrl)) throw new SourceError('DUPLICATE_CARD');
    ids.add(p.id); urls.add(canonicalUrl);
    const item = ld[0].mainEntity.itemListElement[index]; const offer = item?.item?.offers;
    if (item?.url !== canonicalUrl || item.item?.url !== canonicalUrl || item.item?.name !== a.title ||
        offer?.url !== canonicalUrl || offer?.price !== a.monthlyRent || offer?.priceCurrency !== 'EUR' ||
        offer?.itemOffered?.address?.addressLocality !== 'Groningen' || offer.itemOffered.address.addressCountry !== 'NL' ||
        offer.itemOffered.address.streetAddress !== a.address) throw new SourceError('CARD_METADATA_MISMATCH');
    const area = a.area === null ? undefined : Number(a.area);
    if (area !== undefined && (!Number.isFinite(area) || area <= 0 || area > 999999)) throw new SourceError('CARD_METADATA_MISSING');
    if (!independentHousing(a.propertyType, a.title)) return;
    listings.push({externalId:p.id,canonicalUrl,title:a.title,address:a.address,city:'Groningen',rentPrice:a.monthlyRent,
      ...(area !== undefined && !a.estimatedArea ? {areaM2:area} : {}), ...(a.rooms !== null ? {rooms:a.rooms} : {}),
      availabilityStatus:offer.availability === 'https://schema.org/InStock' ? 'available' :
        ['https://schema.org/OutOfStock','https://schema.org/SoldOut'].includes(offer.availability) ? 'unavailable' : 'unknown'});
  });
  return {listings, ids:[...ids], urls:[...urls], ...pager};
}
// A room can be labelled apartment even on its detail page. Read the description
// before admitting every budget-matching candidate; search categories alone are unsafe.
export function parseDetail(html: string, item: ListingInput) {
  if (/just a moment|verify you are human|access denied|captcha challenge/i.test(html)) throw new SourceError('ACCESS_BLOCKED', true);
  const records = [...html.matchAll(/<script\b[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)]
    .map(m => json(m[1]!)).filter(x => x['@type'] === 'RealEstateListing');
  if (records.length !== 1) throw new SourceError('DETAIL_STRUCTURE_CHANGED');
  const detail = records[0]; const offer = detail.offers;
  if (detail.url !== item.canonicalUrl || detail.name !== item.title || offer?.price !== item.rentPrice ||
      offer?.priceCurrency !== 'EUR' || offer?.itemOffered?.address?.addressLocality !== 'Groningen' ||
      typeof detail.description !== 'string') throw new SourceError('DETAIL_METADATA_MISMATCH');
  if (!detail.description.trim()) return false; // Explicitly empty descriptions cannot confirm independent housing.
  const description = detail.description.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
  // Do not match slaapkamer/woonkamer or a shared entrance/garden to a private home.
  const room = /\b(studenten?kamers?|kamerverhuur|kamer|kamers|room|rooms|house\s*share|hospita)\b/i;
  const shared = /\b(?:gedeeld\w*|gemeenschappelijk\w*|gezamenlijk\w*|shared|communal)\s+(?:(?:een?|de|het|and|en)\s+)*(?:keuken|badkamer|douche|toilet|voorzieningen|kitchen|bathroom|shower|facilities)\b/i;
  const nonIndependent = /\b(?:onzelfstandig\w*|niet[- ]zelfstandig\w*)\b/i;
  const sharedAfter = /\b(?:keuken|badkamer|douche|toilet|voorzieningen|kitchen|bathroom|shower|facilities)\b[^.!?]{0,60}\b(?:gedeeld|delen|gemeenschappelijk\w*|gezamenlijk\w*|shared)\b/i;
  if (room.test(description) || shared.test(description) || sharedAfter.test(description) || nonIndependent.test(description)) return false;
  return offer.availability === 'https://schema.org/InStock' && item.availabilityStatus === 'available';
}
export async function collect({settings = registry.defaults(SOURCE_ID), transport = fetch, signal = AbortSignal.timeout(140000),
  pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))}:
  {settings?:Record<string,number|null>;transport?:typeof fetch;signal?:AbortSignal;pause?:(ms:number)=>Promise<void>} = {}) {
  registry.validate(SOURCE_ID, settings);
  async function search(order: SearchOrder) {
    const first = parseSearch(await fetchHtml(searchUrl(order), transport, signal, pause), 1, order);
    const listings = [...first.listings]; const ids = new Set(first.ids); const urls = new Set(first.urls);
    for (let page = 2; page <= first.totalPages; page++) {
      await pause(300);
      const next = parseSearch(await fetchHtml(searchUrl(order, page), transport, signal, pause), page, order);
      if (next.totalCount !== first.totalCount || next.totalPages !== first.totalPages) throw new SearchChangedError(page,
        { totalCount: first.totalCount, totalPages: first.totalPages },
        { totalCount: next.totalCount, totalPages: next.totalPages }, order);
      for (const id of next.ids) { if (ids.has(id)) throw new SourceError('DUPLICATE_CARD'); ids.add(id); }
      for (const url of next.urls) { if (urls.has(url)) throw new SourceError('DUPLICATE_CARD'); urls.add(url); }
      listings.push(...next.listings);
    }
    if (ids.size !== first.totalCount) throw new SourceError('INCOMPLETE_SEARCH');
    return { first, listings, order };
  }
  let result: Awaited<ReturnType<typeof search>>;
  let recoveredFrom: { page: number; expected: SearchChangedError['expected']; actual: SearchChangedError['actual'] } | undefined;
  try { result = await search('desc'); }
  catch (error) {
    if (!(error instanceof SearchChangedError)) throw error;
    recoveredFrom = { page: error.page, expected: error.expected, actual: error.actual };
    // Rentola can serve an inconsistent newest-first catalog across repeated GETs.
    // Discard it completely and retry the same unfiltered catalog with the site's
    // supported price order. Both scans share the original deadline and lease.
    await pause(1000);
    result = await search('rent_asc');
  }
  const { first, listings } = result;
  const candidates = listings.filter(x => registry.matches(settings, x, SOURCE_ID));
  const matched: ListingInput[] = [];
  for (let index = 0; index < candidates.length; index += 2) {
    const batch = candidates.slice(index, index + 2);
    await pause(300);
    // At most two requests in flight. Stagger starts and await both even on failure,
    // so a failed run never leaves detached requests running after lease release.
    const results = await Promise.allSettled(batch.map(async (item, offset) => {
      if (offset) await pause(300);
      return parseDetail(await fetchHtml(item.canonicalUrl, transport, signal, pause), item);
    }));
    for (const result of results) if (result.status === 'rejected') throw result.reason;
    results.forEach((result, offset) => { if (result.status === 'fulfilled' && result.value) matched.push(batch[offset]!); });
  }
  return {listings:matched,total:first.totalCount,inspected:first.totalCount,pages:first.totalPages,
    searchOrder:result.order, ...(recoveredFrom ? {recoveredFrom} : {}),
    available:matched.filter(x => x.availabilityStatus === 'available').length};
}

async function fetchHtml(target: string, transport: typeof fetch, signal: AbortSignal, pause: (ms: number) => Promise<void>) {
  let response: Response | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (signal.aborted) throw new SourceError('RUN_TIMEOUT');
    try { response = await transport(target, { redirect: 'manual', signal, headers: { Accept: 'text/html', 'Accept-Language': 'en' } }); }
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
