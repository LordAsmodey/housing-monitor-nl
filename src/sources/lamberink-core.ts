import { z } from 'zod';
import type { ListingInput } from '../listings/listings.service';
// Preserve the shared runner's BLOCKED/cooldown classification.
export const SourceError: new (category: string, blocked?: boolean, retryAfterSeconds?: number) =>
  Error & { category: string; blocked: boolean; retryAfterSeconds: number } =
  require('../../scripts/funda-core.cjs').FundaError;

export const SOURCE_ID = 'lamberink:rental-homes';
export const SEARCH_URL = 'https://lamberink.nl/wonen/aanbod?buy_rent=rent&order_by=created_at-desc&page=1';
export const API_URL = 'https://lamberink.nl/api/properties/available.json';
export const FILTERS = { buyRent: 'rent', propertyTypes: ['woonhuis', 'appartement'], orderBy: 'created_at-desc', minRent: 0, maxRent: null };

// The site's Vue client fetches the complete available catalog once, then filters
// buy_rent (including "both") and paginates locally. API count is before filtering.
const identity = z.object({
  object_code: z.string().regex(/^[A-Z0-9]{1,64}$/),
  filters: z.object({ buy_rent: z.enum(['buy', 'rent', 'both']), object_type: z.string().min(1).max(100) }),
});
const responseSchema = z.object({ count: z.number().int().min(0).max(2000), objects: z.array(identity.passthrough()).max(2000) });
const homeSchema = identity.extend({
  url: z.string().min(1).max(2048), short_title: z.string().trim().min(1).max(500),
  place: z.string().trim().min(1).max(200),
  rent_price: z.number().nonnegative().max(99999999), rent_condition: z.literal('per maand'),
  usable_area_living_function: z.number().positive().max(999999),
  amount_of_rooms: z.number().int().positive().max(999).nullable(),
  created_at: z.iso.datetime({ offset: true }),
  publish_date: z.iso.datetime({ offset: true }).nullable(),
  availability_status: z.string().trim().min(1).max(100),
  is_available: z.boolean(), is_sold_or_rented: z.boolean(), is_forbidden: z.boolean(),
});

export function allowedDetailUrl(value: string, id: string) {
  let url: URL;
  try { url = new URL(value, 'https://lamberink.nl'); } catch { throw new SourceError('INVALID_URL'); }
  if (url.protocol !== 'https:' || url.hostname !== 'lamberink.nl' || url.port || url.username || url.password || url.search || url.hash ||
      !/^\/wonen\/aanbod\/[a-z0-9-]+$/.test(url.pathname) || !url.pathname.endsWith('-' + id.toLowerCase())) {
    throw new SourceError('URL_NOT_ALLOWED');
  }
  return url.href;
}

export function parseSearch(input: unknown) {
  const parsed = responseSchema.safeParse(input);
  if (!parsed.success) throw new SourceError('SEARCH_STRUCTURE_CHANGED');
  const { count: total, objects } = parsed.data;
  if (objects.length !== total) throw new SourceError('INCOMPLETE_SEARCH');
  if (new Set(objects.map(x => x.object_code)).size !== total) throw new SourceError('DUPLICATE_CARD');
  const homes = objects.filter(x => x.filters.buy_rent !== 'buy' && FILTERS.propertyTypes.includes(x.filters.object_type));
  const validated = homes.map(x => {
    const home = homeSchema.safeParse(x);
    if (!home.success) throw new SourceError('CARD_METADATA_MISSING');
    return home.data;
  }).sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  const listings: ListingInput[] = validated.map(x => {
    const status = x.availability_status.toLowerCase().replace(/[\s_-]+/g, '');
    const unavailable = !x.is_available || x.is_sold_or_rented || x.is_forbidden ||
      ['verhuurd', 'verkocht', 'verhuurdondervoorbehoud', 'verkochtondervoorbehoud', 'onderoptie', 'onderbod', 'ingetrokken'].includes(status);
    return { externalId: x.object_code, canonicalUrl: allowedDetailUrl(x.url, x.object_code),
      title: x.short_title, address: x.short_title, city: x.place, rentPrice: x.rent_price,
      areaM2: x.usable_area_living_function, ...(x.amount_of_rooms === null ? {} : { rooms: x.amount_of_rooms }),
      ...(x.publish_date === null ? {} : { publishedAt: new Date(x.publish_date) }),
      availabilityStatus: unavailable ? 'unavailable' : status === 'beschikbaar' ? 'available' : 'unknown' };
  });
  if (new Set(listings.map(x => x.canonicalUrl)).size !== listings.length) throw new SourceError('DUPLICATE_CARD');
  return { listings, inspected: total, total, pages: 1, available: listings.filter(x => x.availabilityStatus === 'available').length };
}

export async function collect({ settings, transport = fetch, signal = AbortSignal.timeout(120000),
  pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)) }:
  { settings?: Record<string, number | null>; transport?: typeof fetch; signal?: AbortSignal; pause?: (ms: number) => Promise<void> } = {}) {
  let response: Response | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (signal.aborted) throw new SourceError('RUN_TIMEOUT');
    try {
      response = await transport(API_URL, { method: 'GET', redirect: 'manual', signal,
        headers: { Accept: 'application/json', 'Accept-Language': 'nl-NL' } });
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
