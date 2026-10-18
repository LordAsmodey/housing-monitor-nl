import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {randomBytes} from 'node:crypto';
const require=createRequire(import.meta.url);
const {encryptState,decryptState,equalSecret,issueCookie,validCookie,validOrigin,validateAction}=require('../scripts/funda-browser-session.cjs');

test('browser state is authenticated-encrypted; wrong key and tampering cannot restore cookies',()=>{
  const key=randomBytes(32),state={cookies:[{name:'session',value:'private-cookie'}],origins:[]};
  const encrypted=encryptState(state,key);
  assert.equal(encrypted.includes(Buffer.from('private-cookie')),false);
  assert.deepEqual(decryptState(encrypted,key),state);
  assert.throws(()=>decryptState(encrypted,randomBytes(32)));
  const corrupted=Buffer.from(encrypted);corrupted[corrupted.length-1]^=1;
  assert.throws(()=>decryptState(corrupted,key));
  assert.throws(()=>decryptState(Buffer.alloc(5),key));
});
test('session cookies reject forgery, expired sessions and another access key',()=>{
  const key=randomBytes(32).toString('hex'),now=Date.now();
  const cookie=issueCookie(key,now+60000);
  assert.equal(validCookie(cookie,key,now),true);
  assert.equal(validCookie(cookie,key,now+61000),false);
  assert.equal(validCookie(cookie,'wrong-key',now),false);
  assert.equal(validCookie(cookie+'.extra',key,now),false);
  assert.equal(validCookie('bad',key,now),false);
});
test('access key and origin checks reject missing keys and foreign origins',()=>{
  assert.equal(equalSecret(undefined,'secret'),false);
  assert.equal(equalSecret('secret','secret'),true);
  assert.equal(equalSecret('secrex','secret'),false);
  assert.equal(validOrigin('https://browser.example','https://browser.example'),true);
  assert.equal(validOrigin(undefined,'https://browser.example'),false);
  assert.equal(validOrigin('https://browser.example.evil.test','https://browser.example'),false);
});
test('browser actions are bounded and cannot supply navigation URLs or arbitrary commands',()=>{
  assert.deepEqual(validateAction({type:'click',x:500,y:300}),{type:'click',x:500,y:300});
  for(const action of [{type:'click',x:-1,y:0},{type:'click',x:0,y:1000},{type:'click',x:NaN,y:5},
    {type:'navigate',target:'http://localhost'},{type:'evaluate',script:'process.env'},
    {type:'key',key:'F12'},{type:'text',text:'a'.repeat(2001)},{type:'scroll',delta:99999}])assert.throws(()=>validateAction(action));
});

