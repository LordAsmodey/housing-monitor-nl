'use strict';

// Deterministic HTTP fast path. Never executes page scripts or LLM-generated code.
const FILTERS = Object.freeze({ city: 'Groningen', latitude: 53.2194, longitude: 6.5665,
  radiusKm: 30, maxRent: 1500, maxAgeHours: 72, priceBasis: 'advertised-monthly-rent' });
const SOURCE_ID = 'funda:groningen-30km-1500-3d';
const SEARCH_URL = 'https://www.funda.nl/zoeken/huur?' + new URLSearchParams({
  selected_area: JSON.stringify(['groningen,30km']), price: JSON.stringify('-1500'),
  sort: JSON.stringify('date_down'),
}).toString();
class FundaError extends Error {
  constructor(category, blocked = false, retryAfterSeconds = 0) {
    super(category); this.category = category; this.blocked = blocked;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}
function text(html) {
  return html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]*>/g, ' ').replace(/&(?:nbsp|#160);/g, ' ').replace(/&amp;/g, '&')
    .replace(/&(?:euro|#8364);/g, '€').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => Number(n) <= 0x10ffff ? String.fromCodePoint(Number(n)) : '')
    .replace(/\s+/g, ' ').trim();
}
function allowedUrl(value, kind = 'detail') {
  let url;
  try { url = new URL(value.replace(/&amp;/g, '&'), 'https://www.funda.nl'); }
  catch { throw new FundaError('INVALID_URL'); }
  if (url.protocol !== 'https:' || url.hostname !== 'www.funda.nl' || url.port
    || url.username || url.password) throw new FundaError('URL_NOT_ALLOWED');
  if (kind === 'search') {
    if (url.pathname !== '/zoeken/huur') throw new FundaError('URL_NOT_ALLOWED');
    const expected = new URL(SEARCH_URL);
    for (const key of ['selected_area', 'price', 'sort']) {
      if (url.searchParams.get(key) !== expected.searchParams.get(key)) throw new FundaError('SEARCH_FILTER_CHANGED');
    }
    for (const key of url.searchParams.keys()) if (!['selected_area', 'price', 'sort', 'page'].includes(key)) throw new FundaError('SEARCH_FILTER_CHANGED');
    if (url.searchParams.has('page') && !/^[1-9]\d*$/.test(url.searchParams.get('page'))) throw new FundaError('INVALID_PAGE');
  } else {
    if (!/^\/(?:en\/)?detail\/huur\/[^/]+\/[^/]+\/\d+\/$/.test(url.pathname)) throw new FundaError('URL_NOT_ALLOWED');
    url.pathname = url.pathname.replace(/^\/en\//, '/'); url.search = '';
  }
  url.hash = ''; return url.href;
}
function guardPage(html) {
  if (/captcha|verify you are human|verifieer.{0,20}mens|access denied|just a moment|unusual traffic|bevestig.{0,20}mens/i.test(text(html))) {
    throw new FundaError('HUMAN_CHECK', true);
  }
}
function attributes(tag) {
  return Object.fromEntries([...tag.matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map(m => [m[1].toLowerCase(), m[2] ?? m[3]]));
}
function parseSearch(html, currentUrl = SEARCH_URL) {
  guardPage(html); allowedUrl(currentUrl, 'search');
  const urls = new Set(); let next;
  for (const match of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const attr = attributes(match[1]); if (!attr.href) continue;
    const href = attr.href.replace(/&amp;/g, '&');
    if (/\/(?:en\/)?detail\/huur\//.test(href) && !/\/verhuurd\//.test(href)) urls.add(allowedUrl(href));
    if ((attr.rel ?? '').split(' ').includes('next') || /^(volgende(?: pagina)?|next(?: page)?)$/i.test(text(match[2]))
      || /^(volgende(?: pagina)?|next(?: page)?)$/i.test(attr['aria-label'] ?? '')) {
      next = allowedUrl(new URL(href, currentUrl).href, 'search');
    }
  }
  for (const match of html.matchAll(/<link\b([^>]*)>/gi)) {
    const attr = attributes(match[1]);
    if (attr.rel === 'next' && attr.href) next = allowedUrl(new URL(attr.href.replace(/&amp;/g, '&'), currentUrl).href, 'search');
  }
  const heading = [...html.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi)].map(m => text(m[1])).join(' ');
  const totalMatch = (heading + ' ' + text(html)).match(/([\d.,]+)\s+(?:huurwoningen|woningen|rental properties|properties)/i);
  const total = totalMatch ? Number(totalMatch[1].replace(/[.,]/g, '')) : undefined;
  const empty = /geen (?:huurwoningen|woningen|resultaten) gevonden|no (?:homes|properties|results) found/i.test(text(html));
  if (!urls.size && !(total === 0 || empty)) throw new FundaError('SEARCH_STRUCTURE_CHANGED');
  if (urls.size && total === undefined) throw new FundaError('SEARCH_COUNT_MISSING');
  if (total === 0 && urls.size) throw new FundaError('SEARCH_COUNT_MISMATCH');
  return { urls: [...urls], next, total: total ?? 0 };
}
function structuredData(html) {
  const objects = [];
  function walk(v) {
    if (!v || typeof v !== 'object') return;
    if (!Array.isArray(v)) objects.push(v);
    for (const child of Object.values(v)) if (typeof child === 'object') walk(child);
  }
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (attributes(match[1]).type !== 'application/ld+json') continue;
    try { walk(JSON.parse(match[2])); } catch { throw new FundaError('INVALID_STRUCTURED_DATA'); }
  }
  return objects;
}
function fact(html, labels) {
  for (const match of html.matchAll(/<dt\b[^>]*>([\s\S]*?)<\/dt>\s*<dd\b[^>]*>([\s\S]*?)<\/dd>/gi)) {
    if (labels.includes(text(match[1]).toLowerCase())) return text(match[2]);
  }
}
function money(value) {
  const match = value?.match(/€\s*([\d.]+(?:,\d{1,2})?)\s*(?:\/(?:mnd|maand|mo)|per maand)/i);
  if (!match) throw new FundaError('MONTHLY_RENT_MISSING');
  const result = Number(match[1].replace(/\./g, '').replace(',', '.'));
  if (!(result > 0 && result < 100000000)) throw new FundaError('INVALID_RENT');
  return result;
}
const MONTHS = ['januari', 'februari', 'maart', 'april', 'mei', 'juni', 'juli', 'augustus', 'september', 'oktober', 'november', 'december'];
function publicationDate(value) {
  if (!value) throw new FundaError('PUBLICATION_DATE_MISSING');
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    const parsed = new Date(value); if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  // Funda often exposes only a calendar date. Use midnight Amsterdam conservatively.
  const match = value.toLowerCase().match(/^(\d{1,2}) (\w+) (\d{4})$/);
  const iso = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const numeric = value.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  const year = Number(match?.[3] ?? iso?.[1] ?? numeric?.[3]);
  const month = match ? MONTHS.indexOf(match[2]) + 1 : Number(iso?.[2] ?? numeric?.[2]);
  const day = Number(match?.[1] ?? iso?.[3] ?? numeric?.[1]);
  const utc = new Date(Date.UTC(year, month - 1, day));
  if (!year || month < 1 || month > 12 || day < 1 || utc.getUTCMonth() !== month - 1 || utc.getUTCDate() !== day) throw new FundaError('INVALID_PUBLICATION_DATE');
  const localHour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Amsterdam', hour: '2-digit', hourCycle: 'h23' }).format(utc));
  return new Date(utc.getTime() - localHour * 3600000);
}
function distanceKm(latitude, longitude) {
  const rad = n => n * Math.PI / 180;
  const a = Math.sin(rad(latitude - FILTERS.latitude) / 2) ** 2 + Math.cos(rad(latitude))
    * Math.cos(rad(FILTERS.latitude)) * Math.sin(rad(longitude - FILTERS.longitude) / 2) ** 2;
  return 6371.0088 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
function parseDetail(html, value) {
  guardPage(html); const canonicalUrl = allowedUrl(value);
  if (!/\/(?:huis|appartement)-[^/]+\/\d+\/$/.test(new URL(canonicalUrl).pathname)) return null;
  const objects = structuredData(html);
  const status = fact(html, ['status']);
  if (/^(verhuurd|rented|onder optie|under option|verhuurd onder voorbehoud)/i.test(status ?? '')) return null;
  if (!/^(beschikbaar|available|te huur)/i.test(status ?? '')) throw new FundaError('AVAILABILITY_MISSING');
  const titleMatch = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
  const title = titleMatch ? text(titleMatch[1]) : '';
  const city = objects.find(o => typeof o.addressLocality === 'string')?.addressLocality;
  const geo = objects.find(o => o.latitude !== undefined && o.longitude !== undefined);
  const latitude = Number(geo?.latitude), longitude = Number(geo?.longitude);
  if (!title || title.length > 500 || !city || city.length > 200) throw new FundaError('DETAIL_STRUCTURE_CHANGED');
  if (geo?.latitude == null || geo?.longitude == null || geo.latitude === '' || geo.longitude === ''
    || !Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) throw new FundaError('LOCATION_MISSING');
  // Public detail pages show a numeric date under popularity even when Listed since is login-gated.
  const offeredSince = fact(html, ['aangeboden sinds', 'listed since']);
  const published = (offeredSince && !/log in|inloggen/i.test(offeredSince) ? offeredSince : undefined)
    ?? objects.find(o => o.datePosted)?.datePosted ?? objects.find(o => o.datePublished)?.datePublished
    ?? text(html).match(/\b(\d{1,2}-\d{1,2}-\d{4})\s+(?:Op Funda|On Funda)\b/i)?.[1];
  const publishedAt = publicationDate(published);
  const rentPrice = money(fact(html, ['huurprijs', 'rental price']));
  const area = fact(html, ['wonen', 'woonoppervlakte', 'living area'])?.match(/^([\d.,]+)\s*m/);
  const rooms = fact(html, ['aantal kamers', 'number of rooms'])?.match(/^(\d+)\s/);
  return { externalId: canonicalUrl.match(/\/(\d+)\/$/)[1], canonicalUrl, title, city, latitude, longitude,
    rentPrice, publishedAt, availabilityStatus: 'available',
    ...(area ? { areaM2: Number(area[1].replace(',', '.')) } : {}), ...(rooms ? { rooms: Number(rooms[1]) } : {}) };
}
function matches(item, now) {
  const age = now.getTime() - item.publishedAt.getTime();
  if (age < 0) throw new FundaError('FUTURE_PUBLICATION_DATE');
  return item.rentPrice <= FILTERS.maxRent && age <= FILTERS.maxAgeHours * 3600000
    && distanceKm(item.latitude, item.longitude) <= FILTERS.radiusKm;
}
function listingInput(item) {
  const { latitude, longitude, ...listing } = item; return listing;
}
async function fetchHtml(url, kind, signal, transport = fetch) {
  allowedUrl(url, kind);
  let response;
  try { response = await transport(url, { redirect: 'manual', signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
    headers: { 'User-Agent': 'HousingMonitorNL/0.1', Accept: 'text/html', 'Accept-Language': 'nl-NL,nl;q=0.9' } }); }
  catch { throw new FundaError('HTTP_TRANSPORT'); }
  if (response.status === 403 || response.status === 401) throw new FundaError('ACCESS_BLOCKED', true);
  if (response.status === 429) {
    const retry = response.headers.get('retry-after');
    const seconds = /^\d+$/.test(retry ?? '') ? Number(retry) : Math.ceil((Date.parse(retry ?? '') - Date.now()) / 1000);
    throw new FundaError('RATE_LIMIT', false, Number.isFinite(seconds) ? Math.min(86400, Math.max(900, seconds)) : 900);
  }
  if (response.status >= 300 && response.status < 400) throw new FundaError('UNEXPECTED_REDIRECT');
  if (!response.ok) throw new FundaError('HTTP_STATUS');
  if (!/text\/html/i.test(response.headers.get('content-type') ?? '')) throw new FundaError('CONTENT_TYPE');
  const reader = response.body?.getReader(); if (!reader) throw new FundaError('EMPTY_BODY');
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length;
      if (size > 5 * 1024 * 1024) { await reader.cancel(); throw new FundaError('BODY_TOO_LARGE'); }
      chunks.push(value);
    }
  } catch (error) { if (error instanceof FundaError) throw error; throw new FundaError('HTTP_TRANSPORT'); }
  return Buffer.concat(chunks).toString('utf8');
}
async function collect({ transport = fetch, now = new Date(), maxPages = 5, maxListings = 60,
  signal = AbortSignal.timeout(120000), pause = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  const urls = new Set(), pages = new Set(); let url = SEARCH_URL, total;
  while (url) {
    if (pages.has(url) || pages.size >= maxPages) throw new FundaError('PAGINATION_LIMIT');
    pages.add(url);
    const page = parseSearch(await fetchHtml(url, 'search', signal, transport), url);
    if (total !== undefined && page.total !== total) throw new FundaError('SEARCH_CHANGED_DURING_RUN');
    total = page.total;
    const before = urls.size;
    for (const detail of page.urls) urls.add(detail);
    if (page.urls.length && urls.size === before) throw new FundaError('PAGINATION_NOT_ADVANCING');
    if (urls.size > maxListings || total > maxListings) throw new FundaError('LISTING_LIMIT');
    // Some rendered result pages expose pagination as buttons rather than anchors.
    // Probe the next numbered page only while the explicit result count is incomplete.
    url = page.next;
    if (!url && urls.size < total) {
      const next = new URL(SEARCH_URL);
      next.searchParams.set('page', String(pages.size + 1)); url = next.href;
    }
    if (url) await pause(1000);
  }
  if (urls.size !== total) throw new FundaError('INCOMPLETE_SEARCH');
  const listings = [];
  for (const detail of urls) {
    // Rental results can include parking/storage; these are not housing.
    if (!/\/(?:huis|appartement)-[^/]+\/\d+\/$/.test(new URL(detail).pathname)) continue;
    if (signal.aborted) throw new FundaError('RUN_TIMEOUT');
    await pause(1000);
    const item = parseDetail(await fetchHtml(detail, 'detail', signal, transport), detail);
    if (item && matches(item, now)) listings.push(listingInput(item));
  }
  return { listings, inspected: urls.size, pages: pages.size };
}
module.exports = { FILTERS, SOURCE_ID, SEARCH_URL, FundaError, allowedUrl, parseSearch, parseDetail,
  publicationDate, distanceKm, matches, collect };
