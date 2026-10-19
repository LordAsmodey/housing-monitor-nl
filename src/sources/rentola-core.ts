import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { ListingInput } from '../listings/listings.service';
export const SourceError: new (category: string, blocked?: boolean, retryAfterSeconds?: number) =>
  Error & { category: string; blocked: boolean; retryAfterSeconds: number } = require('../../scripts/funda-core.cjs').FundaError;
export const SOURCE_ID = 'rentola:groningen-homes';
export const SEARCH_URL = 'https://rentola.nl/en/rent?location=240117&order=desc';
export const FILTERS = { city: 'Groningen', minRent: 0, maxRent: 1500, independentHousing: true };
export const RUN_TIMEOUT_MS = 240000;
type SearchOrder = 'desc';
type CollectionProgress = { phase: 'search' | 'details'; order: SearchOrder; pages: number;
  detailCandidates: number; detailsCompleted: number };
export class RunTimeoutError extends SourceError {
  constructor(public readonly progress: CollectionProgress & { elapsedMs: number }) { super('RUN_TIMEOUT'); }
}
function searchUrl(order: SearchOrder, page = 1) {
  const target = new URL(SEARCH_URL);
  target.searchParams.set('order', order);
  if (page > 1) target.searchParams.set('page', String(page));
  return target.href;
}
export const FULL_SCAN_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const HEAD_PAGES = 2;
const MAX_PAGES = 100;
const observationSchema = z.object({ fingerprint: z.string(), checkedAt: z.string().datetime(), accepted: z.boolean() });
const stateSchema = z.object({ version: z.literal(1), filtersKey: z.string(), lastFullScanAt: z.string().datetime(),
  observations: z.record(z.string(), observationSchema) });
export type CollectionState = z.infer<typeof stateSchema>;
export function readCollectionState(value: unknown): CollectionState | undefined {
  const parsed = stateSchema.safeParse(value); return parsed.success ? parsed.data : undefined;
}
const registry = require('../../scripts/search-settings.cjs');
const positive = z.number().positive().finite();
const property = z.object({ id: z.string().regex(/^\d{1,15}$/), type: z.literal('properties'),
  relationships: z.object({city:z.object({data:z.object({id:z.literal('240117'),type:z.literal('geocomponents')})})}),
  attributes: z.object({title:z.string().min(1).max(500),address:z.string().min(1).max(500),
    propertyType:z.string().min(1),monthlyRent:positive.max(99999999),rentCurrency:z.literal('EUR'),
    rentFrequency:z.literal('monthly'),countryCode:z.literal('nl'),slug:z.string().regex(/^[a-z0-9_-]+-(?:p[a-z0-9]+|[a-f0-9]{6})$/),
    area:z.string().regex(/^\d+(?:\.\d+)?$/).nullable(),rooms:positive.max(999).nullable(),estimatedArea:z.boolean()}) });
