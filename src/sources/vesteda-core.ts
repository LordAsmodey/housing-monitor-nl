import { z } from 'zod';
import type { ListingInput } from '../listings/listings.service';

// Use the same error class as the shared runner so BLOCKED/cooldown survive.
export const SourceError: new (category: string, blocked?: boolean, retryAfterSeconds?: number) =>
  Error & { category: string; blocked: boolean; retryAfterSeconds: number } =
  require('../../scripts/funda-core.cjs').FundaError;
export const SOURCE_ID = 'vesteda:groningen-20km-500-1500';
export const SEARCH_URL = 'https://www.vesteda.com/nl/woning-zoeken?placeType=1&sortType=0&radius=20&s=Groningen,+Nederland&sc=woning&latitude=53.219383&longitude=6.5665016&filters=&priceFrom=500&priceTo=1500';
export const API_URL = 'https://www.vesteda.com/api/units/search/facet';
export const FILTERS = { city: 'Groningen', radiusKm: 20, minRent: 500, maxRent: 1500, filtering: 'vesteda-search' };

// Mirrors setInitialFilter in Vesteda's public client, including Number('') = 0.
export function searchPayload() {
  const q = new URL(SEARCH_URL).searchParams;
  return { filters: q.get('filters')!.split(',').map(Number), latitude: Number(q.get('latitude')),
    longitude: Number(q.get('longitude')), place: q.get('s'),
    placeObject: { latitude: q.get('latitude'), longitude: q.get('longitude'), placeType: q.get('placeType'), name: q.get('s') },
    placeType: Number(q.get('placeType')), radius: Number(q.get('radius')), sorting: Number(q.get('sortType')),
    priceFrom: Number(q.get('priceFrom')), priceTo: Number(q.get('priceTo')), language: 'nl' };
}

export function allowedDetailUrl(value: string, id: number) {
  let url: URL;
  try { url = new URL(value, 'https://www.vesteda.com'); } catch { throw new SourceError('INVALID_URL'); }
  if (url.protocol !== 'https:' || url.hostname !== 'www.vesteda.com' || url.port || url.username || url.password || url.search || url.hash ||
      !/^\/nl\/huurwoningen-[a-z0-9-]+\/[a-z0-9-]+\/[a-z0-9-]+$/.test(url.pathname) || !url.pathname.endsWith(`-${id}`)) {
    throw new SourceError('URL_NOT_ALLOWED');
  }
  return url.href;
}

const count = z.number().int().min(0).max(2000);
const object = z.object({
  id: z.number().int().positive(), entitytypeid: z.literal(1),
  street: z.string().trim().min(1).max(300), houseNumber: z.string().trim().min(1).max(50),
  houseNumberAddition: z.string().trim().max(50).nullable(), city: z.string().trim().min(1).max(200),
  url: z.string().min(1).max(2048), size: z.number().positive().max(999999),
  priceUnformatted: z.number().positive().max(99999999), status: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]),
});
const complex = z.object({ id: z.number().int().positive(), entitytypeid: z.literal(2) });
const responseSchema = z.object({ count, results: z.object({
  sortType: z.literal(0), objects: z.array(object).max(2000), objectsCount: count,
  complexes: z.array(complex).max(2000), complexesCount: count,
  newComplexes: z.array(complex).max(2000), newComplexesCount: count,
}) });

export function parseSearch(input: unknown) {
  const parsed = responseSchema.safeParse(input);
  if (!parsed.success) throw new SourceError('SEARCH_STRUCTURE_CHANGED');
  const { results: r, count: total } = parsed.data;
  if (r.objects.length !== r.objectsCount || r.complexes.length !== r.complexesCount || r.newComplexes.length !== r.newComplexesCount ||
      total !== r.objectsCount + r.complexesCount + r.newComplexesCount) throw new SourceError('INCOMPLETE_SEARCH');
  const listings: ListingInput[] = r.objects.map(item => {
    const title = `${item.street} ${item.houseNumber}${item.houseNumberAddition ? ` ${item.houseNumberAddition}` : ''}`;
    return { externalId: String(item.id), canonicalUrl: allowedDetailUrl(item.url, item.id), title, address: title,
      city: item.city, rentPrice: item.priceUnformatted, areaM2: item.size,
      availabilityStatus: item.status === 1 || item.status === 5 ? 'available' : 'unavailable' };
  });
  if (new Set(listings.map(x => x.externalId)).size !== listings.length || new Set(listings.map(x => x.canonicalUrl)).size !== listings.length) {
    throw new SourceError('DUPLICATE_CARD');
  }
  // Bedrooms are not total rooms; complexes are not available individual homes.
  return { listings, inspected: listings.length, pages: 1, total,
    available: listings.filter(x => x.availabilityStatus === 'available').length };
}

export async function collect({ transport = fetch, signal = AbortSignal.timeout(120000),
  pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)) }:
  { transport?: typeof fetch; signal?: AbortSignal; pause?: (ms: number) => Promise<void> } = {}) {
  let response: Response | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (signal.aborted) throw new SourceError('RUN_TIMEOUT');
    try {
      response = await transport(API_URL, { method: 'POST', redirect: 'manual', signal,
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(searchPayload()) });
    } catch {
      if (attempt === 2 || signal.aborted) throw new SourceError(signal.aborted ? 'RUN_TIMEOUT' : 'HTTP_TRANSPORT');
      await pause(1000); continue;
    }
    if (![502, 503, 504].includes(response.status) || attempt === 2) break;
    await response.body?.cancel(); await pause(1000);
  }
  if (!response) throw new SourceError('HTTP_TRANSPORT');
  if ([401, 403].includes(response.status)) throw new SourceError('ACCESS_BLOCKED', true);
  if (response.status === 429) throw new SourceError('RATE_LIMIT', false, 900);
  if (!response.ok) throw new SourceError('HTTP_STATUS');
  if (!/application\/json/i.test(response.headers.get('content-type') ?? '')) throw new SourceError('CONTENT_TYPE');
  const reader = response.body?.getReader();
  if (!reader) throw new SourceError('EMPTY_BODY');
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length;
      if (size > 8 * 1024 * 1024) { await reader.cancel(); throw new SourceError('BODY_TOO_LARGE'); }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof SourceError) throw error;
    throw new SourceError(signal.aborted ? 'RUN_TIMEOUT' : 'HTTP_TRANSPORT');
  }
  let json: unknown;
  try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new SourceError('INVALID_JSON'); }
  return parseSearch(json);
}
