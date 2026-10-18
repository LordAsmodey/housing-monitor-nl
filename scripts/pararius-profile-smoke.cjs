'use strict';
// Runs inside the Chrome image with --network none; only a loopback fixture is used.
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const http=require('node:http');
const {randomBytes}=require('node:crypto');
const {startDisplay,trackDocument,readBrowserPage}=require('./funda-browser-session.cjs');
const {launchProfile}=require('./pararius-browser-session.cjs');
(async()=>{
 const directory=await fs.mkdtemp('/tmp/pararius-profile-smoke-'),stateKey=randomBytes(32);
 const {display,name}=await startDisplay();process.env.DISPLAY=name;
 const server=http.createServer((_req,res)=>res.end('<!doctype html><title>Pararius profile fixture</title>fixture'));
 let handle;
 try {
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const url='http://127.0.0.1:'+server.address().port+'/';
  handle=await launchProfile({stateKey,directory});assert.equal(handle.restored,false);
  let page=handle.context.pages()[0];
  const snapshot=trackDocument(page);await page.goto(url);
  // The real Chrome document is read without a second network navigation.
  page.goto=()=>{throw Error('REDUNDANT_NAVIGATION')};
  const existing=await readBrowserPage(page,url,{reuseFreshSearch:true,searchUrl:url,snapshot:snapshot(),searchReady:html=>html.includes('Pararius profile fixture')});
  assert.equal(existing.status,200);assert.match(await existing.text(),/Pararius profile fixture/);
  await handle.context.addCookies([{name:'session',value:'pararius-smoke-secret',url}]);
  await page.evaluate(()=>localStorage.setItem('fixture','pararius-smoke-local'));
  const saved=await handle.context.storageState({indexedDB:true});
  await handle.close();handle=undefined;
  assert.equal((await fs.readFile(directory+'/chrome-profile.enc')).includes(Buffer.from('pararius-smoke-secret')),false);
  handle=await launchProfile({stateKey,directory,saved});assert.equal(handle.restored,true);
  page=handle.context.pages()[0];await page.goto(url);
  assert.equal((await handle.context.cookies(url)).find(c=>c.name==='session')?.value,'pararius-smoke-secret');
  assert.equal(await page.evaluate(()=>localStorage.getItem('fixture')),'pararius-smoke-local');
  await handle.close();handle=undefined;
  console.log(JSON.stringify({passed:true,engine:'patchright-chrome',profileRestored:true,cookies:true,localStorage:true,freshDocumentReuse:true}));
 } finally {await handle?.close();server.close();display.kill();await fs.rm(directory,{recursive:true,force:true});}
})().catch(()=>{console.error('PARARIUS_PROFILE_SMOKE_FAILED');process.exitCode=1});
