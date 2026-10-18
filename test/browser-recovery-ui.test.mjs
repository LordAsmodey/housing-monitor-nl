import {test} from 'node:test';
import assert from 'node:assert/strict';
import {runInNewContext} from 'node:vm';
import {createRequire} from 'node:module';
const {html}=createRequire(import.meta.url)('../scripts/funda-browser-session.cjs');

async function openRecovery({session=false,key='single-use-key',loginWorks=true,stateStatus=401}={}) {
  const elements=new Map(),calls=[];
  const element=id=>{
    if(!elements.has(id))elements.set(id,{style:{},addEventListener(){},textContent:''});
    return elements.get(id);
  };
  let cleaned=false;
  const script=html('test','Pararius').match(/<script nonce="test">([\s\S]*)<\/script>/)[1];
  const context={
    document:{getElementById:element,querySelectorAll:()=>[]},
    location:{hash:key?'#key='+key:'',pathname:'/'},
    history:{replaceState(){cleaned=true}},URLSearchParams,
    URL:{createObjectURL:()=> 'blob:screen',revokeObjectURL(){}},setInterval(){},
    async fetch(path,options){
      calls.push({path,body:options.body});
      const status=path==='/api/login'?(loginWorks?200:401):session?200:stateStatus;
      if(path==='/api/login'&&status===200)session=true;
      return {ok:status===200,status,blob:async()=>({}),json:async()=>status===200?{listingLinks:30,searchReady:true}:{message:'Запроси новую ссылку доступа.'}};
    }
  };
  runInNewContext(script,context);
  // Wait for all bootstrap, login and refresh promises to finish.
  await new Promise(resolve=>setImmediate(resolve));
  return {calls,elements,cleaned};
}

test('reopening a consumed recovery link resumes a valid cookie without redeeming the key',async()=>{
  for(const key of ['consumed-key','rotated-old-key','']){
    const result=await openRecovery({session:true,key});
    assert.equal(result.calls.some(call=>call.path==='/api/login'),false);
    assert.equal(result.elements.get('work').style.display,'block');
    assert.equal(result.cleaned,true);
  }
});

test('a fresh browser redeems a recovery key once after the session check fails',async()=>{
  const result=await openRecovery();
  assert.deepEqual(result.calls.map(call=>call.path),['/api/state','/api/login','/api/screen','/api/state']);
  assert.deepEqual(JSON.parse(result.calls[1].body),{key:'single-use-key'});
  assert.equal(result.elements.get('work').style.display,'block');
  assert.equal(result.cleaned,true);
});

test('a rejected recovery key keeps controls hidden and explains how to regain access',async()=>{
  const result=await openRecovery({loginWorks:false});
  assert.deepEqual(result.calls.map(call=>call.path),['/api/state','/api/login']);
  assert.notEqual(result.elements.get('work')?.style.display,'block');
  assert.match(result.elements.get('note').textContent,/новую ссылку/);
});

test('an unauthenticated visit without a key does not attempt login or screen access',async()=>{
  const result=await openRecovery({key:''});
  assert.deepEqual(result.calls.map(call=>call.path),['/api/state']);
  assert.notEqual(result.elements.get('work')?.style.display,'block');
});
