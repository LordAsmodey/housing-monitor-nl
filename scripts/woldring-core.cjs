'use strict';
const { FundaError } = require('./funda-core.cjs');
const SOURCE_ID = 'woldring:apartments-studios';
const SEARCH_URLS = ['https://woldringverhuur.nl/appartementen/', 'https://woldringverhuur.nl/studios/'];
const FILTERS = Object.freeze({propertyTypes:['apartment','studio'],availability:['now','dated'],maxRent:null,publishedSince:null});
function text(html) {
  return html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,'')
    .replace(/<[^>]*>/g,' ').replace(/&(?:nbsp|#160);/g,' ').replace(/&amp;/g,'&').replace(/&(?:euro|#8364);/g,'€')
    .replace(/&sup2;/g,'²').replace(/&quot;/g,'"').replace(/&#39;|&apos;/g,"'")
    .replace(/&#(\d+);/g,(_,n)=>Number(n)<=0x10ffff?String.fromCodePoint(Number(n)):'').replace(/\s+/g,' ').trim();
}
function attributes(tag) {
  return Object.fromEntries([...tag.matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map(m=>[m[1].toLowerCase(),m[2]??m[3]]));
}
function allowedUrl(value,kind='detail') {
  let url;try{url=new URL(value.replace(/&amp;/g,'&'),'https://woldringverhuur.nl')}catch{throw new FundaError('INVALID_URL')}
  if(url.protocol!=='https:'||url.hostname!=='woldringverhuur.nl'||url.port||url.username||url.password||url.search)throw new FundaError('URL_NOT_ALLOWED');
  url.hash='';
  if(kind==='search'&&!SEARCH_URLS.includes(url.href))throw new FundaError('URL_NOT_ALLOWED');
  if(kind==='detail'&&(!/^\/[a-z0-9-]+\/$/.test(url.pathname)||['/appartementen/','/studios/','/ons-aanbod/'].includes(url.pathname)))throw new FundaError('URL_NOT_ALLOWED');
  return url.href;
}
function cardSections(html) {
  const cards=[];let depth=0,start;
  for(const m of html.matchAll(/<\/?div\b[^>]*>/gi)) {
    if(/^<\/div/i.test(m[0])){if(start!==undefined&&--depth===0){cards.push(html.slice(start,m.index+m[0].length));start=undefined;}}
    else if(start!==undefined)depth++;
    else if((attributes(m[0]).class??'').split(/\s+/).includes('living-area-tile')){start=m.index;depth=1;}
  }
  if(start!==undefined)throw new FundaError('CARD_STRUCTURE_CHANGED');
  return cards;
}
function money(value) {
  if(!/^\d{1,3}(?:\.\d{3})*(?:,\d{2})$|^\d+(?:,\d{2})$/.test(value))throw new FundaError('INVALID_PRICE');
  const n=Number(value.replace(/\./g,'').replace(',','.'));
  if(!Number.isFinite(n)||n<0||n>99999999)throw new FundaError('INVALID_PRICE');return n;
}
function parseCard(html,propertyType) {
  const addressBlock=html.match(/<span\b[^>]*class="primary_address"[^>]*>([\s\S]*?)<\/span>/i)?.[1];
  const link=addressBlock?.match(/<a\b([^>]*)>([\s\S]*?)<\/a>/i);
  const title=link?text(link[2]):'';
  if(!link||!title||title.length>500)throw new FundaError('CARD_STRUCTURE_CHANGED');
  const canonicalUrl=allowedUrl(attributes(link[1]).href??'');
  const visible=text(html);
  let availabilityStatus,availableFrom;
  if(/\bNiet beschikbaar\b/i.test(visible))availabilityStatus='unavailable';
  else if(/\bPer direct beschikbaar!/i.test(visible)){availabilityStatus='available';availableFrom='now';}
  else {
    const m=visible.match(/Beschikbaar per:\s*(\d{2})-(\d{2})-(\d{4})\b/);
    if(!m)throw new FundaError('AVAILABILITY_MISSING');
    const iso=m[3]+'-'+m[2]+'-'+m[1];const date=new Date(iso+'T00:00:00Z');
    if(!Number.isFinite(date.getTime())||date.toISOString().slice(0,10)!==iso)throw new FundaError('AVAILABILITY_INVALID');
    availabilityStatus='available';availableFrom=iso;
  }
  const price=visible.match(/€\s*([\d.,]+)\s*per maand/i);
  if(availabilityStatus==='available'&&!price)throw new FundaError('CARD_METADATA_MISSING');
  const area=visible.match(/Oppervlakte:\s*([\d.,]+)\s*m²/i);
  if(!area||!(Number(area[1].replace(',','.'))>0))throw new FundaError('CARD_METADATA_MISSING');
  const service=visible.match(/Exclusief servicekosten:\s*€\s*([\d.,]+)/i);
  const energy=visible.match(/Energielabel:\s*(A\+{0,4}|[B-G])\b/i)?.[1];
  // Match plus signs greedily without requiring a word boundary after them.
  const energyLabel=visible.match(/Energielabel:\s*(A\+{0,4}|[B-G])(?=\s|$)/i)?.[1]??energy;
  const subsidy=visible.match(/Huurtoeslag mogelijk:\s*(Ja|Nee)\b/i)?.[1];
  const utilities=/Nutsvoorzieningen via servicekosten/i.test(visible)?'serviceCosts':/Exclusief nutsvoorzieningen/i.test(visible)?'separate':/Inclusief nutsvoorzieningen/i.test(visible)?'included':undefined;
  const applicationsClosed=/Inschrijving gesloten/i.test(visible);
  return {externalId:new URL(canonicalUrl).pathname.slice(1,-1),canonicalUrl,title,address:title,city:'Groningen',availabilityStatus,
    ...(price?{rentPrice:money(price[1])}:{}),areaM2:Number(area[1].replace(',','.')),...(service?{serviceCosts:money(service[1])}:{}),
    housingDetails:{propertyType,...(availableFrom?{availableFrom}:{}),...(energyLabel?{energyLabel}:{}),...(subsidy?{huurtoeslag:subsidy==='Ja'}:{}),...(utilities?{utilities}:{}),applicationsClosed}};
}
function parseSearch(html,url) {
  allowedUrl(url,'search');const visible=text(html);
  if(/verify you are human|just a moment|access denied|forbidden|bevestig.{0,20}mens/i.test(visible))throw new FundaError('ACCESS_BLOCKED',true);
  const type=url===SEARCH_URLS[0]?'apartment':'studio';
  const heading=text(html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1]??'');
  if(heading!==(type==='apartment'?'Appartementen':"Studio's"))throw new FundaError('SEARCH_STRUCTURE_CHANGED');
  const count=visible.match(/\b(\d+)\s+resultaten\b/i);if(!count)throw new FundaError('SEARCH_COUNT_MISSING');
  const total=Number(count[1]);if(total>2000)throw new FundaError('LISTING_LIMIT');
  const listings=cardSections(html).map(card=>parseCard(card,type));
  if(listings.length!==total)throw new FundaError('INCOMPLETE_SEARCH');
  if(new Set(listings.map(x=>x.canonicalUrl)).size!==total)throw new FundaError('DUPLICATE_CARD');
  return {listings,total};
}
async function fetchHtml(url,transport,signal,pause) {
  allowedUrl(url,'search');let response;
  for(let attempt=0;attempt<3;attempt++) {
    if(signal.aborted)throw new FundaError('RUN_TIMEOUT');
    try{response=await transport(url,{redirect:'manual',signal,headers:{Accept:'text/html','Accept-Language':'nl-NL'}})}catch{
      if(attempt===2||signal.aborted)throw new FundaError(signal.aborted?'RUN_TIMEOUT':'HTTP_TRANSPORT');await pause(1000);continue;
    }
    if(![502,503,504].includes(response.status)||attempt===2)break;
    await response.body?.cancel();await pause(1000);
  }
  if([401,403].includes(response.status))throw new FundaError('ACCESS_BLOCKED',true);
  if(response.status===429)throw new FundaError('RATE_LIMIT',false,900);
  if(!response.ok)throw new FundaError('HTTP_STATUS');
  if(!/text\/html/i.test(response.headers.get('content-type')??''))throw new FundaError('CONTENT_TYPE');
  const reader=response.body?.getReader();if(!reader)throw new FundaError('EMPTY_BODY');
  const chunks=[];let size=0;
  try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>8*1024*1024){await reader.cancel();throw new FundaError('BODY_TOO_LARGE')}chunks.push(value)}}catch(e){if(e instanceof FundaError)throw e;throw new FundaError('HTTP_TRANSPORT')}
  return Buffer.concat(chunks).toString('utf8');
}
async function collect({transport=fetch,signal=AbortSignal.timeout(120000),pause=ms=>new Promise(r=>setTimeout(r,ms))}={}) {
  const listings=new Map();let inspected=0;
  for(const url of SEARCH_URLS) {
    const page=parseSearch(await fetchHtml(url,transport,signal,pause),url);inspected+=page.total;
    for(const item of page.listings){if(listings.has(item.canonicalUrl))throw new FundaError('DUPLICATE_CARD');listings.set(item.canonicalUrl,item)}
  }
  return {listings:[...listings.values()],inspected,pages:2,available:[...listings.values()].filter(x=>x.availabilityStatus==='available').length};
}
module.exports={SOURCE_ID,SEARCH_URLS,FILTERS,FundaError,allowedUrl,cardSections,parseCard,parseSearch,collect};
