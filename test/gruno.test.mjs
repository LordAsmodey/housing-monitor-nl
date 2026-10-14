import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import core from '../scripts/gruno-core.cjs';
const {SEARCH_URL,parseCard,parseSearch,parseDetail,candidate,collect,allowedUrl,dutchDate}=core;
const card=fs.readFileSync(new URL('./fixtures/gruno-card.html',import.meta.url),'utf8');
const detail=fs.readFileSync(new URL('./fixtures/gruno-detail.html',import.meta.url),'utf8');
const page=(cards=[card],total=cards.length,next='')=>`<h1>Zoekresultaten</h1><span>${total} objecten gevonden</span>${cards.join('')}${next?`<a class="sys_paging next-page" href="${next.replaceAll('&','&amp;')}">&gt;</a>`:''}`;
const response=html=>new Response(html,{headers:{'content-type':'text/html'}});
function unique(i) {return card.replaceAll('01768',String(1700+i)).replaceAll('/45-2','/45-'+(i+100))}
test('real HTML preserves IDs, canonical URLs, advertised pricing and distinct publication/move-in dates',()=>{
  const parsed=parseCard(card);assert.equal(parsed.listing.externalId,'01768');
  assert.equal(parsed.listing.canonicalUrl.endsWith('/jozef-israelsstraat/45-2'),true);
  assert.equal(parsed.listing.title.includes('Israëlsstraat'),true);assert.equal(parsed.listing.rooms,3);
  const item=parseDetail(detail,parsed);assert.equal(item.rentPrice,1232);assert.equal(item.serviceCosts,130);
  assert.equal(item.areaM2,28);assert.equal(item.housingDetails.priceBasis,'advertised');assert.equal(item.housingDetails.serviceCostsIncluded,true);
  assert.equal(item.housingDetails.availableFrom,'2026-11-01');assert.equal(item.publishedAt.toISOString(),'2026-10-12T00:00:00.000Z');
  assert.equal(item.housingDetails.energyLabel,'A+++');assert.equal(candidate(parsed),true);
});
test('module filters geography, advertised budget, transaction type, student rooms and independent housing',()=>{
  for(const html of [card.replace('1.232,-','1.500,01'),card.replaceAll('/huur/','/koop/'),card.replaceAll('9718GC Groningen','9718GC Assen'),
    card.replace('benedenwoning, appartement','Studentenkamer, appartement'),card.replaceAll('Appartement met twee','Semi-zelfstandige studio met twee')])assert.equal(candidate(parseCard(html)),false);
  assert.equal(candidate(parseCard(card.replace('1.232,-','1.500,-'))),true);
  assert.equal(candidate(parseCard(card.replace('1.232,-','1.499,99'))),true);
  for(const phrase of ['De badkamer wordt gedeeld met vijf bewoners.','Een gemeenschappelijke keuken is aanwezig.','Dit is een semi-zelfstandige studio.']) {
    const shared=detail.replace('Je komt binnen in een gedeeld portiek.',phrase);assert.equal(parseDetail(shared,parseCard(card)),null);
  }
  // A shared entrance alone does not make an apartment a room.
  assert.ok(parseDetail(detail,parseCard(card)));
});
test('full pagination validates total before module filtering and requests details only for candidates',async()=>{
  const first=Array.from({length:10},(_,i)=>unique(i));
  const next=SEARCH_URL+'?moveunavailablelistingstothebottom=true&skip=10';const calls=[];
  const result=await collect({transport:async url=>{
    calls.push(url);
    if(url===SEARCH_URL)return response(page(first.map(x=>x.replace('benedenwoning, appartement','Studentenkamer, appartement')),11,next));
    if(url===next)return response(page([card],11));
    assert.equal(url,parseCard(card).listing.canonicalUrl);return response(detail);
  }});
  assert.equal(result.inspected,11);assert.equal(result.details,1);assert.equal(result.listings.length,1);assert.equal(result.pages,2);assert.equal(calls.length,3);
});
test('missing, changed, duplicated or truncated catalog data cannot establish a partial/empty success',async()=>{
  for(const html of [page([],1),page().replace('objecten gevonden','results'),page().replace('Zoekresultaten','Other'),page([card,card]),page().slice(0,-15),
    page().replace('Nieuw in verhuur','Unknown state'),page().replace('1.232,-','op aanvraag'),page().replace('28 m&#178;','? m&#178;'),page()+' Verify you are human',page([],0,SEARCH_URL+'?skip=10')])assert.throws(()=>parseSearch(html));
  assert.equal(parseSearch(page([],0)).total,0);
  assert.equal((await collect({transport:async()=>response(page([],0))})).inspected,0);
  const first=Array.from({length:10},(_,i)=>unique(i));const next=SEARCH_URL+'?skip=10';
  await assert.rejects(collect({transport:async url=>response(url===SEARCH_URL?page(first,11,next):page([card,unique(30)],12))}),/SEARCH_COUNT_CHANGED/);
  await assert.rejects(collect({transport:async url=>response(url===SEARCH_URL?page(first,11,next):page([first[0]],11))}),/DUPLICATE_CARD/);
});
test('detail identity, consistency, dates and fields fail closed; optional data are not invented',()=>{
  for(const html of [detail.replace('01768','00001'),detail.replace('€ 1.232,-','€ 1.233,-'),detail.replaceAll('Nieuw in verhuur','Verhuurd'),
    detail.replaceAll('12 oktober 2026','31 februari 2026'),detail.replaceAll('Referentienummer','Id')])assert.throws(()=>parseDetail(html,parseCard(card)));
  for(const date of ['Maandag 31 februari 2026','Unknown','12 unknown 2026'])assert.throws(()=>dutchDate(date));
  const optional=detail.replace(/<tr> <td class="object_detail_title">(?:Servicekosten|Aangeboden sinds|Aanvaarding)<\/td>[\s\S]*?<\/tr>/g,'');
  const item=parseDetail(optional,parseCard(card));assert.equal(item.serviceCosts,undefined);assert.equal(item.publishedAt,undefined);assert.equal(item.housingDetails.availableFrom,undefined);
  const unknownBasis=parseDetail(detail.replace('incl. servicekosten, ',''),parseCard(card));assert.equal(unknownBasis.housingDetails.serviceCostsIncluded,undefined);
});
test('URL validation limits navigation to the source, pagination and known search-context parameters',()=>{
  assert.equal(allowedUrl('/woningaanbod/huur/groningen/straat/1?take=10&localityid=23523&skip=10'), 'https://www.grunoverhuur.nl/woningaanbod/huur/groningen/straat/1');
  for(const url of ['http://www.grunoverhuur.nl/woningaanbod/groningen','https://localhost/woningaanbod/groningen','https://u:p@www.grunoverhuur.nl/woningaanbod/groningen',SEARCH_URL+'?skip=1',SEARCH_URL+'?skip=200',SEARCH_URL+'?skip=10&skip=20',SEARCH_URL+'?redirect=foo',SEARCH_URL+'#x'])assert.throws(()=>allowedUrl(url,'search'));
  assert.throws(()=>allowedUrl('/woningaanbod/huur/groningen/straat/1?print=true'));
});
test('HTTP retries are bounded; blocked/rate-limited/invalid responses and timeouts cannot record empty runs',async()=>{
  let calls=0;
  const result=await collect({pause:async()=>{},transport:async()=>++calls<3?new Response('gateway',{status:503}):response(page([],0))});assert.equal(calls,3);assert.equal(result.total,0);
  calls=0;await assert.rejects(collect({pause:async()=>{},transport:async()=>{calls++;throw Error('network')}}),/HTTP_TRANSPORT/);assert.equal(calls,3);
  for(const status of [302,401,403,429,500])await assert.rejects(collect({transport:async()=>new Response('',{status})}),e=>[401,403].includes(status)?e.blocked:status===429?e.retryAfterSeconds===900:true);
  await assert.rejects(collect({signal:AbortSignal.abort(),transport:async()=>{throw Error('must not fetch')}}),/RUN_TIMEOUT/);
  await assert.rejects(collect({transport:async()=>new Response('not html')}),/CONTENT_TYPE/);
  await assert.rejects(collect({transport:async()=>response('x'.repeat(8*1024*1024+1))}),/BODY_TOO_LARGE/);
});

