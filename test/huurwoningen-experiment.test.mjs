import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp,mkdir,writeFile,readFile,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
const require=createRequire(import.meta.url);
const {restoreProfile,saveProfile}=require('../scripts/browser-profile.cjs');
const {createExperiment,INTERVAL,DURATION}=require('../scripts/huurwoningen-experiment.cjs');
const {proxyOptions}=require('../scripts/huurwoningen-patchright-session.cjs');
async function temporary(t){const dir=await mkdtemp(join(tmpdir(),'housing-experiment-'));t.after(()=>rm(dir,{recursive:true,force:true}));return dir}
test('full profile survives encrypted archive restore; cookies, Local State and IndexedDB never appear on volume in plaintext',async t=>{
  const dir=await temporary(t),key=randomBytes(32),profile=join(dir,'profile'),archive=join(dir,'profile.enc');
  await mkdir(join(profile,'Default','IndexedDB'),{recursive:true});
  await writeFile(join(profile,'Local State'),'secret-local-key');
  await writeFile(join(profile,'Default','Cookies'),'private-cookie');
  await writeFile(join(profile,'Default','IndexedDB','state'),'private-db');
  await writeFile(join(profile,'SingletonLock'),'old-container');
  await saveProfile(profile,archive,key);
  const encrypted=await readFile(archive);assert.equal(encrypted.includes(Buffer.from('private-cookie')),false);
  const restored=join(dir,'restored');assert.equal(await restoreProfile(restored,archive,key),true);
  assert.equal(await readFile(join(restored,'Local State'),'utf8'),'secret-local-key');
  assert.equal(await readFile(join(restored,'Default','IndexedDB','state'),'utf8'),'private-db');
  await assert.rejects(stat(join(restored,'SingletonLock')),{code:'ENOENT'});
  await assert.rejects(restoreProfile(join(dir,'wrong'),archive,randomBytes(32)));
  assert.equal(await restoreProfile(join(dir,'fresh'),join(dir,'absent'),key),false);
});
test('soak serializes work, preserves progress across restart and requires all 96 slots plus profile restoration',async t=>{
  const dir=await temporary(t),file=join(dir,'experiment.json');let clock=1000,calls=0;
  const args={file,now:()=>clock,schedule:()=>1,cancel:()=>{},emit:()=>{}};
  const collector=async()=>{calls++;return {inspected:4,pages:1}};
  const first=createExperiment(args);await first.init({collect:collector,profileRestored:false});
  assert.equal(calls,1);await Promise.all([first.tick(),first.tick()]);assert.equal(calls,1);
  first.stop();const second=createExperiment(args);await second.init({collect:collector,profileRestored:true});
  assert.equal(second.state().restoredRestarts,1);
  for(let i=1;i<96;i++){clock=1000+i*INTERVAL;await second.tick()}
  assert.equal(calls,96);clock=1000+DURATION;await second.tick();assert.equal(second.state().status,'passed');
});
test('CAPTCHA pauses the trial without navigation loops or false empty success; explicit resume starts a fresh trial',async t=>{
  const dir=await temporary(t);let calls=0,blocked=true,clock=1000;
  const runner=createExperiment({file:join(dir,'state.json'),now:()=>clock,schedule:()=>1,cancel:()=>{},emit:()=>{}});
  await runner.init({collect:async()=>{calls++;if(blocked)throw Object.assign(Error('private-url-and-token'),{category:'HUMAN_CHECK',blocked:true});return {inspected:0,pages:1}},profileRestored:false});
  assert.equal(runner.state().status,'blocked');clock+=INTERVAL;await runner.tick();assert.equal(calls,1);
  assert.equal((await readFile(join(dir,'state.json'),'utf8')).includes('private-url-and-token'),false);
  blocked=false;await runner.start();assert.equal(runner.state().status,'running');assert.equal(runner.state().samples[0].inspected,0);
});
test('missed intervals cannot pass a soak trial',async t=>{
  const dir=await temporary(t);let clock=0;
  const runner=createExperiment({file:join(dir,'state.json'),now:()=>clock,schedule:()=>1,cancel:()=>{},emit:()=>{}});
  await runner.init({collect:async()=>({inspected:0,pages:1}),profileRestored:false});
  clock=INTERVAL*2;await runner.tick();assert.equal(runner.state().status,'incomplete');
});
test('proxy is optional, explicit and never accepts credentials embedded in URLs',()=>{
  assert.equal(proxyOptions({}),undefined);
  assert.deepEqual(proxyOptions({BROWSER_PROXY_SERVER:'http://proxy.example:8080',BROWSER_PROXY_USERNAME:'user',BROWSER_PROXY_PASSWORD:'secret'}),{server:'http://proxy.example:8080',username:'user',password:'secret'});
  for(const env of [{BROWSER_PROXY_PASSWORD:'secret'},{BROWSER_PROXY_SERVER:'http://user:secret@proxy.example:8080'},
    {BROWSER_PROXY_SERVER:'http://proxy.example:8080/path'}, {BROWSER_PROXY_SERVER:'file:///tmp/proxy'},
    {BROWSER_PROXY_SERVER:'http://proxy.example',BROWSER_PROXY_USERNAME:'user'}])assert.throws(()=>proxyOptions(env));
});
