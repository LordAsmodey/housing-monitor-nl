'use strict';
const fs = require('node:fs/promises');
const core = require('./huurwoningen-core.cjs');
const { main: browserMain } = require('./funda-browser-session.cjs');
const { searchReady } = require('./huurwoningen-browser-session.cjs');
const { restoreProfile, saveProfile } = require('./browser-profile.cjs');
const { createExperiment } = require('./huurwoningen-experiment.cjs');
function proxyOptions(env = process.env) {
  if (!env.BROWSER_PROXY_SERVER) {
    if (env.BROWSER_PROXY_USERNAME || env.BROWSER_PROXY_PASSWORD) throw Error('PROXY_CONFIGURATION');
    return undefined;
  }
  const url = new URL(env.BROWSER_PROXY_SERVER);
  if (!['http:', 'https:', 'socks5:'].includes(url.protocol) || url.username || url.password || url.pathname !== '' && url.pathname !== '/' || url.search || url.hash) throw Error('PROXY_CONFIGURATION');
  if (Boolean(env.BROWSER_PROXY_USERNAME) !== Boolean(env.BROWSER_PROXY_PASSWORD)) throw Error('PROXY_CONFIGURATION');
  return { server: url.origin === 'null' ? env.BROWSER_PROXY_SERVER : url.origin,
    ...(env.BROWSER_PROXY_USERNAME ? { username: env.BROWSER_PROXY_USERNAME, password: env.BROWSER_PROXY_PASSWORD } : {}) };
}
async function main() {
  const release = (await fs.readFile('/app/REVISION', 'utf8')).trim();
  if (!/^[a-f0-9]{40}$/.test(release)) throw Error('RELEASE_INVALID');
  return browserMain({ core, name: 'Huurwoningen · эксперимент', engine: 'patchright-chrome', release,
    homeUrl: 'https://www.huurwoningen.com/', navigationDomains: ['www.huurwoningen.com', 'huurwoningen.com'],
    listingSelector: 'a[href^="/huren/"]', searchReady, navigationTimeout: 30000, collectionSettleMs: 5000,
    logProgress: true, blockThirdPartyDuringCollection: false, experiment: createExperiment(),
    async launchBrowser({ stateKey, directory, saved }) {
      const profile = await fs.mkdtemp('/tmp/huur-chrome-'), archiveFile = directory + '/chrome-profile.enc';
      const restored = await restoreProfile(profile, archiveFile, stateKey);
      const { chromium } = require('patchright');
      const context = await chromium.launchPersistentContext(profile, { channel: 'chrome', headless: false, viewport: null,
        args: ['--window-size=1024,768'], proxy: proxyOptions() });
      if (!restored && saved?.cookies) await context.addCookies(saved.cookies);
      return { browser: context.browser(), context, restored, async close() {
        await context.close(); await saveProfile(profile, archiveFile, stateKey); await fs.rm(profile, { recursive: true, force: true });
      } };
    },
  });
}
module.exports = { main, proxyOptions };
if (require.main === module) main().catch(() => { console.log('PATCHRIGHT_BROWSER_STARTUP_FAILED'); process.exit(1); });