test('living area is distinct from plot area on a house card in the unfiltered catalog',()=>{
  const withPlot=card.replace('28 m&#178;</span>', '28 m&#178;</span><span title="Perceeloppervlakte">138 m&#178;</span>');
  assert.equal(parseCard(withPlot).listing.areaM2,28);
});

test('missing catalog badge stays unknown until an explicit detail status confirms availability',()=>{
  const noBadge=card.replace(/<span class="object_status new_forrent"><span>Nieuw in verhuur<\/span><\/span>/,'');
  const parsed=parseCard(noBadge);assert.equal(parsed.listing.availabilityStatus,'unknown');
  assert.equal(parseDetail(detail,parsed).availabilityStatus,'available');
  assert.equal(parseDetail(detail.replaceAll('Nieuw in verhuur','Verhuurd'),parsed).availabilityStatus,'unavailable');
  assert.throws(()=>parseDetail(detail.replaceAll('Nieuw in verhuur','Unknown status'),parsed),/AVAILABILITY_UNKNOWN/);
});

test('unrelated repeated feature labels such as furnishing do not conflict with monitored fields',()=>{
  const furnishing='<table><tr><td>Inrichting</td><td>Ja</td></tr><tr><td>Inrichting</td><td>Gestoffeerd</td></tr></table>';
  assert.ok(parseDetail(detail+furnishing,parseCard(card)));
  assert.throws(()=>parseDetail(detail+'<table><tr><td>Status</td><td>Verhuurd</td></tr></table>',parseCard(card)),/DETAIL_CONFLICT/);
});

test('normal details with no status preserve unknown instead of inferring availability',()=>{
  const noBadge=card.replace(/<span class="object_status new_forrent"><span>Nieuw in verhuur<\/span><\/span>/,'');
  const noStatus=detail.replace(/<tr> <td class="object_detail_title">Status<\/td>[\s\S]*?<\/tr>/g,'');
  assert.equal(parseDetail(noStatus,parseCard(noBadge)).availabilityStatus,'unknown');
});
