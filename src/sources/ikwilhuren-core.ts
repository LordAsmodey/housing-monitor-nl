import { z } from 'zod';
import type { ListingInput } from '../listings/listings.service';
import { text, sections, SourceError } from './rotsvast-core';
export { SourceError };
export const SOURCE_ID = 'ikwilhuren:groningen-30km-homes';
export const SEARCH_URL = 'https://ikwilhuren.nu/aanbod/';
export const FEED_URL = 'https://ikwilhuren.nu/aanbod/feed/projects.json';
export const FILTERS = { city:'Groningen', radiusKm:30, minRent:0, maxRent:1500, independentHousing:true };
const registry = require('../../scripts/search-settings.cjs');
type Settings = Record<string, number | null>;
const origin = 'https://ikwilhuren.nu';
function one(html: string, cls: string, tag = 'div') {
  const parts = sections(html, cls, tag);
  if (parts.length !== 1) throw new SourceError('STRUCTURE_CHANGED');
  return parts[0]!;
}
export function allowedDetailUrl(value: string) {
  let u: URL;
  try { u = new URL(text(value), origin); } catch { throw new SourceError('INVALID_URL'); }
  if (u.origin !== origin || u.username || u.password || u.search || u.hash || !/^\/object\/[a-z0-9-]+-[a-f0-9]{32}\/$/.test(u.pathname)) throw new SourceError('URL_NOT_ALLOWED');
  return u.href;
}
function canonical(html: string, expected: string) {
  const links = [...html.matchAll(/<link\b[^>]*rel="canonical"[^>]*href="([^"]+)"[^>]*>/gi)];
  if (links.length !== 1 || text(links[0]![1]!) !== expected) throw new SourceError('CANONICAL_CHANGED');
  if (/Sessie is verlopen|verify you are human|just a moment|access denied/i.test(text(html))) throw new SourceError('ACCESS_BLOCKED', true);
}
function price(value: string) {
  const m = value.match(/^€\s*(\d{1,3}(?:\.\d{3})*|\d+),(\d{2}|-) \/mnd$/);
  const n = Number(m?.[1]?.replace(/\./g,'')) + (m?.[2] === '-' ? 0 : Number(m?.[2]) / 100);
  if (!m || !Number.isFinite(n) || n < 0 || n > 99999999) throw new SourceError('PRICE_INVALID');
  return n;
}
function area(value: string) {
  const m = value.match(/^(\d+(?:[.,]\d+)?) m\s*(?:2|²)$/); const n = Number(m?.[1]?.replace(',','.'));
  if (!m || !n || n > 999999) throw new SourceError('AREA_INVALID');
  return n;
}
function availability(status: string, clock: string): ListingInput['availabilityStatus'] {
  if (['Verhuurd','Verhuurd onder voorbehoud','Gereserveerd','Onder optie'].includes(status)) return 'unavailable';
  const m = clock.match(/^Beschikbaar vanaf (\d{2})-(\d{2})-(\d{4})$/);
  const iso = m ? `${m[3]}-${m[2]}-${m[1]}` : '';
  const date = new Date(iso + 'T00:00:00Z');
  const validDate = Number.isFinite(date.getTime()) && date.toISOString().slice(0,10) === iso;
  return status === 'Te huur' && (clock === 'Direct beschikbaar' || validDate) ? 'available' : 'unknown';
}
export function parseCard(html: string): ListingInput {
  const body = one(html,'card-body');
  const titleBlock = one(body,'card-title','span');
  const links = [...titleBlock.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)];
  if (links.length !== 1) throw new SourceError('CARD_STRUCTURE_CHANGED');
  const canonicalUrl = allowedDetailUrl(links[0]![1]!);
  const externalId = new URL(canonicalUrl).pathname.match(/-([a-f0-9]{32})\/$/)![1]!;
  const title = text(links[0]![2]!);
  const location = text(body.slice(body.indexOf(titleBlock)+titleBlock.length).match(/^\s*<span>([\s\S]*?)<\/span>/)?.[1] ?? '');
  const city = location.match(/^\d{4}[A-Z]{2} (.+)$/)?.[1];
  const amounts = one(body,'dotted-spans');
  const values = [...amounts.matchAll(/<span\b[^>]*>([\s\S]*?)<\/span>/gi)].map(m=>text(m[1]!));
  const status = text(one(html,'badge','span'));
  const clock = text(body.match(/<i\b[^>]*fa-calendar[^>]*><\/i><\/span>([\s\S]*?)<\/span>/)?.[1] ?? '');
  if (!title || title.length > 500 || !city || values.length < 1 || values.length > 3) throw new SourceError('CARD_METADATA_MISSING');
  const surfaces = values.slice(1).filter(x => /m\s*(?:2|²)$/.test(x));
  const bedrooms = values.slice(1).filter(x => /^[1-9]\d* slaapkamers?$/.test(x));
  if (surfaces.length > 1 || bedrooms.length > 1 || surfaces.length + bedrooms.length !== values.length-1) throw new SourceError('CARD_METADATA_MISSING');
  return { externalId,canonicalUrl,title,city,rentPrice:price(values[0]!),
    ...(surfaces[0] ? {areaM2:area(surfaces[0])} : {}), availabilityStatus:availability(status,clock) };
}
export function pageUrl(page: number) {
  if (!Number.isInteger(page) || page < 1 || page > 200) throw new SourceError('PAGE_LIMIT');
  return page === 1 ? SEARCH_URL : `${SEARCH_URL}?page=${page}`;
}
export function parseSearch(html: string, page = 1) {
  canonical(html, pageUrl(page));
  const counts = [...html.matchAll(/<span class="text-blue-ncs">(\d+)<\/span>\s*huurwoningen/g)].map(m=>Number(m[1]));
  if (counts.length !== 2 || counts[0] !== counts[1] || !counts[0] || counts[0] > 2000) throw new SourceError('SEARCH_COUNT_INVALID');
  const total = counts[0]; const pages = Math.ceil(total/10);
  const raw = sections(html,'card-woning');
  if (raw.length !== (page === pages ? total - (page-1)*10 : 10) || page > pages) throw new SourceError('INCOMPLETE_SEARCH');
  const current = [...html.matchAll(/<a\b[^>]*aria-current="page"[^>]*>(\d+)<\/a>/g)];
  const numbers = [...html.matchAll(/<a\b[^>]*href="\/aanbod\/\?page=(\d+)"\s+aria-label="Pagina (\d+)"[^>]*>(\d+)<\/a>/g)];
  if (pages > 1 && (current.length !== 1 || Number(current[0]![1]) !== page || numbers.length !== pages || numbers.some((m,i)=>Number(m[1]) !== i+1 || m[1] !== m[2] || m[2] !== m[3]))) throw new SourceError('PAGINATION_CHANGED');
  if (pages === 1 && current.length > 1) throw new SourceError('PAGINATION_CHANGED');
  return {listings:raw.map(parseCard),total,pages};
}
const coordinate = z.string().regex(/^-?\d+(?:\.\d+)?$/).transform(Number);
const feedSchema = z.record(z.string().regex(/^\d+$/),z.object({UUId:z.string().regex(/^[a-f0-9]{32}$/),Lat:coordinate,Lng:coordinate,cardInnerHtml:z.string().min(1).max(20000)}));
export function distanceKm(lat: number, lng: number) {
  const rad = Math.PI/180;
  return 6371*2*Math.asin(Math.min(1, Math.sqrt(Math.sin((lat-53.22223502)*rad/2)**2 + Math.cos(lat*rad)*Math.cos(53.22223502*rad)*Math.sin((lng-6.56338704)*rad/2)**2)));
}
export function parseFeed(input: unknown) {
  const result = feedSchema.safeParse(input);
  if (!result.success || !Object.keys(result.data).length || Object.keys(result.data).length > 2000) throw new SourceError('FEED_STRUCTURE_CHANGED');
  const map = new Map<string,{lat:number;lng:number}>();
  for (const entry of Object.values(result.data)) {
    if (entry.Lat < 50 || entry.Lat > 54 || entry.Lng < 3 || entry.Lng > 8 || map.has(entry.UUId)) throw new SourceError('FEED_COORDINATES_INVALID');
    const url = entry.cardInnerHtml.match(/href="([^"]+)"/)?.[1] ?? '';
    if (!allowedDetailUrl(url).endsWith(`-${entry.UUId}/`)) throw new SourceError('FEED_ID_MISMATCH');
    map.set(entry.UUId,{lat:entry.Lat,lng:entry.Lng});
  }
  return map;
}
export function parseDetail(html: string, card: ListingInput) {
  canonical(html,card.canonicalUrl);
  const tops = sections(html,'object-addres');
  if (tops.length !== 2 || tops[0] !== tops[1] && text(tops[0]!) !== text(tops[1]!)) throw new SourceError('DETAIL_STRUCTURE_CHANGED');
  const top = tops[0]!;
  const heading = text(top.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/)?.[1] ?? '');
  const location = text(top.match(/<p\b[^>]*>([\s\S]*?)<\/p>/)?.[1] ?? '');
  const loc = location.match(/^\d{4}[A-Z]{2} (.+) \(([^()]+)\)$/);
  const address = heading.match(/^[^:]+: (.+)$/)?.[1];
  const fields: Record<string,string> = {};
  for (const m of html.matchAll(/<tr\b[^>]*>\s*<th\b[^>]*>([\s\S]*?)<\/th>\s*<td\b[^>]*>([\s\S]*?)<\/td>\s*<\/tr>/g)) {
    const key = text(m[1]!); if (fields[key] !== undefined) throw new SourceError('DETAIL_STRUCTURE_CHANGED'); fields[key] = text(m[2]!);
  }
  if (!loc || loc[1] !== card.city || !address || !(card.title === address || card.title.endsWith(' '+address)) || !fields.Status) throw new SourceError('DETAIL_MISMATCH');
  const exactRent = price(fields.Huurprijs ?? '');
  if (exactRent !== card.rentPrice && Math.round(exactRent) !== card.rentPrice) throw new SourceError('DETAIL_MISMATCH');
  const exactArea = fields.Woonoppervlakte ? area(fields.Woonoppervlakte) : undefined;
  if (card.areaM2 !== undefined && exactArea === undefined) throw new SourceError('DETAIL_METADATA_MISSING');
  const item = {...card,address,rentPrice:exactRent,areaM2:exactArea};
  // Non-housing objects need no coordinates or residential description.
  if (!['Appartement','Eengezinswoning','Woonhuis'].includes(loc[2]!)) return {item,independent:false as const};
  const coords = [...html.matchAll(/data-lat="([^"]+)" data-lng="([^"]+)"/g)];
  if (coords.length !== 1) throw new SourceError('DETAIL_COORDINATES_MISSING');
  const lat = Number(coords[0]![1]), lng = Number(coords[0]![2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < 50 || lat > 54 || lng < 3 || lng > 8) throw new SourceError('DETAIL_COORDINATES_INVALID');
  const descriptions = sections(html,'object-description');
  if (descriptions.length !== 2) throw new SourceError('DETAIL_STRUCTURE_CHANGED');
  const description = text(descriptions[0]!);
  const independent = ['Appartement','Eengezinswoning','Woonhuis'].includes(loc[2]!) && description.length > 20 && !/\b(?:kamerverhuur|studentenkamer|onzelfstandig|gedeeld(?:e)?|gemeenschappelijk(?:e)?|shared (?:kitchen|bathroom|facilities)|rooms? for rent|kamers? te huur)\b/i.test(description);
  const headingStatus = heading.split(':')[0]!.trim();
  const statuses = [fields.Status,headingStatus];
  const status = statuses.some(x => ['verhuurd','verhuurd onder voorbehoud','gereserveerd','onder optie'].includes(x.toLowerCase())) ? 'unavailable' : statuses.every(x=>x.toLowerCase()==='te huur') ? card.availabilityStatus : 'unknown';
  return {item:{...item,availabilityStatus:status as ListingInput['availabilityStatus']},independent,lat,lng};
}

