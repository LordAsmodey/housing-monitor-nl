import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const {browserClient}=createRequire(import.meta.url)('../scripts/funda-browser-client.cjs');
const origin='https://funda-browser-session-production.up.railway.app',token='x'.repeat(43);
test('browser client retains dates and never exports state or arbitrary navigation',async()=>{
  const calls=[];
  const client=browserClient(origin,token,async(url,options)=>{calls.push({url:String(url),options});return Response.json({inspected:1,listings:[{publishedAt:'2026-10-12T00:00:00Z'}]})});
  const result=await client.collect();
  assert.equal(result.listings[0].publishedAt.toISOString(),'2026-10-12T00:00:00.000Z');
  assert.equal(calls[0].url,origin+'/worker/collect');assert.equal(calls[0].options.redirect,'error');
  for(const host of ['http://localhost:8080','https://funda.nl','https://railway.app.evil.example','https://user:secret@x.up.railway.app'])assert.throws(()=>browserClient(host,token));
});
test('browser CAPTCHA, malformed results and transport failure cannot become empty successful runs',async()=>{
  await assert.rejects(browserClient(origin,token,async()=>Response.json({category:'HUMAN_CHECK',blocked:true},{status:422})).collect(),e=>e.category==='HUMAN_CHECK'&&e.blocked);
  await assert.rejects(browserClient(origin,token,async()=>Response.json({})).collect(),/BROWSER_RESULT_INVALID/);
  await assert.rejects(browserClient(origin,token,async()=>{throw Error('private credentials')}).collect(),e=>e.message==='BROWSER_TRANSPORT');
});

test('a missing optional publication date remains absent across the worker boundary',async()=>{
  const result=await browserClient(origin,token,async()=>Response.json({inspected:1,listings:[{externalId:'1'}]})).collect();
  assert.equal(Object.hasOwn(result.listings[0],'publishedAt'),false);
});