const {routeRequest,humanCheck,recoveryReady,startDisplay}=require('../scripts/funda-browser-session.cjs');
function routeFixture(url,{navigation=true,frame='missing',type='document',failContinue=false}={}) {
  const calls=[];
  return {calls,route:{request:()=>({url:()=>url,isNavigationRequest:()=>navigation,resourceType:()=>type,
    frame:()=>{if(frame==='missing')throw Error('Frame for this navigation request is not available');return {parentFrame:()=>frame==='main'?null:{}}}}),
    abort:async()=>{calls.push('abort')},continue:async()=>{calls.push('continue');if(failContinue)throw Error('Target closed')}}};
}
const policy={navigationDomains:['www.huurwoningen.com','huurwoningen.com']};
test('early source and Cloudflare iframe navigations survive unavailable frames; other targets fail closed',async()=>{
  for(const [url,expected] of [
    ['https://www.huurwoningen.com/in/groningen/','continue'],
    ['https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/g/turnstile/if/abc','continue'],
    ['https://example.com/','abort'],['http://127.0.0.1/','abort'],
    ['https://challenges.cloudflare.com/other','abort'],['http://challenges.cloudflare.com/cdn-cgi/challenge-platform/','abort'],
  ]){const {route,calls}=routeFixture(url);await routeRequest(route,policy);assert.deepEqual(calls,[expected],url)}
  const {route,calls}=routeFixture('https://challenges.cloudflare.com/cdn-cgi/challenge-platform/',{frame:'main'});
  await routeRequest(route,policy);assert.deepEqual(calls,['abort']);
});
test('third party assets remain bounded during collection and closed routes cannot reject the handler',async()=>{
  for(const [url,type,expected] of [
    ['https://www.huurwoningen.com/photo.jpg','image','abort'],
    ['https://ads.example/script.js','script','abort'],
    ['https://challenges.cloudflare.com/turnstile/v0/api.js','script','continue'],
  ]){const {route,calls}=routeFixture(url,{navigation:false,type});await routeRequest(route,{...policy,collecting:true,blockThirdPartyDuringCollection:true});assert.deepEqual(calls,[expected])}
  const {route,calls}=routeFixture('https://www.huurwoningen.com/',{failContinue:true});let errors=0;
  await routeRequest(route,policy,()=>errors++);assert.equal(errors,1);assert.deepEqual(calls,['continue','abort']);
  await assert.doesNotReject(routeRequest({request:()=>{throw Error('closed')},abort:async()=>{throw Error('closed')}},policy));
});
test('Dutch Cloudflare pages cannot be mistaken for saved recovery, including stale listing links',()=>{
  assert.equal(humanCheck('Even geduld...',''),true);
  assert.equal(humanCheck('Just a moment...',''),true);
  assert.equal(humanCheck('','', '<script>window._cf_chl_opt = {};</script>'),true);
  assert.equal(humanCheck('Huurwoningen','Groningen'),false);
  const state={humanCheck:false,accessDenied:false,searchReady:true,listingLinks:0};
  assert.equal(recoveryReady(state,'https://www.huurwoningen.com/in/groningen/','/in/groningen/'),true);
  assert.equal(recoveryReady({...state,humanCheck:true,listingLinks:5},'https://www.huurwoningen.com/in/groningen/','/in/groningen/'),false);
  assert.equal(recoveryReady({...state,searchReady:false},'https://www.huurwoningen.com/in/groningen/','/in/groningen/'),false);
  assert.equal(recoveryReady(state,'https://www.huurwoningen.com/','/in/groningen/'),false);
});
test('Xvfb allocates a fresh display and startup failure cleans up its child',async()=>{
  const {EventEmitter}=await import('node:events');
  function child(){const process=new EventEmitter();process.stdout=new EventEmitter();process.killed=false;process.kill=()=>{process.killed=true};return process}
  const ready=child();
  const result=await startDisplay((name,args)=>{assert.equal(name,'Xvfb');assert.deepEqual(args.slice(0,2),['-displayfd','1']);queueMicrotask(()=>ready.stdout.emit('data',Buffer.from('101\n')));return ready});
  assert.equal(result.name,':101');assert.equal(result.display,ready);
  const failed=child();await assert.rejects(startDisplay(()=>{queueMicrotask(()=>failed.emit('exit',1));return failed}),/DISPLAY_EXITED/);assert.equal(failed.killed,true);
});

const {shouldRenewRecovery}=require('../scripts/funda-browser-session.cjs');
test('consumed recovery grants remain stable for scheduler deduplication, but can be explicitly renewed',()=>{
  const now=1000,recovery={consumed:true,resolved:false,expires:2000};
  assert.equal(shouldRenewRecovery(recovery,now),false);
  assert.equal(shouldRenewRecovery(recovery,now,true),true);
  assert.equal(shouldRenewRecovery(recovery,2000),true);
  assert.equal(shouldRenewRecovery({...recovery,resolved:true},now),true);
  assert.equal(shouldRenewRecovery(null,now),true);
});