export async function collect({settings = registry.defaults(SOURCE_ID),transport = fetch,signal = AbortSignal.timeout(240000),pause = (ms: number)=>new Promise<void>(resolve=>setTimeout(resolve,ms))}:
  {settings?:Settings;transport?:typeof fetch;signal?:AbortSignal;pause?:(ms:number)=>Promise<void>} = {}) {
  registry.validate(SOURCE_ID,settings);
  let json: unknown;
  try { json = JSON.parse(await fetchHtml(FEED_URL,transport,signal,pause)); } catch (error) { if (error instanceof SourceError) throw error; throw new SourceError('INVALID_JSON'); }
  const feed = parseFeed(json);
  const cards: ListingInput[] = []; let pages = 1; let total = 0;
  for (let page=1; page<=pages;page++) {
    await pause(300);
    const parsed = parseSearch(await fetchHtml(pageUrl(page),transport,signal,pause),page);
    if (page>1 && total !== parsed.total) throw new SourceError('SEARCH_CHANGED_DURING_RUN');
    pages=parsed.pages;total=parsed.total;cards.push(...parsed.listings);
  }
  if (cards.length !== total || new Set(cards.map(x=>x.externalId)).size !== total || new Set(cards.map(x=>x.canonicalUrl)).size !== total) throw new SourceError('DUPLICATE_CARD');
  const listings: ListingInput[] = [];
  for (const card of cards) {
    // Archived cards can redirect to generic search. Their explicit status already
    // excludes notifications; only available candidates need residential details.
    if (card.availabilityStatus !== 'available') continue;
    // Search cards round rent and have a separate area projection. Only use
    // a conservative price prefilter; final filters use authoritative details.
    if (card.rentPrice! < settings.minRent! - 1 || card.rentPrice! > settings.maxRent! + 1) continue;
    const point = feed.get(card.externalId);
    // The map omits some catalog objects. Resolve missing coordinates from details;
    // never infer that an absent marker lies outside the search area.
    if (point && distanceKm(point.lat,point.lng)>30) continue;
    await pause(300);
    const detail = parseDetail(await fetchHtml(card.canonicalUrl,transport,signal,pause),card);
    if (!detail.independent) continue;
    if (point && (Math.abs(point.lat-detail.lat)>0.00001 || Math.abs(point.lng-detail.lng)>0.00001)) throw new SourceError('COORDINATES_CHANGED');
    if (registry.matches(settings,detail.item,SOURCE_ID) && distanceKm(detail.lat,detail.lng)<=30) listings.push(detail.item);
  }
  return {listings,inspected:total,total,pages,available:listings.filter(x=>x.availabilityStatus==='available').length};
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
  if (!(target === FEED_URL ? /application\/json/i : /text\/html/i).test(response.headers.get('content-type') ?? '')) throw new SourceError('CONTENT_TYPE');
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
