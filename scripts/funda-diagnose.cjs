'use strict';
// Read-only Railway probe: ordinary Chromium, no stealth, proxy, login or CAPTCHA solving.
const { spawn, spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const SEARCH_URL = 'https://www.funda.nl/zoeken/huur?' + new URLSearchParams({
  selected_area: JSON.stringify(['groningen,30km']), price: JSON.stringify('-1500'), sort: JSON.stringify('date_down'),
});
const targets = [
  ['home', 'https://www.funda.nl/'],
  ['simple-search', 'https://www.funda.nl/zoeken/huur?selected_area=groningen'],
  ['configured-search', SEARCH_URL],
];
const emit = (event, data) => console.log(JSON.stringify({ probe: 'funda-railway-v2', at: new Date().toISOString(), event, ...data }));
function summarize(html) {
  const title = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1].replace(/<[^>]+>/g, ' ').trim().slice(0, 160) ?? null;
  return { title, bytes: Buffer.byteLength(html), sha256: createHash('sha256').update(html).digest('hex'),
    indicators: ['captcha', 'access denied', 'forbidden', 'verify you are human', 'cloudflare', 'cf-chl',
      'akamai', 'datadome', 'captcha-delivery', 'imperva', 'perimeterx', 'awswaf', 'robot'].filter(x => html.toLowerCase().includes(x)) };
}
function headers(responseHeaders) {
  return Object.fromEntries(['server', 'content-type', 'cf-mitigated', 'x-datadome', 'x-cache', 'via']
    .map(key => [key, responseHeaders[key] ?? null]).filter(([, value]) => value !== null));
}
async function boundedBody(response) {
  const reader = response.body.getReader(); let size = 0; const chunks = [];
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    size += value.length;
    if (size > 2 * 1024 * 1024) { await reader.cancel(); throw new Error('BODY_LIMIT'); }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}
async function main() {
  emit('start', { region: process.env.RAILWAY_REGION ?? null, node: process.version });
  for (const [target, url] of targets) {
    try {
      const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(20000), headers: {
        'User-Agent': 'HousingMonitorNL/0.1', Accept: 'text/html', 'Accept-Language': 'nl-NL,nl;q=0.9',
      } });
      emit('http', { target, status: response.status, headers: headers(Object.fromEntries(response.headers)),
        ...summarize(await boundedBody(response)) });
    } catch { emit('http-error', { target, category: 'TRANSPORT_OR_BODY_LIMIT' }); }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  // Official Playwright Docker images include browsers, but not the npm package.
  const installed = spawnSync('npm', ['install', '--prefix', '/tmp/funda-diagnostic', '--no-audit', '--no-fund',
    '--ignore-scripts', 'playwright@1.56.1'], { timeout: 120000, encoding: 'utf8' });
  if (installed.status !== 0) { emit('setup-error', { category: 'PLAYWRIGHT_PACKAGE_INSTALL', status: installed.status }); process.exitCode = 1; return; }
  const { chromium } = require('/tmp/funda-diagnostic/node_modules/playwright');
  let browser, display;
  try {
    const headless = !process.argv.includes('--headed');
    if (!headless) {
      display = spawn('Xvfb', [':99', '-screen', '0', '1365x900x24', '-nolisten', 'tcp'], { stdio: 'ignore' });
      await new Promise((resolve, reject) => {
        display.once('error', () => reject(new Error('DISPLAY_START_FAILED')));
        setTimeout(() => display.exitCode === null ? resolve() : reject(new Error('DISPLAY_EXITED')), 1000);
      });
      process.env.DISPLAY = ':99';
      emit('display-start', { pid: display.pid });
    }
    browser = await chromium.launch({ headless });
    const context = await browser.newContext({ locale: 'nl-NL', viewport: { width: 1365, height: 900 } });
    const page = await context.newPage();
    emit('browser-start', { mode: headless ? 'headless' : 'headed-xvfb', version: browser.version(), userAgent: await page.evaluate(() => navigator.userAgent) });
    for (const [target, url] of targets) {
      let navigation;
      try {
        navigation = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        // Permit normal page JavaScript to settle; do not click or solve human checks.
        await page.waitForTimeout(5000);
        const html = await page.content();
        const visible = await page.locator('body').innerText({ timeout: 5000 });
        const rentalLinks = await page.locator('a[href*="/detail/huur/"]').count();
        emit('browser', { target, status: navigation?.status() ?? null,
          finalOrigin: new URL(page.url()).origin, finalPath: new URL(page.url()).pathname,
          headers: headers(navigation ? await navigation.allHeaders() : {}), ...summarize(html),
          visibleTitle: await page.title(), rentalLinks,
          visibleSnippet: visible.replace(/\s+/g, ' ').trim().slice(0, 500),
          resultCount: visible.match(/\b([\d.,]+)\s+huurwoningen\b/i)?.[1] ?? null,
          visibleIndicators: ['captcha', 'access denied', 'verify you are human', 'forbidden', 'bevestig dat'].filter(x => visible.toLowerCase().includes(x)),
          cookieNames: (await context.cookies()).map(c => c.name).sort() });
      } catch { emit('browser-error', { target, category: 'NAVIGATION_OR_PAGE_TIMEOUT', status: navigation?.status() ?? null }); }
    }
  } catch { emit('setup-error', { category: 'CHROMIUM_LAUNCH' }); process.exitCode = 1; }
  finally { if (browser) await browser.close(); if (display?.pid) display.kill(); }
  emit('complete', {});
}
const deadline = setTimeout(() => { emit('deadline', {}); process.exit(1); }, 240000);
main().catch(() => { emit('fatal', { category: 'UNEXPECTED_PROBE_ERROR' }); process.exitCode = 1; })
  .finally(() => clearTimeout(deadline));
