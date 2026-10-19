'use strict';
// Run with node --import tsx. Public GETs only; no database or delivery.
const { createHash } = require('node:crypto');
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
  try {
    const parsed = parseSearch(Buffer.concat(chunks).toString('utf8'), page);
    Object.assign(summary, { total: parsed.totalCount, pages: parsed.totalPages, cards: parsed.ids.length,
      idsHash: createHash('sha256').update(parsed.ids.join(',')).digest('hex') });
  } catch (error) { summary.error = error.category || 'PARSE_FAILED'; }
  console.log(JSON.stringify(summary));
}

async function main() {
  const second = SEARCH_URL + '&page=2';
  const probes = [
    ['default-first', SEARCH_URL, 1], ['default-second', second, 2],
    ['revalidate-first', SEARCH_URL, 1, true], ['revalidate-second', second, 2, true],
    ['explicit-first', SEARCH_URL + '&page=1', 1, true],
    ['reordered-second', 'https://rentola.nl/en/rent?page=2&location=240117&order=desc', 2, true],
  ];
  for (const args of probes) { await probe(...args); await new Promise(resolve => setTimeout(resolve, 300)); }
}
main().catch(error => { console.error(error.category || 'DIAGNOSTIC_FAILED'); process.exitCode = 1; });