const searchSchema = z.object({data:z.array(property).max(21), included:z.array(z.object({id:z.string(),type:z.string(),
  attributes:z.object({name:z.string(),countryCode:z.string(),level:z.string()})})).default([]),
  // Count and totalPages are deliberately ignored: independent pages are not a snapshot.
  meta:z.object({pagination:z.object({currentPage:z.number().int().min(1),perPage:z.literal(21)})})});
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
  if (order !== 'desc' || params.location !== '240117' || params.order !== order || params.page !== String(page) ||
      ['priceMin','priceMax','sizeMin','sizeMax','roomMin','roomMax','rentPer'].some(k => params[k] !== '') ||
      !Array.isArray(params.propertyType) || params.propertyType.some((x: unknown) => x !== '') ||
      !Array.isArray(params.facility) || params.facility.length) throw new SourceError('SEARCH_FILTER_CHANGED');
  const parsed = searchSchema.safeParse(objectField(stream, 'searchPropertiesData'));
  if (!parsed.success) throw new SourceError('SEARCH_METADATA_CHANGED');
  const data = parsed.data; const pager = data.meta.pagination;
  const empty = data.data.length === 0;
  if (!empty && !data.included.some(x => x.type === 'geocomponents' && x.id === '240117' && x.attributes.name === 'Groningen' &&
      x.attributes.countryCode === 'nl' && x.attributes.level === 'city')) throw new SourceError('SEARCH_FILTER_CHANGED');
  // Rentola may clamp the page number when the requested page is past the end.
  if ((!empty && pager.currentPage !== page) || (empty && pager.currentPage > page)) throw new SourceError('PAGINATION_CHANGED');
  const ld = [...html.matchAll(/<script\b[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)]
    .map(m => json(m[1]!)).filter(x => x['@type'] === 'SearchResultsPage');
  if (ld.length !== 1 || ld[0].url !== searchUrl(order, page) || ld[0].mainEntity?.['@type'] !== 'ItemList' ||
      !Array.isArray(ld[0].mainEntity.itemListElement) || ld[0].mainEntity.itemListElement.length !== data.data.length) throw new SourceError('SEARCH_STRUCTURE_CHANGED');
  // Zero is deliberately not accepted until an actual empty page contract is verified.
  if (empty && page === 1) throw new SourceError('EMPTY_SEARCH_UNCONFIRMED');
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
  return {listings, ids:[...ids], urls:[...urls], ...pager, end: data.data.length < pager.perPage};
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
export type CollectOptions = { settings?:Record<string,number|null>; transport?:typeof fetch; signal?:AbortSignal;
  pause?:(ms:number)=>Promise<void>; now?:Date; previousState?:CollectionState; forceFull?:boolean };
export async function collect({settings = registry.defaults(SOURCE_ID), transport = fetch, signal = AbortSignal.timeout(RUN_TIMEOUT_MS),
  pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)), now = new Date(), previousState, forceFull = false}:
  CollectOptions = {}) {
  registry.validate(SOURCE_ID, settings);
  const startedAt = Date.now();
  const filtersKey = createHash('sha256').update(JSON.stringify(Object.entries(settings).sort(([a],[b]) => a.localeCompare(b)))).digest('hex');
  const previous = previousState?.filtersKey === filtersKey ? previousState : undefined;
  const full = forceFull || !previous || now.getTime() - Date.parse(previous.lastFullScanAt) >= FULL_SCAN_INTERVAL_MS;
  const mode = full ? 'full' : 'head';
  const observations: CollectionState['observations'] = full ? {} : {...previous!.observations};
  const progress: CollectionProgress = { phase: 'search', order: 'desc', pages: 0, detailCandidates: 0, detailsCompleted: 0 };
  try {
    const byId = new Map<string, ListingInput>(); const ids = new Set<string>();
    const urls = new Map<string,string>(); let ended = false; let duplicates = 0;
    for (let page = 1; page <= (full ? MAX_PAGES : HEAD_PAGES); page++) {
      if (page > 1) await pause(300);
      const next = parseSearch(await fetchHtml(searchUrl('desc', page), transport, signal, pause), page);
      progress.pages++;
      let added = 0;
      next.ids.forEach((id, index) => {
        const url = next.urls[index]!;
        if (urls.has(url) && urls.get(url) !== id) throw new SourceError('CARD_IDENTITY_CHANGED');
        urls.set(url,id);
        if (ids.has(id)) duplicates++; else {ids.add(id); added++;}
      });
      // A repeated full page must not masquerade as a completed daily scan.
      if (page > 1 && !added && !next.end) throw new SourceError('PAGINATION_LOOP');
      const qualifyingIds = new Set(next.listings.map(item => item.externalId));
      for (const id of next.ids) if (!qualifyingIds.has(id)) byId.delete(id);
      for (const item of next.listings) {
        const earlier = byId.get(item.externalId);
        if (earlier && earlier.canonicalUrl !== item.canonicalUrl) throw new SourceError('CARD_IDENTITY_CHANGED');
        byId.set(item.externalId,item); // latest observation wins for boundary overlap
      }
      if (next.end) {ended = true; break;}
    }
    if (full && !ended) throw new SourceError('PAGE_LIMIT');
    const candidates = [...byId.values()].filter(x => x.availabilityStatus === 'available' && registry.matches(settings, x, SOURCE_ID));
    // Invalidate old eligibility when the search now says unavailable/outside filters.
    const candidateIds = new Set(candidates.map(item => item.externalId));
    for (const id of ids) if (!candidateIds.has(id)) delete observations[id];
    const fingerprint = (item:ListingInput) => createHash('sha256').update(JSON.stringify(item)).digest('hex');
    const matched: ListingInput[] = []; const pending: ListingInput[] = []; let detailsReused = 0;
    for (const item of candidates) {
      const cached = previous?.observations[item.externalId];
      const age = cached ? now.getTime() - Date.parse(cached.checkedAt) : Infinity;
      if (!full && cached?.fingerprint === fingerprint(item) && age >= 0 && age < FULL_SCAN_INTERVAL_MS) {
        detailsReused++; observations[item.externalId] = cached;
        if (cached.accepted) matched.push(item);
      } else pending.push(item);
    }
    progress.phase = 'details'; progress.detailCandidates = pending.length;
    for (let index = 0; index < pending.length; index += 2) {
      const batch = pending.slice(index, index + 2);
      await pause(300);
      const results = await Promise.allSettled(batch.map(async (item, offset) => {
        if (offset) await pause(300);
        return parseDetail(await fetchHtml(item.canonicalUrl, transport, signal, pause), item);
      }));
      progress.detailsCompleted += results.filter(result => result.status === 'fulfilled').length;
      for (const result of results) if (result.status === 'rejected') throw result.reason;
      results.forEach((result, offset) => { if (result.status === 'fulfilled') {
        const item = batch[offset]!;
        observations[item.externalId] = {fingerprint:fingerprint(item), checkedAt:now.toISOString(), accepted:result.value};
        if (result.value) matched.push(item);
      }});
    }
    const collectionState: CollectionState = {version:1,filtersKey,
      lastFullScanAt:full ? now.toISOString() : previous!.lastFullScanAt,observations};
    return {listings:matched,inspected:ids.size,pages:progress.pages,searchOrder:'desc' as const, mode,
      coverage:full ? 'catalog' as const : 'head' as const, collectionState,
      diagnostics:{...progress, mode, duplicates, detailsReused, elapsedMs:Math.max(0, Date.now() - startedAt)},
      available:matched.length};
  } catch (error) {
    if (error instanceof SourceError && error.category === 'RUN_TIMEOUT') {
      throw new RunTimeoutError({...progress, elapsedMs:Math.max(0, Date.now() - startedAt)});
    }
    throw error;
  }
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
