'use strict';
// Run with node --import tsx. Public GETs only; no database or delivery.
const { createHash } = require('node:crypto');
const { mkdirSync, writeFileSync } = require('node:fs');
const { parseSearch, SEARCH_URL } = require('../src/sources/rentola-core.ts');

async function probe(label, target, page, revalidate = false) {
  const response = await fetch(target, { redirect: 'manual', signal: AbortSignal.timeout(20000), headers: {
    Accept: 'text/html', 'Accept-Language': 'en', ...(revalidate ? { 'Cache-Control': 'no-cache', Pragma: 'no-cache' } : {}),
  } });
  const headers = Object.fromEntries(['date', 'age', 'cache-control', 'cf-cache-status', 'x-cache', 'x-nextjs-cache', 'etag']
    .map(key => [key, response.headers.get(key)]));
  const summary = { label, page, status: response.status, headers };
  if (!response.ok) { await response.body?.cancel(); console.log(JSON.stringify(summary)); return; }
  const reader = response.body.getReader(); const chunks = []; let bytes = 0;
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    bytes += value.length;
    if (bytes > 8 * 1024 * 1024) { await reader.cancel(); throw Error('BODY_TOO_LARGE'); }
    chunks.push(value);
  }
  const html = Buffer.concat(chunks).toString('utf8');
  mkdirSync('.diagnostics/rentola', { recursive: true });
  writeFileSync(`.diagnostics/rentola/${label}.html`, html);
  // Decode data only. Log structure and identifiers, never titles/descriptions/addresses.
  const stream = [...html.matchAll(/<script\b[^>]*>self\.__next_f\.push\((\[.*?\])\)<\/script>/g)]
    .map(m => JSON.parse(m[1])).filter(x => x[0] === 1 && typeof x[1] === 'string').map(x => x[1]).join('');
  function field(name) {
    const token = JSON.stringify(name) + ':{'; const start = stream.indexOf(token) + token.length - 1;
    if (start < token.length - 1) return;
    let depth = 0, quoted = false, escaped = false;
    for (let i = start; i < stream.length; i++) {
      const c = stream[i];
      if (quoted) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') quoted = false; }
      else if (c === '"') quoted = true;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) return JSON.parse(stream.slice(start, i + 1));
    }
  }
  const search = field('searchPropertiesData');
  Object.assign(summary, { params: field('listingsParams'), meta: search?.meta,
    dataKeys: Object.keys(search || {}), ids: search?.data?.map(x => x.id),
    stateKeys: [...new Set([...stream.matchAll(/"(\w+)":/g)].map(m => m[1]))].slice(0,150) });
  try {
    const parsed = parseSearch(html, page);
    Object.assign(summary, { total: parsed.totalCount, pages: parsed.totalPages, cards: parsed.ids.length,
      idsHash: createHash('sha256').update(parsed.ids.join(',')).digest('hex') });
  } catch (error) { summary.error = error.category || 'PARSE_FAILED'; }
  console.log(JSON.stringify(summary));
  if (label === 'default-first') {
    const sources = [...html.matchAll(/<script\b[^>]*src="([^"]+)"/g)].map(m => m[1])
      .filter(x => x.startsWith('/_next/static/chunks/')).slice(0, 35);
    for (const path of sources) {
      const script = await fetch(new URL(path, SEARCH_URL), { signal: AbortSignal.timeout(10000) });
      if (!script.ok) { await script.body?.cancel(); continue; }
      const source = await script.text();
      if (source.length > 2 * 1024 * 1024) continue;
      const snippets = [...source.matchAll(/.{0,120}(?:searchPropertiesData|listingsParams|totalCount|getProperties|searchProperties|apiBaseUrl|api\/v\d).{0,160}/g)].map(m => m[0]).slice(0, 12);
      if (snippets.length) console.log(JSON.stringify({ script: path, snippets }));
    }
  }
}

async function main() {
  const second = SEARCH_URL + '&page=2';
  const probes = [
    ['default-first', SEARCH_URL, 1], ['default-second', second, 2],
    ['revalidate-first', SEARCH_URL, 1, true], ['revalidate-second', second, 2, true],
    ['explicit-first', SEARCH_URL + '&page=1', 1, true],
    ['reordered-second', 'https://rentola.nl/en/rent?page=2&location=240117&order=desc', 2, true],
    ['reordered-first', 'https://rentola.nl/en/rent?order=desc&location=240117', 1, true],
    ['default-third', SEARCH_URL + '&page=3', 3],
    ['last-thirteenth', SEARCH_URL + '&page=13', 13],
    ['last-fourteenth', SEARCH_URL + '&page=14', 14],
  ];
  for (const args of probes) { await probe(...args); await new Promise(resolve => setTimeout(resolve, 300)); }
}
main().catch(error => { console.error(error.category || 'DIAGNOSTIC_FAILED'); process.exitCode = 1; });
