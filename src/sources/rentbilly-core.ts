import { z } from 'zod';
import type { ListingInput } from '../listings/listings.service';
export const SourceError: new (category: string, blocked?: boolean, retryAfterSeconds?: number) =>
  Error & { category: string; blocked: boolean; retryAfterSeconds: number } = require('../../scripts/funda-core.cjs').FundaError;
export const SOURCE_ID = 'rentbilly:groningen-apartments-studios';
export const SEARCH_URL = 'https://rentbilly.nl/en/for-rent?location=groningen&property_types=apartment&property_types=studio&rent=0-1500&size=20';
export const FILTERS = { city: 'Groningen', minRent: 0, maxRent: 1500, minArea: 20, propertyTypes: ['apartment', 'studio'] };
export const RUN_TIMEOUT_MS = 240000;
const registry = require('../../scripts/search-settings.cjs');
type Settings = Record<string, number | null>;
const positive = z.number().finite().positive();
const attributes = z.object({title:z.string().min(1).max(500),address:z.string().min(1).max(500),
  propertyType:z.string().min(1),monthlyRent:positive.max(99999999),rentCurrency:z.literal('EUR'),
  rentFrequency:z.literal('monthly'),countryCode:z.literal('nl'),slug:z.string().regex(/^[a-z0-9_-]+-(?:p[a-z0-9]+|[a-f0-9]{6})$/),
  area:z.string().regex(/^\d+(?:\.\d+)?$/).nullable(),rooms:positive.max(999).nullable(),estimatedArea:z.boolean()});
const searchSchema = z.object({data:z.array(z.object({id:z.string().regex(/^\d{1,15}$/),type:z.literal('properties'),
  relationships:z.object({city:z.object({data:z.object({id:z.literal('240117'),type:z.literal('geocomponents')})})}),attributes})).max(21),
  included:z.array(z.object({id:z.string(),type:z.string(),attributes:z.object({name:z.string(),countryCode:z.string(),level:z.string()})})),
  meta:z.object({pagination:z.object({currentPage:z.number().int().min(1),totalPages:z.number().int().min(1).max(100),
    totalCount:z.number().int().nonnegative(),perPage:z.literal(21)})})});
