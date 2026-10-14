'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const { randomBytes } = require('node:crypto');
const { chromium } = require('patchright');
const { startDisplay, encryptState, decryptState } = require('./funda-browser-session.cjs');
const { createBrowserLifecycle } = require('./browser-lifecycle.cjs');
const { restoreProfile, saveProfile } = require('./browser-profile.cjs');
const { resources } = require('./browser-resources.cjs');
(async () => {
  const directory = await fs.mkdtemp('/tmp/profile-smoke-');
  const key = randomBytes(32), archive = directory + '/profile.enc', stateFile = directory + '/state.enc';
  const { display, name } = await startDisplay(); process.env.DISPLAY = name;
  const server = http.createServer((_req, res) => res.end('<!doctype html><title>Smoke</title>fixture'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + server.address().port;
  let launches = 0, idle;
  const worker = createBrowserLifecycle({ timeoutMs: 10,
    async launch() {
      const profile = await fs.mkdtemp(directory + '/chrome-');
      const restored = await restoreProfile(profile, archive, key);
      const context = await chromium.launchPersistentContext(profile, { channel: 'chrome', headless: false, viewport: null });
      try { const saved = decryptState(await fs.readFile(stateFile), key); await context.addCookies(saved.cookies); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      const page = context.pages()[0]; await page.goto(url);
      launches++; if (launches > 1) assert.equal(restored, true);
      return { context, page, profile, browser: context.browser() };
    },
    async suspend(h) {
      await fs.writeFile(stateFile, encryptState(await h.context.storageState({ indexedDB: true }), key), { mode: 0o600 });
      await h.context.close(); assert.equal(h.browser.isConnected(), false); await saveProfile(h.profile, archive, key); await fs.rm(h.profile, { recursive: true }); },
    onEvent(event) { if (event === 'browser-idle') idle?.(); },
  });
  try {
    await worker.run(async h => {
      await h.context.addCookies([{ name: 'session', value: 'smoke-secret', url }]);
      await h.page.evaluate(async () => {
        localStorage.setItem('saved', 'smoke-local');
        await new Promise((resolve, reject) => {
          const request = indexedDB.open('smoke', 1);
          request.onupgradeneeded = () => request.result.createObjectStore('state');
          request.onerror = () => reject(request.error);
          request.onsuccess = () => {
            const db = request.result, transaction = db.transaction('state', 'readwrite');
            transaction.objectStore('state').put('smoke-indexed', 'saved');
            transaction.oncomplete = () => { db.close(); resolve(); };
            transaction.onerror = () => reject(transaction.error);
          };
        });
      });
    });
    const active = await resources();
    const sleeping = new Promise(resolve => { idle = resolve; }); worker.start(); await sleeping;
    assert.equal(worker.state(), 'idle');
    let asleep = await resources();
    for (let attempt = 0; asleep.browserProcesses > 0 && attempt < 50; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 100)); asleep = await resources();
    }
    assert.equal(asleep.browserProcesses, 0);
    assert.equal((await fs.readFile(archive)).includes(Buffer.from('smoke-secret')), false);
    assert.equal((await fs.readFile(stateFile)).includes(Buffer.from('smoke-secret')), false);
    await worker.run(async h => {
      assert.equal((await h.context.cookies(url)).find(c => c.name === 'session').value, 'smoke-secret');
      assert.equal(await h.page.evaluate(() => localStorage.getItem('saved')), 'smoke-local');
      assert.equal(await h.page.evaluate(() => new Promise((resolve, reject) => {
        const request = indexedDB.open('smoke', 1);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result, read = db.transaction('state').objectStore('state').get('saved');
          read.onsuccess = () => { db.close(); resolve(read.result); };
          read.onerror = () => reject(read.error);
        };
      })), 'smoke-indexed');
    });
    await worker.close();
    console.log(JSON.stringify({ passed: true, launches, active, idle: asleep }));
  } finally { await worker.close(); server.close(); display.kill(); await fs.rm(directory, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exit(1); });
