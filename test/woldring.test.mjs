import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import core from '../scripts/woldring-core.cjs';
const {parseCard,parseSearch,collect,SEARCH_URLS,allowedUrl}=core;
const card=fs.readFileSync(new URL('./fixtures/woldring-card.html',import.meta.url),'utf8');
const second=card.replaceAll('friesestraatweg-145-23','schoolholm-26-01').replaceAll('Friesestraatweg 145-23','Schoolholm 26-01');
const page=(cards=[card],count=cards.length,studio=false)=>`<h1>${studio?"Studio's":'Appartementen'}</h1><small>${count} resultaten</small>${cards.join('')}`;
test('live Woldring fixture extracts pricing, eligibility, energy, availability and closed applications',()=>{
  const item=parseCard(card,'apartment');assert.equal(item.rentPrice,1166.27);assert.equal(item.serviceCosts,95);
  assert.equal(item.areaM2,48);assert.equal(item.housingDetails.energyLabel,'A+');assert.equal(item.housingDetails.huurtoeslag,true);
  assert.equal(item.housingDetails.utilities,'separate');assert.equal(item.housingDetails.applicationsClosed,true);
  assert.equal(item.housingDetails.availableFrom,'now');assert.equal(Object.hasOwn(item,'publishedAt'),false);
});
test('dated availability is a move-in date; unavailable listings have no invented rent',()=>{
  const dated=card.replace('Per direct beschikbaar!','<span>Beschikbaar per:</span> 11-11-2026');
  assert.equal(parseCard(dated,'studio').housingDetails.availableFrom,'2026-11-11');
  const unavailable=card.replace('Per direct beschikbaar!','Niet beschikbaar').replace(/<span class="price">[\s\S]*?<\/span><\/span>/,'');
  assert.equal(parseCard(unavailable,'studio').availabilityStatus,'unavailable');assert.equal(Object.hasOwn(parseCard(unavailable,'studio'),'rentPrice'),false);
  assert.throws(()=>parseCard(dated.replace('11-11-2026','31-02-2026'),'studio'),/AVAILABILITY_INVALID/);
  assert.throws(()=>parseCard(card.replace('Per direct beschikbaar!','Onbekend'),'studio'),/AVAILABILITY_MISSING/);
});
test('count, category, duplicate and truncation guards prevent partial or false empty runs',()=>{
  assert.equal(parseSearch(page(),SEARCH_URLS[0]).listings.length,1);
  assert.equal(parseSearch(page([],0),SEARCH_URLS[0]).total,0);
  for(const html of [page([],1),page([card,card]),page().replace('Appartementen','Kamers'),page().replace('1 resultaten','results'),page().slice(0,-15)])assert.throws(()=>parseSearch(html,SEARCH_URLS[0]));
  assert.throws(()=>parseSearch('<h1>Verify you are human</h1>',SEARCH_URLS[0]),/ACCESS_BLOCKED/);
  assert.throws(()=>parseCard(card.replace('&euro;1.166,27','&euro;onbekend'),'apartment'),/CARD_METADATA_MISSING/);
});
test('two independent categories must both validate; no budget or publication restriction',async()=>{
  const calls=[];const result=await collect({transport:async url=>{calls.push(url);return new Response(url===SEARCH_URLS[0]?page():page([second],1,true),{headers:{'content-type':'text/html'}})}});
  assert.deepEqual(calls,SEARCH_URLS);assert.equal(result.inspected,2);assert.equal(result.available,2);assert.equal(result.listings[1].housingDetails.propertyType,'studio');
  const expensive=card.replace('&euro;1.166,27','&euro;2.500,00');assert.equal(parseCard(expensive,'apartment').rentPrice,2500);
  await assert.rejects(collect({transport:async url=>new Response(url===SEARCH_URLS[0]?page():page([],1,true),{headers:{'content-type':'text/html'}})}),/INCOMPLETE_SEARCH/);
});
test('bounded retries and HTTP errors preserve a failed run, URL allowlist rejects SSRF',async()=>{
  let calls=0;const result=await collect({pause:async()=>{},transport:async url=>{
    calls++;return calls===1?new Response('gateway',{status:502}):new Response(url===SEARCH_URLS[0]?page():page([second],1,true),{headers:{'content-type':'text/html'}});
  }});assert.equal(result.inspected,2);assert.equal(calls,3);
  await assert.rejects(collect({transport:async()=>new Response('blocked',{status:403})}),e=>e.blocked);
  await assert.rejects(collect({transport:async()=>new Response('wait',{status:429})}),/RATE_LIMIT/);
  for(const url of ['http://woldringverhuur.nl/appartementen/','https://user:pass@woldringverhuur.nl/appartementen/','https://localhost/appartementen/',SEARCH_URLS[0]+'?page=2','https://woldringverhuur.nl/ons-aanbod/'])assert.throws(()=>allowedUrl(url,'search'));
});