export function pageUrl(page = 1, settings: Settings = registry.defaults(SOURCE_ID)) {
  if (!Number.isInteger(page) || page < 1 || page > 100) throw new SourceError('PAGE_LIMIT');
  const u = new URL(registry.queryUrl(SOURCE_ID, SEARCH_URL, settings));
  if (page > 1) u.searchParams.set('page', String(page));
  return u.href;
}
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
  if (u.protocol !== 'https:' || u.hostname !== 'rentbilly.nl' || u.port || u.username || u.password || u.search || u.hash ||
      !/^\/en\/listings\/[a-z0-9_-]+-(?:p[a-z0-9]+|[a-f0-9]{6})$/.test(u.pathname)) throw new SourceError('URL_NOT_ALLOWED');
  return u.href;
}
function blocked(html: string) {
  if (/just a moment|verify you are human|access denied|captcha challenge/i.test(html)) throw new SourceError('ACCESS_BLOCKED', true);
}
function structured(html: string, type: string) {
  const records = [...html.matchAll(/<script\b[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)]
    .map(m => json(m[1]!)).filter(x => x['@type'] === type);
  if (records.length !== 1) throw new SourceError('STRUCTURED_DATA_CHANGED');
  return records[0];
}
export function independentHousing(type: string, title: string) {
  return ['apartment','studio'].includes(type) && !/\b(kamer|kamers|room|rooms|studentenkamer|studentenhuis|gedeeld|shared|house\s*share|hospita|parkeerplaats|garage)\b/i.test(title);
}
export function parseSearch(html: string, page = 1, settings: Settings = registry.defaults(SOURCE_ID)) {
  blocked(html);
  const expectedUrl = pageUrl(page, settings);
  const stream = flight(html); const params = objectField(stream, 'listingsParams');
  if (params.location !== 'groningen' || params.order !== '' || params.page !== String(page) ||
      params.priceMin !== String(settings.minRent) || params.priceMax !== String(settings.maxRent) ||
      params.sizeMin !== (settings.minArea === null ? '' : String(settings.minArea)) ||
      ['sizeMax','roomMin','roomMax','rentPer'].some(k => params[k] !== '') ||
      !Array.isArray(params.propertyType) || JSON.stringify(params.propertyType.filter(Boolean).sort()) !== '["apartment","studio"]' ||
      !Array.isArray(params.facility) || params.facility.length) throw new SourceError('SEARCH_FILTER_CHANGED');
  const parsed = searchSchema.safeParse(objectField(stream, 'searchPropertiesData'));
  if (!parsed.success) throw new SourceError('SEARCH_METADATA_CHANGED');
  const data = parsed.data; const pager = data.meta.pagination;
  if (!data.data.length) throw new SourceError('EMPTY_SEARCH_UNCONFIRMED');
  if (pager.currentPage !== page || page > pager.totalPages || pager.totalPages !== Math.ceil(pager.totalCount / pager.perPage) ||
      data.data.length !== Math.min(pager.perPage, pager.totalCount - (page - 1) * pager.perPage)) throw new SourceError('INCOMPLETE_SEARCH');
  if (!data.included.some(x => x.type === 'geocomponents' && x.id === '240117' && x.attributes.name === 'Groningen' &&
      x.attributes.countryCode === 'nl' && x.attributes.level === 'city')) throw new SourceError('SEARCH_FILTER_CHANGED');
  const ld = structured(html, 'SearchResultsPage');
  if (ld.url !== expectedUrl || ld.mainEntity?.['@type'] !== 'ItemList' ||
      !Array.isArray(ld.mainEntity.itemListElement) || ld.mainEntity.itemListElement.length !== data.data.length) throw new SourceError('SEARCH_STRUCTURE_CHANGED');
  const listings: ListingInput[] = []; const ids = new Set<string>(); const urls = new Set<string>();
  data.data.forEach((p, index) => {
    const a = p.attributes; const canonicalUrl = allowedDetailUrl('/en/listings/' + a.slug);
    if (ids.has(p.id) || urls.has(canonicalUrl)) throw new SourceError('DUPLICATE_CARD');
    ids.add(p.id); urls.add(canonicalUrl);
    const entry = ld.mainEntity.itemListElement[index]; const offer = entry?.item?.offers;
    const home = offer?.itemOffered;
    const area = a.area === null ? undefined : Number(a.area);
    if (area !== undefined && (!Number.isFinite(area) || area <= 0 || area > 999999)) throw new SourceError('AREA_INVALID');
    if (entry?.position !== index + 1 || entry?.url !== canonicalUrl || entry.item?.url !== canonicalUrl || entry.item?.name !== a.title ||
        offer?.url !== canonicalUrl || offer?.price !== a.monthlyRent || offer?.priceCurrency !== 'EUR' ||
        home?.address?.addressLocality !== 'Groningen' || home.address.addressCountry !== 'NL' ||
        home.address.streetAddress !== a.address || (area !== undefined && (home.floorSize?.value !== area || home.floorSize.unitCode !== 'MTK')))
      throw new SourceError('CARD_METADATA_MISMATCH');
    if (!independentHousing(a.propertyType, a.title)) return;
    listings.push({externalId:p.id,canonicalUrl,title:a.title,address:a.address,city:'Groningen',rentPrice:a.monthlyRent,
      ...(area !== undefined && !a.estimatedArea ? {areaM2:area} : {}), ...(a.rooms !== null ? {rooms:a.rooms} : {}),
      availabilityStatus:offer.availability === 'https://schema.org/InStock' ? 'available' :
        ['https://schema.org/OutOfStock','https://schema.org/SoldOut'].includes(offer.availability) ? 'unavailable' : 'unknown'});
  });
  return {listings, ids:[...ids], urls:[...urls], ...pager};
}
export function parseDetail(html: string, item: ListingInput): ListingInput | undefined {
  blocked(html);
  const detail = structured(html, 'RealEstateListing'); const offer = detail.offers;
  const p = objectField(flight(html), 'propertyAttributes');
  if (detail.url !== item.canonicalUrl || detail.name !== item.title || offer?.url !== item.canonicalUrl ||
      offer?.price !== item.rentPrice || offer?.priceCurrency !== 'EUR' ||
      offer?.itemOffered?.address?.addressLocality !== 'Groningen' || offer.itemOffered.address.addressCountry !== 'NL' ||
      offer.itemOffered.address.streetAddress !== item.address ||
      p.title !== item.title || p.address !== item.address || p.monthlyRent !== item.rentPrice || p.rentCurrency !== 'EUR' ||
      p.rentFrequency !== 'monthly' || p.countryCode !== 'nl' || allowedDetailUrl('/en/listings/' + p.slug) !== item.canonicalUrl ||
      typeof detail.description !== 'string' || typeof p.desc !== 'string' || typeof p.estimatedArea !== 'boolean' ||
      typeof p.status !== 'string') throw new SourceError('DETAIL_METADATA_MISMATCH');
  if (item.areaM2 !== undefined && (p.estimatedArea || Number(p.area) !== item.areaM2 ||
      offer.itemOffered.floorSize?.value !== item.areaM2 || offer.itemOffered.floorSize.unitCode !== 'MTK')) throw new SourceError('DETAIL_METADATA_MISMATCH');
  if (!independentHousing(p.propertyType, p.title)) return;
  const plain = (s: string) => s.replace(/<[^>]*>/g,' ').replace(/&nbsp;|&#160;/g,' ').replace(/\s+/g,' ').trim();
  const description = plain(detail.description); const original = plain(p.desc);
  // Compare both public representations; unknown or empty descriptions do not confirm a private home.
  if (!description || !original) return;
  const room = /\b(studenten?kamers?|kamerverhuur|kamer|kamers|room|rooms|house\s*share|hospita)\b/i;
  const shared = /\b(?:gedeeld\w*|gemeenschappelijk\w*|gezamenlijk\w*|shared|communal)\s+(?:(?:een?|de|het|and|en)\s+)*(?:keuken|badkamer|douche|toilet|voorzieningen|kitchen|bathroom|shower|facilities)\b/i;
  const sharedAfter = /\b(?:keuken|badkamer|douche|toilet|voorzieningen|kitchen|bathroom|shower|facilities)\b[^.!?]{0,60}\b(?:gedeeld|delen|gemeenschappelijk\w*|gezamenlijk\w*|shared)\b/i;
  if ([description,original].some(s => room.test(s) || shared.test(s) || sharedAfter.test(s) || /\b(?:onzelfstandig\w*|niet[- ]zelfstandig\w*)\b/i.test(s))) return;
  const availabilityStatus = p.status === 'active' && offer.availability === 'https://schema.org/InStock' ? item.availabilityStatus :
    ['inactive','rented','expired','deleted'].includes(p.status) || ['https://schema.org/OutOfStock','https://schema.org/SoldOut'].includes(offer.availability) ? 'unavailable' : 'unknown';
  return {...item, availabilityStatus};
}
export async function collect({ settings = registry.defaults(SOURCE_ID), transport = fetch, signal = AbortSignal.timeout(RUN_TIMEOUT_MS),
  pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)) }:
  { settings?: Settings; transport?: typeof fetch; signal?: AbortSignal; pause?: (ms: number) => Promise<void> } = {}) {
  registry.validate(SOURCE_ID, settings);
  const cards: ListingInput[] = []; const ids = new Set<string>(); const urls = new Set<string>();
  let pages = 1, total = 0;
  for (let page = 1; page <= pages; page++) {
    if (page > 1) await pause(500);
    const result = parseSearch(await fetchHtml(pageUrl(page, settings), transport, signal, pause), page, settings);
    if (page > 1 && (pages !== result.totalPages || total !== result.totalCount)) throw new SourceError('SEARCH_CHANGED_DURING_RUN');
    pages = result.totalPages; total = result.totalCount;
    result.ids.forEach((id, i) => {
      if (ids.has(id) || urls.has(result.urls[i]!)) throw new SourceError('DUPLICATE_CARD');
      ids.add(id); urls.add(result.urls[i]!);
    });
    cards.push(...result.listings);
  }
  if (ids.size !== total) throw new SourceError('INCOMPLETE_SEARCH');
  const listings: ListingInput[] = [];
  for (const card of cards.filter(x => registry.matches(settings, x, SOURCE_ID))) {
    await pause(500);
    const item = parseDetail(await fetchHtml(card.canonicalUrl, transport, signal, pause), card);
    if (item) listings.push(item);
  }
  return {listings, inspected:ids.size, total, pages, available:listings.filter(x => x.availabilityStatus === 'available').length};
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
