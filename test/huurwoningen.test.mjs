import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
const require=createRequire(import.meta.url);
const {SEARCH_URL,allowedUrl,parseCard,parseSearch,collect}=require('../scripts/huurwoningen-core.cjs');
const {searchReady}=require('../scripts/huurwoningen-browser-session.cjs');
const card=readFileSync(new URL('./fixtures/huurwoningen-card.html',import.meta.url),'utf8');
const page=(cards=[card],total=cards.length,next='')=>`<h1>Huurwoningen in een straal van 25km van Groningen</h1><span>${total}</span> Huurwoningen in een straal van 25km van Groningen <span>Binnen 3 maanden</span>${cards.join('')}${next?`<a href="${next.replaceAll('&','&amp;')}">Volgende</a>`:''}`;
const second=card.replaceAll('83108c92','abcdef12').replaceAll('Eeldersingel','Andere straat');

test('live card fixture preserves rent, locality and features with nested lists',()=>{
  assert.deepEqual(parseCard(card),{externalId:'83108c92',canonicalUrl:'https://www.huurwoningen.com/huren/groningen/83108c92/eeldersingel/',title:'Studio Eeldersingel',city:'Groningen',rentPrice:780,availabilityStatus:'unknown',areaM2:24,rooms:1});
  assert.equal(parseCard(card.replace('€&nbsp;780','€&nbsp;1.995')).rentPrice,1995);
  assert.equal(parseCard(card.replaceAll('Groningen (Badstratenbuurt)','Marum (Marum)')).city,'Marum');
  assert.equal(parseCard(card.replaceAll('Studio Eeldersingel','Kamer Eeldersingel')+' Woningruil').title,'Kamer Eeldersingel');
});
test('URL allowlist preserves the agreed filters and rejects SSRF or broadened searches',()=>{
  assert.equal(allowedUrl(SEARCH_URL,'search'),SEARCH_URL);
  assert.equal(allowedUrl('/huren/groningen/83108c92/eeldersingel/?tracking=1'),'https://www.huurwoningen.com/huren/groningen/83108c92/eeldersingel/');
  for(const value of [SEARCH_URL.replace('25','30'),SEARCH_URL.replace('within_3_months','now'),SEARCH_URL+'&radius=25',SEARCH_URL+'&price=1500',SEARCH_URL+'&page=0','http://localhost/in/groningen/','https://user:secret@www.huurwoningen.com/in/groningen/'])assert.throws(()=>allowedUrl(value,'search'));
});
test('changed filters, damaged cards and CAPTCHA fail instead of establishing an empty baseline',()=>{
  assert.equal(parseSearch(page()).listings.length,1);
  assert.equal(parseSearch(page([],0)).total,0);
  assert.equal(searchReady(page([],0),SEARCH_URL),true);
  assert.equal(searchReady('<h1>Captcha</h1>',SEARCH_URL),false);
  for(const html of [page().replace('Binnen 3 maanden','Binnen 6 maanden'),page([],5),page().replace('€&nbsp;780 per maand','Prijs op aanvraag'),page().replace('9726 AS Groningen (Badstratenbuurt)','Onbekend'),page([card,card]),'<h1>Verify you are human</h1>'])assert.throws(()=>parseSearch(html));
});
test('all result pages are collected without visiting every detail page',async()=>{
  const next=SEARCH_URL+'&page=2',calls=[];
  const result=await collect({pause:async()=>{},transport:async(url)=>{calls.push(url);return new Response(url===SEARCH_URL?page([card],2,next):page([second],2),{headers:{'content-type':'text/html'}})}});
  assert.equal(result.inspected,2);assert.equal(result.pages,2);assert.equal(result.listings.length,2);assert.deepEqual(calls,[SEARCH_URL,next]);
});
test('incomplete, repeated, changing or oversized pagination cannot commit partial results',async()=>{
  const next=SEARCH_URL+'&page=2';
  async function run(first,last,options={}){return collect({...options,pause:async()=>{},transport:async(url)=>new Response(url===SEARCH_URL?first:last,{headers:{'content-type':'text/html'}})})}
  await assert.rejects(run(page([card],2)),/INCOMPLETE_SEARCH/);
  await assert.rejects(run(page([card],2,next),page([card],2)),/PAGINATION_NOT_ADVANCING/);
  await assert.rejects(run(page([card],2,next),page([second],3)),/SEARCH_CHANGED_DURING_RUN/);
  await assert.rejects(run(page([card],2,next),page([second],2),{maxPages:1}),/PAGINATION_LIMIT/);
  await assert.rejects(run(page([card],601)),/LISTING_LIMIT/);
  await assert.rejects(collect({transport:async()=>new Response('blocked',{status:403})}),e=>e.category==='ACCESS_BLOCKED'&&e.blocked);
});