test('browser lifecycle handles cannot rotate an outstanding recovery key or invalidate its session',async()=>{
  const {createBrowserLifecycle}=require('../scripts/browser-lifecycle.cjs');
  const now=Date.now(),handle={browser:{},context:{}};
  const lifecycle=createBrowserLifecycle({launch:async()=>handle,suspend:async()=>{}});
  let recovery={id:'existing-grant',key:randomBytes(32).toString('base64url'),expires:now+60000,consumed:false,resolved:false};
  const original={...recovery},cookie=issueCookie(recovery.key,recovery.expires);
  function grant(renew=false){
    if(shouldRenewRecovery(recovery,now,renew))recovery={...recovery,key:randomBytes(32).toString('base64url'),consumed:false};
    return {...recovery};
  }
  try {
    // Exercise the actual lifecycle callback contract that caused the production bug.
    for(let poll=0;poll<5;poll++)assert.deepEqual(await lifecycle.run(grant),original);
    recovery.consumed=true;
    for(let poll=0;poll<5;poll++)assert.deepEqual(await lifecycle.run(grant),{...original,consumed:true});
    assert.equal(validCookie(cookie,recovery.key,now),true);
    assert.equal(shouldRenewRecovery(recovery,now,{browser:{}}),false);
    assert.equal(shouldRenewRecovery(recovery,now,'true'),false);
    grant(true);
    assert.notEqual(recovery.key,original.key);
    assert.equal(validCookie(cookie,recovery.key,now),false);
  } finally {await lifecycle.close()}
});

test('fresh validated Pararius first document is reused without another navigation',async()=>{
  const {readBrowserPage}=require('../scripts/funda-browser-session.cjs');
  const url='https://www.pararius.nl/huurwoningen/groningen/0-1500/straal-25';
  let persisted=0;
  const page={url:()=>url,content:async()=>'<h1>valid search</h1>',goto:()=>{throw Error('UNEXPECTED_RELOAD')}};
  const r=await readBrowserPage(page,url,{reuseFreshSearch:true,searchUrl:url,snapshot:{url,status:200,loadedAt:1000},now:2000,
    searchReady:html=>html.includes('valid search'),persist:async()=>{persisted++}});
  assert.equal(r.status,200);assert.match(await r.text(),/valid search/);assert.equal(persisted,1);
});
test('stale, denied, changed or invalid first documents and later pages must navigate normally',async()=>{
  const {readBrowserPage}=require('../scripts/funda-browser-session.cjs');
  const url='https://www.pararius.nl/huurwoningen/groningen/0-1500/straal-25';
  for(const patch of [{reuseFreshSearch:false},{now:62001},{now:999},{snapshot:{url,status:403,loadedAt:1000}},
    {snapshot:{url,status:429,loadedAt:1000}},{snapshot:undefined},{snapshot:{url:url+'/page-2',status:200,loadedAt:1000}},
    {searchReady:()=>false},{searchUrl:url+'/page-2'}]) {
    let navigations=0;const page={url:()=>url,content:async()=>'<h1>valid search</h1>',
      goto:async()=>{navigations++;return {status:()=>403}},waitForTimeout:async()=>{}};
    const r=await readBrowserPage(page,url,{reuseFreshSearch:true,searchUrl:url,snapshot:{url,status:200,loadedAt:1000},now:2000,searchReady:()=>true,...patch});
    assert.equal(navigations,1);assert.equal(r.status,403);
  }
});
test('document tracker records completed main-frame status and discards it on the next navigation',()=>{
  const {trackDocument}=require('../scripts/funda-browser-session.cjs');
  const callbacks={},main={},child={},page={on:(event,fn)=>{callbacks[event]=fn},mainFrame:()=>main};
  const snapshot=trackDocument(page,()=>1234);
  const request=frame=>({isNavigationRequest:()=>true,frame:()=>frame});
  const response=(frame,status)=>({request:()=>request(frame),frame:()=>frame,status:()=>status,url:()=>'https://www.pararius.nl/search'});
  callbacks.response(response(main,200));callbacks.domcontentloaded();assert.equal(snapshot().loadedAt,1234);assert.equal(snapshot().status,200);
  callbacks.request(request(child));assert.equal(snapshot().status,200);
  callbacks.request(request(main));assert.equal(snapshot(),undefined);
  callbacks.response(response(main,403));callbacks.domcontentloaded();assert.equal(snapshot().status,403);
});
