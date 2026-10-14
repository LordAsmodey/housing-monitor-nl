'use strict';
// Persistent collector with temporary human-operated access. Never exposes cookies, state files or browser debugging ports.
const http = require('node:http');
const fs = require('node:fs/promises');
const { spawn, spawnSync } = require('node:child_process');
const { randomBytes, createCipheriv, createDecipheriv, createHmac, timingSafeEqual } = require('node:crypto');
const defaultCore = require('./funda-core.cjs');
function encryptState(state, key) {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(state), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]);
}
function decryptState(data, key) {
  const decipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12));
  decipher.setAuthTag(data.subarray(12, 28));
  return JSON.parse(Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8'));
}
function equalSecret(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
function issueCookie(key, expires) {
  const payload = Buffer.from(JSON.stringify({ expires, nonce: randomBytes(16).toString('hex') })).toString('base64url');
  return payload + '.' + createHmac('sha256', key).update(payload).digest('base64url');
}
function validCookie(value, key, now = Date.now()) {
  if (typeof value !== 'string' || value.length > 500) return false;
  const parts = value.split('.'); if (parts.length !== 2) return false;
  if (!equalSecret(parts[1], createHmac('sha256', key).update(parts[0]).digest('base64url'))) return false;
  try { return JSON.parse(Buffer.from(parts[0], 'base64url')).expires > now; } catch { return false; }
}
function validOrigin(origin, expected) { return typeof origin === 'string' && origin === expected; }
function validateAction(action) {
  if (!action || typeof action !== 'object') throw new Error('INVALID_ACTION');
  if (action.type === 'click' && Number.isFinite(action.x) && Number.isFinite(action.y)
    && action.x >= 0 && action.x <= 1024 && action.y >= 0 && action.y <= 768) return action;
  if (action.type === 'text' && typeof action.text === 'string' && action.text.length <= 2000) return action;
  if (action.type === 'key' && ['Enter', 'Tab', 'Backspace', 'Escape', 'ArrowDown', 'ArrowUp', 'Control+a'].includes(action.key)) return action;
  if (action.type === 'scroll' && [-500, 500].includes(action.delta)) return action;
  if (action.type === 'navigate' && ['home', 'search'].includes(action.target)) return action;
  if (action.type === 'check' || action.type === 'save') return action;
  throw new Error('INVALID_ACTION');
}
// Navigation requests can arrive before Playwright creates their frame.
// Restrict unknown frames to the source or the Cloudflare challenge endpoint.
async function routeRequest(route, { navigationDomains, collecting = false, blockThirdPartyDuringCollection = false }, onError = () => {}) {
  try {
    const request = route.request();
    let url; try { url = new URL(request.url()); } catch { return await route.abort(); }
    if (!['https:', 'http:'].includes(url.protocol)) return await route.abort();
    if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[)/.test(url.hostname) || url.hostname.endsWith('.internal')) return await route.abort();
    if (request.isNavigationRequest() && !navigationDomains.includes(url.hostname)) {
      let frame;
      try { frame = request.frame(); } catch { /* frame not created yet */ }
      const challenge = url.protocol === 'https:' && url.hostname === 'challenges.cloudflare.com'
        && !url.port && url.pathname.startsWith('/cdn-cgi/challenge-platform/');
      if (frame ? frame.parentFrame() === null : !challenge) return await route.abort();
    }
    if (collecting && request.resourceType() === 'image' && (blockThirdPartyDuringCollection || url.hostname === 'cloud.funda.nl')) return await route.abort();
    if (collecting && blockThirdPartyDuringCollection && !navigationDomains.includes(url.hostname)
      && url.hostname !== 'challenges.cloudflare.com' && ['script', 'stylesheet', 'media', 'font'].includes(request.resourceType())) return await route.abort();
    await route.continue();
  } catch {
    onError();
    await route.abort().catch(() => {});
  }
}
function humanCheck(title, body, content = '') {
  return /je bent bijna op de pagina die je zoekt|verify you are human|verifiëren dat onze bezoekers echte mensen zijn|even geduld\s*\.{0,3}|just a moment|verifieer.{0,30}mens|bevestig.{0,30}mens/i.test(title + ' ' + body)
    || /id=["']challenge-form["']|window\._cf_chl_opt\s*=/.test(content);
}
function shouldRenewRecovery(recovery, now = Date.now(), renew = false) {
  return !recovery || recovery.resolved || recovery.expires <= now || renew;
}
function recoveryReady(state, url, searchPath) {
  return !state.humanCheck && !state.accessDenied && (state.searchReady ?? state.listingLinks > 0)
    && new URL(url).pathname === searchPath;
}
// Let Xvfb allocate a free display instead of failing on an orphaned :99 lock.
async function startDisplay(spawnProcess = spawn) {
  const display = spawnProcess('Xvfb', ['-displayfd', '1', '-screen', '0', '1024x768x24', '-nolisten', 'tcp'], { stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    const number = await new Promise((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => finish(new Error('DISPLAY_TIMEOUT')), 10000);
      const onError = () => finish(new Error('DISPLAY_SETUP'));
      const onExit = () => finish(new Error('DISPLAY_EXITED'));
      const onData = chunk => {
        output += chunk.toString();
        if (/^\d+\n/.test(output)) finish(null, output.trim());
        else if (output.length > 20 || output.includes('\n')) finish(new Error('DISPLAY_SETUP'));
      };
      function finish(error, value) {
        clearTimeout(timer); display.off('error', onError); display.off('exit', onExit); display.stdout.off('data', onData);
        if (error) reject(error); else resolve(value);
      }
      display.once('error', onError); display.once('exit', onExit); display.stdout.on('data', onData);
    });
    return { display, name: ':' + number };
  } catch (error) { display.kill(); throw error; }
}
let browserName = 'Funda';
const emit = (event, data = {}) => console.log(JSON.stringify({ message: browserName + ' browser session', event, at: new Date().toISOString(), ...data }));
function html(nonce, name = 'Funda') {
  return `<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Браузер Funda</title><style nonce="${nonce}">
body{margin:0;background:#f3f5f7;color:#17212b;font:16px system-ui}main{max-width:1040px;margin:auto;padding:12px}h1{font-size:22px;margin:8px 0}p{line-height:1.4}button,input{font:inherit;padding:11px;border:1px solid #b8c6d2;border-radius:8px;background:white}button{cursor:pointer}button:disabled{opacity:.5}.row{display:flex;gap:6px;flex-wrap:wrap;margin:9px 0}input{flex:1;min-width:120px}#screen{width:100%;display:block;border:1px solid #b8c6d2;background:white;touch-action:pan-y pinch-zoom}#status{font-size:14px}#work{display:none}#note{min-height:20px;color:#25556a}.tip{font-size:14px;color:#435563}
</style><main><h1>Браузер Funda в Railway</h1><p>Нажимай на изображение страницы, чтобы управлять браузером. Пройди проверку Funda вручную.</p>
<div id="login"><input id="access" type="password" autocomplete="off" placeholder="Код доступа"><button id="loginButton">Открыть</button></div>
<div id="work"><div class="row"><button data-target="search">Поиск жилья</button><button data-target="home">Главная Funda</button><button id="refresh">Обновить экран</button></div>
<p class="tip">Если элементы мелкие, увеличь страницу двумя пальцами. Для прокрутки браузера используй кнопки ниже.</p>
<img id="screen" alt="Экран удалённого браузера"><div class="row"><button data-scroll="-500">↑ Выше</button><button data-scroll="500">↓ Ниже</button><button data-key="Tab">Tab</button><button data-key="Enter">Enter</button><button data-key="Backspace">⌫</button></div>
<div class="row"><input id="text" autocomplete="off" placeholder="Текст для выбранного поля"><button id="type">Ввести</button></div>
<div class="row"><button id="check">Проверить поиск</button><button id="save">Сохранить сессию</button></div><p id="status"></p></div><p id="note"></p></main>
<script nonce="${nonce}">
const $=id=>document.getElementById(id);let active=false,busy=false,picture;
function note(s){$('note').textContent=s}
async function api(path,data){const response=await fetch(path,{method:data?'POST':'GET',headers:data?{'Content-Type':'application/json'}:{},body:data?JSON.stringify(data):undefined,cache:'no-store'});if(!response.ok){const detail=await response.json().catch(()=>({}));throw Error(detail.message|| (response.status===401?'Открой полную ссылку доступа в браузере телефона.':'Не удалось выполнить действие. Попробуй ещё раз.'));}return response}
async function refresh(){if(!active||busy)return;busy=true;try{const response=await api('/api/screen');const next=URL.createObjectURL(await response.blob());$('screen').src=next;if(picture)URL.revokeObjectURL(picture);picture=next;const state=await (await api('/api/state')).json();$('status').textContent=state.humanCheck?'Funda просит проверку человека. Пройди её на экране выше.':state.listingLinks?'Доступ к объявлениям есть. Найдено ссылок: '+state.listingLinks:state.title;$('save').disabled=state.humanCheck||state.accessDenied||!(state.searchReady??state.listingLinks>0); }catch(e){note(e.message)}finally{busy=false}}
async function action(data){try{note('Выполняю…');const result=await (await api('/api/action',data)).json();note(result.message||'Готово');await refresh()}catch(e){note(e.message)}}
async function login(key){try{await api('/api/login',{key});active=true;$('login').style.display='none';$('work').style.display='block';note('Браузер подключён');await refresh()}catch(e){note(e.message)}}
$('loginButton').addEventListener('click',()=>login($('access').value));
document.querySelectorAll('[data-target]').forEach(b=>b.addEventListener('click',()=>action({type:'navigate',target:b.dataset.target})));
document.querySelectorAll('[data-scroll]').forEach(b=>b.addEventListener('click',()=>action({type:'scroll',delta:Number(b.dataset.scroll)})));
document.querySelectorAll('[data-key]').forEach(b=>b.addEventListener('click',()=>action({type:'key',key:b.dataset.key})));
$('type').addEventListener('click',()=>action({type:'text',text:$('text').value}));$('refresh').addEventListener('click',refresh);
$('check').addEventListener('click',()=>action({type:'check'}));$('save').addEventListener('click',()=>action({type:'save'}));
$('screen').addEventListener('click',e=>{const r=$('screen').getBoundingClientRect();action({type:'click',x:(e.clientX-r.left)*$('screen').naturalWidth/r.width,y:(e.clientY-r.top)*$('screen').naturalHeight/r.height})});
const key=new URLSearchParams(location.hash.slice(1)).get('key');history.replaceState(null,'',location.pathname);
if(key)login(key);else api('/api/state').then(()=>{active=true;$('login').style.display='none';$('work').style.display='block';refresh()}).catch(()=>{});
setInterval(refresh,1200);
</script></html>`.replaceAll('Funda', name);
}
async function main(options = {}) {
  const { collect, FundaError, SEARCH_URL } = options.core ?? defaultCore;
  const { createBrowserLifecycle, idleTimeout } = require('./browser-lifecycle.cjs');
  const { resources } = require('./browser-resources.cjs');
  const timeoutMs = idleTimeout();
  if (timeoutMs && options.experiment) throw Error('EXPERIMENT_IDLE_UNSUPPORTED');
  const name = options.name ?? 'Funda';
  browserName = name;
  const homeUrl = options.homeUrl ?? 'https://www.funda.nl/';
  const navigationDomains = options.navigationDomains ?? ['www.funda.nl','funda.nl','login.funda.nl'];
  const listingSelector = options.listingSelector ?? 'a[href*="/detail/huur/"]';
  const searchPath = new URL(SEARCH_URL).pathname;
  let authKey = process.env.BROWSER_ACCESS_KEY;
  const stateKey = Buffer.from(process.env.BROWSER_STATE_KEY_HEX ?? '', 'hex');
  let expires = Date.parse(process.env.BROWSER_ACCESS_EXPIRES_AT ?? '');
  const origin = process.env.BROWSER_PUBLIC_ORIGIN;
  if (!authKey || authKey.length < 32 || stateKey.length !== 32 || !Number.isFinite(expires) || !/^https:\/\//.test(origin ?? '')) throw new Error('SESSION_CONFIGURATION');
  const directory = '/data', stateFile = directory + '/browser-state.enc', consumedFile = directory + '/link-consumed';
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  let consumed = await fs.access(consumedFile).then(()=>true,()=>false);
  const recoveryFile=directory+'/recovery.enc';
  let recovery=null;
  try { recovery=decryptState(await fs.readFile(recoveryFile),stateKey); } catch(error){if(error.code!=='ENOENT')throw Error('RECOVERY_DECRYPT_FAILED')}
  if(recovery){authKey=recovery.key;expires=recovery.expires;consumed=recovery.consumed}
  async function saveRecovery(){await fs.writeFile(recoveryFile+'.tmp',encryptState(recovery,stateKey),{mode:0o600});await fs.rename(recoveryFile+'.tmp',recoveryFile)}
  async function recoveryLink(renew = false){
    if(shouldRenewRecovery(recovery, Date.now(), renew)){
      recovery={id:renew&&recovery&&!recovery.resolved?recovery.id:randomBytes(16).toString('hex'),key:randomBytes(32).toString('base64url'),expires:Date.now()+24*3600000,consumed:false,resolved:false};
      authKey=recovery.key;expires=recovery.expires;consumed=false;await saveRecovery();
    }
    return {id:recovery.id,url:origin+'/#key='+recovery.key,expiresAt:new Date(recovery.expires).toISOString()};
  }
  if (!options.launchBrowser) {
  const installed=await fs.access('/tmp/funda-browser/node_modules/playwright/package.json').then(()=>true,()=>false);
  const install = installed?{status:0}:spawnSync('npm', ['install', '--prefix', '/tmp/funda-browser', '--no-audit', '--no-fund', '--ignore-scripts', 'playwright@1.56.1'], { timeout: 120000, encoding: 'utf8' });
  if (install.status !== 0) throw new Error('PLAYWRIGHT_SETUP');
  }
  const { display, name: displayName } = await startDisplay();
  process.once('exit', () => display.kill());
  process.env.DISPLAY = displayName;
  let saved;
  try { saved = decryptState(await fs.readFile(stateFile), stateKey); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('STATE_DECRYPT_FAILED'); }
  let launched, browser, context, page, profileRestored = Boolean(saved);
  let collecting=false;
  async function launch() {
    if (options.launchBrowser) launched = await options.launchBrowser({ saved, stateKey, directory });
    else {
      const { chromium } = require('/tmp/funda-browser/node_modules/playwright');
      const instance = await chromium.launch({ headless: false });
      try {
        launched = { browser: instance, context: await instance.newContext({ locale: 'nl-NL', viewport: { width: 1024, height: 768 }, ...(saved ? { storageState: saved } : {}) }) };
      } catch (error) { await instance.close(); throw error; }
    }
    ({ browser, context } = launched);
    try {
      await context.route('**/*', route => routeRequest(route, { navigationDomains, collecting,
        blockThirdPartyDuringCollection: options.blockThirdPartyDuringCollection }, () => emit('route-error')));
      page = context.pages()[0] ?? await context.newPage();
      for (const extra of context.pages()) if (extra !== page) await extra.close();
      page.setDefaultTimeout(10000);
      page.once('crash',onCrash);
      browser.once('disconnected',onDisconnect);
      await page.goto(homeUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(()=>{});
      await page.waitForTimeout(2000);
      await page.goto(SEARCH_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(()=>{});
      await page.waitForTimeout(2000);
      profileRestored = launched.restored ?? Boolean(saved);
      emit('browser-ready', { restored: profileRestored, engine: options.engine ?? 'playwright', release: options.release ?? 'legacy', version: browser.version(), expiresAt: new Date(expires).toISOString() });
      return launched;
    } catch (error) {
      browser.removeListener('disconnected',onDisconnect); page?.removeListener('crash',onCrash);
      await (launched.close ? launched.close() : browser.close()); throw error;
    }
  }
  function onCrash(){emit('renderer-crashed');process.exit(1)}
  function onDisconnect(){emit('browser-disconnected');process.exit(1)}
  const lifecycle = createBrowserLifecycle({ launch, timeoutMs,
    async suspend(handle) {
      if (!handle.statePersisted) { await persist(); handle.statePersisted = true; }
      handle.browser.removeListener('disconnected',onDisconnect); page.removeListener('crash',onCrash);
      await (handle.close ? handle.close() : handle.browser.close());
    },
    onEvent(event) { emit(event); if(event === 'browser-idle') resources().then(data=>emit('browser-resources',data)).catch(()=>{}); },
  });
  const serial = task => lifecycle.run(task);
  async function inspect() {
    const title = await page.title();
    const body = await page.locator('body').innerText().catch(()=>'');
    const content = await page.content();
    return { title: title.slice(0,200), path: new URL(page.url()).pathname,
      humanCheck: humanCheck(title, body, content),
      accessDenied: /access denied|forbidden/i.test(title+' '+body),
      listingLinks: await page.locator(listingSelector).count(),
      ...(options.searchReady ? {searchReady: await options.searchReady(content, page.url())} : {}) };
  }
  async function persist() {
    const state = await context.storageState({ indexedDB: true });
    await fs.writeFile(stateFile+'.tmp', encryptState(state,stateKey), { mode: 0o600 });
    await fs.rename(stateFile+'.tmp',stateFile);
    saved = state;
  }
  let previous;
  async function report() { const state=await inspect();const encoded=JSON.stringify(state);if(encoded!==previous){emit('page-state',state);previous=encoded}return state; }
  await serial(async()=>{await persist();await report()});
  let heartbeatBusy=false;
  const heartbeat=setInterval(()=>{if(heartbeatBusy)return;heartbeatBusy=true;lifecycle.maintenance(async()=>{await persist();await report()}).catch(()=>emit('state-error')).finally(()=>heartbeatBusy=false)},30000);
  async function collectSearch() {
    collecting = true;
    const started = Date.now();
    emit('collection-resources-start',await resources());
    try {
      const transport = async url => {
        const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: options.navigationTimeout ?? 20000 });
        await page.waitForTimeout(options.collectionSettleMs ?? 1200);
        const content = await page.content();
        await persist();
        return new Response(content, { status: response?.status() ?? 502, headers: { 'content-type': 'text/html' } });
      };
      return await collect({ transport, signal: AbortSignal.timeout(300000),
        ...(options.logProgress ? { onPage: stats => emit('collection-page', stats) } : {}) });
    } finally { collecting = false; emit('collection-resources-end',{durationMs:Date.now()-started,...await resources()}); }
  }
  const server=http.createServer(async(req,res)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('X-Frame-Options','DENY');
    const pathname=new URL(req.url,'http://localhost').pathname;
    const send=(status,data)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(data))};

    if(req.method==='GET'&&pathname==='/health') return send(lifecycle.state()==='failed'?503:200,{status:lifecycle.state()==='failed'?'failed':'ready',engine:options.engine??'playwright',release:options.release??'legacy',profileRestored,browserState:lifecycle.state(),idleTimeoutSeconds:timeoutMs/1000});
    if(req.method==='GET'&&pathname==='/'){
      const nonce=randomBytes(16).toString('base64');
      res.setHeader('Content-Security-Policy',`default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src 'self' blob:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`);
      res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(html(nonce, name));return;
    }
    if(pathname.startsWith('/worker/')) {
      if(!equalSecret(req.headers.authorization, 'Bearer '+process.env.BROWSER_WORKER_TOKEN) || !process.env.BROWSER_WORKER_TOKEN) return send(401,{category:'WORKER_AUTH'});
      try {
        if(options.experiment && req.method==='GET'&&pathname==='/worker/experiment') return send(200,options.experiment.state());
        if(options.experiment && req.method==='POST'&&pathname==='/worker/experiment/start') {await options.experiment.start();return send(200,options.experiment.state());}
        if(req.method==='GET'&&pathname==='/worker/state') return send(200,{...await serial(inspect),recovered:recovery?.resolved===true});
        if(req.method==='POST'&&pathname==='/worker/recovery') return send(200,await serial(recoveryLink));
        if(req.method==='POST'&&pathname==='/worker/recovery/renew') return send(200,await serial(()=>recoveryLink(true)));
        if(req.method==='POST'&&pathname==='/worker/collect') {
          const result=await serial(collectSearch);
          emit('collection-complete',{inspected:result.inspected,pages:result.pages,matched:result.listings.length});
          return send(200,result);
        }
        return send(404,{category:'NOT_FOUND'});
      }catch(error){
        if(options.logProgress&&error instanceof FundaError&&error.diagnostic)emit('collection-validation-failed',{category:error.category,...error.diagnostic});
        return send(422,{category:error instanceof FundaError?error.category:'BROWSER_FAILED',blocked:error instanceof FundaError&&error.blocked})
      }
    }
    if(req.method==='POST'&&!validOrigin(req.headers.origin,origin)) return send(403,{message:'Origin rejected'});
    let body;
    if(req.method==='POST'){
      try{let size=0,chunks=[];for await(const chunk of req){size+=chunk.length;if(size>8192)throw Error();chunks.push(chunk)}body=JSON.parse(Buffer.concat(chunks).toString())}catch{return send(400,{message:'Invalid input'})}
    }
    if(req.method==='POST'&&pathname==='/api/login'){
      if(Date.now()>=expires||consumed||!equalSecret(body?.key,authKey)) return send(401,{message:'Access denied'});
      consumed=true;if(recovery){recovery.consumed=true;await saveRecovery()}await fs.writeFile(consumedFile,'1',{mode:0o600});
      const cookie=issueCookie(authKey,expires);
      res.setHeader('Set-Cookie',`funda_session=${cookie}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${Math.floor((expires-Date.now())/1000)}`);
      emit('human-connected');return send(200,{ok:true});
    }
    const cookie=(req.headers.cookie??'').split(';').map(v=>v.trim()).find(v=>v.startsWith('funda_session='))?.slice(14);
    if(!validCookie(cookie,authKey)) return send(401,{message:'Access denied'});
    try{
      if(req.method==='GET'&&pathname==='/api/state')return send(200,await serial(inspect));
      if(req.method==='GET'&&pathname==='/api/screen'){
        const image=await serial(()=>page.screenshot({type:'jpeg',quality:78}));res.writeHead(200,{'Content-Type':'image/jpeg'});res.end(image);return;
      }
      if(req.method==='POST'&&pathname==='/api/action'){
        const a=validateAction(body);
        const state=await serial(async()=>{
          if(a.type==='click')await page.mouse.click(a.x,a.y);
          if(a.type==='text')await page.keyboard.insertText(a.text);
          if(a.type==='key')await page.keyboard.press(a.key);
          if(a.type==='scroll')await page.mouse.wheel(0,a.delta);
          if(a.type==='navigate'||a.type==='check')await page.goto(a.target==='home'?homeUrl:SEARCH_URL,{waitUntil:'domcontentloaded',timeout:30000});
          if(a.type==='check')await page.waitForTimeout(3000);
          await persist();const state=await report();
          if(a.type==='save') {
            if(!recoveryReady(state,page.url(),searchPath)) throw new Error('SEARCH_NOT_READY');
            if(recovery){recovery.resolved=true;await saveRecovery();}
            if(options.experiment) setImmediate(()=>options.experiment.start().catch(()=>emit('experiment-error')));
          }
          return state;
        });
        return send(200,{...state,message:a.type==='save'?'Сессия сохранена в зашифрованном виде':state.listingLinks?'Объявления доступны':state.humanCheck?name+' просит проверку человека':'Готово'});
      }
      send(404,{message:'Not found'});
    }catch(error){send(error.message==='SEARCH_NOT_READY'?409:400,{message:error.message==='SEARCH_NOT_READY'?'Проверка ещё не пройдена. Открой поиск и дождись доступной выдачи.':'Не удалось выполнить действие. Попробуй ещё раз.'})}
  });
  server.headersTimeout=10000;server.requestTimeout=30000;
  server.on('clientError',(_e,socket)=>socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'));
  const port=Number(process.env.PORT??8080);
  server.listen(port,'0.0.0.0',async()=>{
    try {
      const base='http://127.0.0.1:'+port;
      const screen=await fetch(base+'/api/screen');
      const rejectedOrigin=await fetch(base+'/api/action',{method:'POST',headers:{Origin:'https://example.invalid','Content-Type':'application/json'},body:JSON.stringify({type:'check'})});
      const rejectedKey=await fetch(base+'/api/login',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({key:'invalid-key'})});
      if(screen.status!==401||rejectedOrigin.status!==403||rejectedKey.status!==401)throw new Error('AUTH_SELF_CHECK');
      const uiContext=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
      const uiPage=await uiContext.newPage();let scriptErrors=0;
      uiPage.on('pageerror',()=>scriptErrors++);
      await uiContext.addCookies([{name:'funda_session',value:issueCookie(authKey,Date.now()+60000),url:base,httpOnly:true,sameSite:'Strict'}]);
      await uiPage.goto(base,{waitUntil:'domcontentloaded',timeout:10000});
      await uiPage.waitForFunction(()=>document.getElementById('work').style.display==='block',{},{timeout:10000});
      await uiPage.waitForFunction(()=>document.getElementById('screen').naturalWidth>0,{},{timeout:10000});
      if(scriptErrors)throw new Error('UI_SCRIPT_ERROR');
      const screenshotWidth=await uiPage.locator('#screen').evaluate(img=>img.naturalWidth);
      await uiContext.close();
      emit('server-ready',{unauthorizedScreen:screen.status,rejectedOrigin:rejectedOrigin.status,rejectedKey:rejectedKey.status,mobileUi:true,screenshotWidth});
      lifecycle.start();
      if(options.experiment) await options.experiment.init({collect:()=>serial(collectSearch),profileRestored:launched.restored});
    } catch {emit('self-check-failed');await close()}
  });
  let closing=false;
  async function close(){if(closing)return;closing=true;clearInterval(heartbeat);options.experiment?.stop();server.close();await lifecycle.close().catch(()=>emit('profile-save-failed'));display.kill();emit('closed');process.exit(0)}
  if(!process.env.BROWSER_WORKER_TOKEN)setTimeout(close,Math.max(1,expires-Date.now())).unref();process.on('SIGTERM',close);process.on('SIGINT',close);
}
module.exports={shouldRenewRecovery,routeRequest,humanCheck,recoveryReady,startDisplay,encryptState,decryptState,equalSecret,issueCookie,validCookie,validOrigin,validateAction,main};
if(require.main===module)main().catch(()=>{emit('startup-failed');process.exit(1)});

