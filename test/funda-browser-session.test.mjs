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
