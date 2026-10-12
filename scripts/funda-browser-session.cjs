'use strict';
// Persistent collector with temporary human-operated access. Never exposes cookies, state files or browser debugging ports.
const http = require('node:http');
const fs = require('node:fs/promises');
const { spawn, spawnSync } = require('node:child_process');
const { randomBytes, createCipheriv, createDecipheriv, createHmac, timingSafeEqual } = require('node:crypto');
const { collect, FundaError } = require('./funda-core.cjs');
const SEARCH_URL = 'https://www.funda.nl/zoeken/huur?' + new URLSearchParams({
  selected_area: JSON.stringify(['groningen,30km']), price: JSON.stringify('-1500'), sort: JSON.stringify('date_down'),
});
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
const emit = (event, data = {}) => console.log(JSON.stringify({ message: 'Funda browser session', event, at: new Date().toISOString(), ...data }));
function html(nonce) {
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
async function api(path,data){const response=await fetch(path,{method:data?'POST':'GET',headers:data?{'Content-Type':'application/json'}:{},body:data?JSON.stringify(data):undefined,cache:'no-store'});if(!response.ok)throw Error(response.status===401?'Открой полную ссылку доступа в браузере телефона.':'Не удалось выполнить действие. Попробуй ещё раз.');return response}
async function refresh(){if(!active||busy)return;busy=true;try{const response=await api('/api/screen');const next=URL.createObjectURL(await response.blob());$('screen').src=next;if(picture)URL.revokeObjectURL(picture);picture=next;const state=await (await api('/api/state')).json();$('status').textContent=state.humanCheck?'Funda просит проверку человека. Пройди её на экране выше.':state.listingLinks?'Доступ к объявлениям есть. Найдено ссылок: '+state.listingLinks:state.title; }catch(e){note(e.message)}finally{busy=false}}
async function action(data){try{note('Выполняю…');const result=await (await api('/api/action',data)).json();note(result.message||'Готово');await refresh()}catch(e){note(e.message)}}
async function login(key){try{await api('/api/login',{key});active=true;$('login').style.display='none';$('work').style.display='block';note('Браузер подключён');await refresh()}catch(e){note(e.message)}}
$('loginButton').addEventListener('click',()=>login($('access').value));
document.querySelectorAll('[data-target]').forEach(b=>b.addEventListener('click',()=>action({type:'navigate',target:b.dataset.target})));
document.querySelectorAll('[data-scroll]').forEach(b=>b.addEventListener('click',()=>action({type:'scroll',delta:Number(b.dataset.scroll)})));
document.querySelectorAll('[data-key]').forEach(b=>b.addEventListener('click',()=>action({type:'key',key:b.dataset.key})));
$('type').addEventListener('click',()=>action({type:'text',text:$('text').value}));$('refresh').addEventListener('click',refresh);
$('check').addEventListener('click',()=>action({type:'check'}));$('save').addEventListener('click',()=>action({type:'save'}));
$('screen').addEventListener('click',e=>{const r=$('screen').getBoundingClientRect();action({type:'click',x:(e.clientX-r.left)*1024/r.width,y:(e.clientY-r.top)*768/r.height})});
const key=new URLSearchParams(location.hash.slice(1)).get('key');history.replaceState(null,'',location.pathname);
if(key)login(key);else api('/api/state').then(()=>{active=true;$('login').style.display='none';$('work').style.display='block';refresh()}).catch(()=>{});
setInterval(refresh,1200);
</script></html>`;
}
async function main() {
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
  async function recoveryLink(){
    if(!recovery||recovery.resolved||recovery.expires<Date.now()){
      recovery={id:randomBytes(16).toString('hex'),key:randomBytes(32).toString('base64url'),expires:Date.now()+24*3600000,consumed:false,resolved:false};
      authKey=recovery.key;expires=recovery.expires;consumed=false;await saveRecovery();
    }
    return {id:recovery.id,url:origin+'/#key='+recovery.key,expiresAt:new Date(recovery.expires).toISOString()};
  }
  const installed=await fs.access('/tmp/funda-browser/node_modules/playwright/package.json').then(()=>true,()=>false);
  const install = installed?{status:0}:spawnSync('npm', ['install', '--prefix', '/tmp/funda-browser', '--no-audit', '--no-fund', '--ignore-scripts', 'playwright@1.56.1'], { timeout: 120000, encoding: 'utf8' });
  if (install.status !== 0) throw new Error('PLAYWRIGHT_SETUP');
  const display = spawn('Xvfb', [':99', '-screen', '0', '1024x768x24', '-nolisten', 'tcp'], { stdio: 'ignore' });
  await new Promise((resolve,reject)=>{display.once('error',()=>reject(new Error('DISPLAY_SETUP')));setTimeout(()=>display.exitCode===null?resolve():reject(new Error('DISPLAY_EXITED')),1000)});
  process.env.DISPLAY = ':99';
  const { chromium } = require('/tmp/funda-browser/node_modules/playwright');
  const browser = await chromium.launch({ headless: false });
  let saved;
  try { saved = decryptState(await fs.readFile(stateFile), stateKey); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('STATE_DECRYPT_FAILED'); }
  const context = await browser.newContext({ locale: 'nl-NL', viewport: { width: 1024, height: 768 }, ...(saved ? { storageState: saved } : {}) });
  let collecting=false;
  // Only Funda pages may be navigated; never offer an arbitrary URL or debugger endpoint.
  await context.route('**/*', async route => {
    const request = route.request();
    let url; try { url = new URL(request.url()); } catch { return route.abort(); }
    if (!['https:', 'http:'].includes(url.protocol)) return route.abort();
    if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[)/.test(url.hostname) || url.hostname.endsWith('.internal')) return route.abort();
    if (request.isNavigationRequest() && request.frame().parentFrame() === null
      && !['www.funda.nl','funda.nl','login.funda.nl'].includes(url.hostname)) return route.abort();
    if(collecting&&request.resourceType()==='image'&&url.hostname==='cloud.funda.nl')return route.abort();
    return route.continue();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  page.once('crash',()=>{emit('renderer-crashed');process.exit(1)});
  browser.once('disconnected',()=>{emit('browser-disconnected');process.exit(1)});
  await page.goto('https://www.funda.nl/', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(()=>{});
  await page.waitForTimeout(2000);
  await page.goto(SEARCH_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(()=>{});
  await page.waitForTimeout(2000);
  emit('browser-ready', { restored: Boolean(saved), version: browser.version(), expiresAt: new Date(expires).toISOString() });
  let chain = Promise.resolve(), queued = 0;
  function serial(task) {
    if (queued >= 15) return Promise.reject(new Error('BUSY'));
    queued++; const job = chain.catch(()=>{}).then(task);chain=job.then(()=>{},()=>{});
    return job.finally(()=>queued--);
  }
  async function inspect() {
    const title = await page.title();
    const body = await page.locator('body').innerText().catch(()=>'');
    return { title: title.slice(0,200), path: new URL(page.url()).pathname,
      humanCheck: /je bent bijna op de pagina die je zoekt|verify you are human|verifiëren dat onze bezoekers echte mensen zijn/i.test(title+' '+body),
      accessDenied: /access denied|forbidden/i.test(title+' '+body),
      listingLinks: await page.locator('a[href*="/detail/huur/"]').count() };
  }
  async function persist() {
    const state = await context.storageState({ indexedDB: true });
    await fs.writeFile(stateFile+'.tmp', encryptState(state,stateKey), { mode: 0o600 });
    await fs.rename(stateFile+'.tmp',stateFile);
  }
  let previous;
  async function report() { const state=await inspect();const encoded=JSON.stringify(state);if(encoded!==previous){emit('page-state',state);previous=encoded}return state; }
  await serial(async()=>{await persist();await report()});
  let heartbeatBusy=false;
  const heartbeat=setInterval(()=>{if(heartbeatBusy)return;heartbeatBusy=true;serial(async()=>{await persist();await report()}).catch(()=>emit('state-error')).finally(()=>heartbeatBusy=false)},30000);
  const server=http.createServer(async(req,res)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('X-Frame-Options','DENY');
    const pathname=new URL(req.url,'http://localhost').pathname;
    const send=(status,data)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(data))};

    if(req.method==='GET'&&pathname==='/health') return send(200,{status:'ready'});
    if(req.method==='GET'&&pathname==='/'){
      const nonce=randomBytes(16).toString('base64');
      res.setHeader('Content-Security-Policy',`default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src 'self' blob:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`);
      res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(html(nonce));return;
    }
    if(pathname.startsWith('/worker/')) {
      if(!equalSecret(req.headers.authorization, 'Bearer '+process.env.BROWSER_WORKER_TOKEN) || !process.env.BROWSER_WORKER_TOKEN) return send(401,{category:'WORKER_AUTH'});
      try {
        if(req.method==='GET'&&pathname==='/worker/state') return send(200,{...await serial(inspect),recovered:recovery?.resolved===true});
        if(req.method==='POST'&&pathname==='/worker/recovery') return send(200,await serial(recoveryLink));
        if(req.method==='POST'&&pathname==='/worker/collect') {
          const result=await serial(async()=>{
            collecting=true;
            try { const transport=async(url)=>{
              const response=await page.goto(url,{waitUntil:'domcontentloaded',timeout:20000});
              await page.waitForTimeout(1200);
              const content=await page.content();
              await persist();
              return new Response(content,{status:response?.status()??502,headers:{'content-type':'text/html'}});
            };
            return await collect({transport,signal:AbortSignal.timeout(300000)});
            } finally { collecting=false; }
          });
          emit('collection-complete',{inspected:result.inspected,pages:result.pages,matched:result.listings.length});
          return send(200,result);
        }
        return send(404,{category:'NOT_FOUND'});
      }catch(error){return send(422,{category:error instanceof FundaError?error.category:'BROWSER_FAILED',blocked:error instanceof FundaError&&error.blocked})}
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
          if(a.type==='navigate'||a.type==='check')await page.goto(a.target==='home'?'https://www.funda.nl/':SEARCH_URL,{waitUntil:'domcontentloaded',timeout:30000});
          if(a.type==='check')await page.waitForTimeout(3000);
          await persist();const state=await report();
          if(a.type==='save'&&recovery&&!state.humanCheck&&!state.accessDenied&&state.listingLinks>0&&new URL(page.url()).pathname==='/zoeken/huur') {recovery.resolved=true;await saveRecovery();}
          return state;
        });
        return send(200,{...state,message:a.type==='save'?'Сессия сохранена в зашифрованном виде':state.listingLinks?'Объявления доступны':state.humanCheck?'Funda просит проверку человека':'Готово'});
      }
      send(404,{message:'Not found'});
    }catch{send(400,{message:'Action failed'})}
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
      await uiPage.waitForFunction(()=>document.getElementById('screen').naturalWidth===1024,{},{timeout:10000});
      if(scriptErrors)throw new Error('UI_SCRIPT_ERROR');
      await uiContext.close();
      emit('server-ready',{unauthorizedScreen:screen.status,rejectedOrigin:rejectedOrigin.status,rejectedKey:rejectedKey.status,mobileUi:true,screenshotWidth:1024});
    } catch {emit('self-check-failed');await close()}
  });
  let closing=false;
  async function close(){if(closing)return;closing=true;clearInterval(heartbeat);server.close();await serial(persist).catch(()=>{});browser.removeAllListeners('disconnected');page.removeAllListeners('crash');await browser.close().catch(()=>{});display.kill();emit('closed');process.exit(0)}
  if(!process.env.BROWSER_WORKER_TOKEN)setTimeout(close,Math.max(1,expires-Date.now())).unref();process.on('SIGTERM',close);process.on('SIGINT',close);
}
module.exports={encryptState,decryptState,equalSecret,issueCookie,validCookie,validOrigin,validateAction,main};
if(require.main===module)main().catch(()=>{emit('startup-failed');process.exit(1)});
