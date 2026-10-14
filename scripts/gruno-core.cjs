'use strict';
const {FundaError}=require('./funda-core.cjs');
const SOURCE_ID='gruno:groningen-apartments-studios-1500';
const SEARCH_URL='https://www.grunoverhuur.nl/woningaanbod/groningen';
const FILTERS=Object.freeze({city:'Groningen',maxAdvertisedRent:1500,propertyTypes:['apartment','studio'],excludeStudentRooms:true,publishedSince:null,filtering:'module'});
const BASE='https://www.grunoverhuur.nl';
function text(html) {
  return html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,'').replace(/<[^>]*>/g,' ')
    .replace(/&(?:nbsp|#160);/g,' ').replace(/&amp;/g,'&').replace(/&(?:euro|#8364);/g,'€').replace(/&sup2;/g,'²')
    .replace(/&quot;/g,'"').replace(/&#39;|&apos;/g,"'").replace(/&#(x[\da-f]+|\d+);/gi,(_,n)=>{const v=n[0].toLowerCase()==='x'?parseInt(n.slice(1),16):Number(n);return v<=0x10ffff?String.fromCodePoint(v):''})
    .replace(/\s+/g,' ').trim();
}
function attributes(tag) {
  return Object.fromEntries([...tag.matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map(m=>[m[1].toLowerCase(),m[2]??m[3]]));
}
function hasClass(tag,name) {return (attributes(tag).class??'').split(/\s+/).includes(name)}
// Balanced same-tag extraction preserves nested spans in the site's labels.
function element(html,className) {
  for(const m of html.matchAll(/<([a-z][\w-]*)\b[^>]*>/gi)) {
    if(!hasClass(m[0],className))continue;
    const re=new RegExp('<\\/?'+m[1]+'\\b[^>]*>','gi');re.lastIndex=m.index+m[0].length;let depth=1,n;
    while((n=re.exec(html))) {depth+=/^<\//.test(n[0])?-1:1;if(depth===0)return html.slice(m.index,re.lastIndex)}
    throw new FundaError('HTML_TRUNCATED');
  }
  return undefined;
}
function checkBlocked(html) {
  if(/verify you are human|just a moment|access denied|bevestig.{0,20}mens/i.test(text(html)))throw new FundaError('ACCESS_BLOCKED',true);
}
function allowedUrl(value,kind='detail') {
  let url;try{url=new URL(value.replace(/&amp;/g,'&'),BASE)}catch{throw new FundaError('INVALID_URL')}
  if(url.protocol!=='https:'||url.hostname!=='www.grunoverhuur.nl'||url.port||url.username||url.password||url.hash)throw new FundaError('URL_NOT_ALLOWED');
  const allowed=kind==='search'?['moveunavailablelistingstothebottom','skip']:['localityid','moveunavailablelistingstothebottom','take','skip'];
  for(const [key,val] of url.searchParams) {
    if(!allowed.includes(key)||url.searchParams.getAll(key).length!==1)throw new FundaError('URL_NOT_ALLOWED');
    if(key==='moveunavailablelistingstothebottom'?val!=='true':!/^\d+$/.test(val))throw new FundaError('URL_NOT_ALLOWED');
  }
  if(kind==='search') {
    const skip=Number(url.searchParams.get('skip')??0);
    if(url.pathname!=='/woningaanbod/groningen'||skip%10||skip>190)throw new FundaError('URL_NOT_ALLOWED');
  } else {
    if(!/^\/woningaanbod\/(huur|koop)\/[a-z0-9-]+\/[a-z0-9-]+\/[a-z0-9-]+$/.test(url.pathname))throw new FundaError('URL_NOT_ALLOWED');
    url.search='';
  }
  return url.href;
}
function money(value) {
  if(!/^\d{1,3}(?:\.\d{3})*(?:,(?:\d{2}|-))?$|^\d+(?:,(?:\d{2}|-))?$/.test(value))throw new FundaError('INVALID_PRICE');
  const n=Number(value.replace(/\./g,'').replace(',-','').replace(',','.'));
  if(!Number.isFinite(n)||n<0||n>99999999)throw new FundaError('INVALID_PRICE');return n;
}
function price(value) {
  const m=value.match(/^€\s*([\d.,-]+)\s*(?:\/mnd|per maand)(?:\s|$)/i);
  if(!m)throw new FundaError('INVALID_PRICE');return money(m[1]);
}
function availability(value) {
  if(/^(Nieuw in verhuur|Te huur|Beschikbaar)$/i.test(value))return 'available';
  if(/^(Verhuurd(?: onder voorbehoud)?|Onder optie|Gereserveerd)$/i.test(value))return 'unavailable';
  throw new FundaError('AVAILABILITY_UNKNOWN');
}
function parseCard(html) {
  const title=text(element(html,'obj_address')??'');
  const address=text(element(html,'obj_sub_address')??'');
  const place=address.match(/^(.+),\s*\d{4}\s?[A-Z]{2}\s+(.+)$/);
  const id=text(element(html,'object_publicid')??'').match(/^ID\s*(\d{1,12})$/)?.[1];
  const link=[...html.matchAll(/<a\b[^>]*>/gi)].find(m=>hasClass(m[0],'sys-property-link'));
  if(!title||title.length>500||!place||!id||!link)throw new FundaError('CARD_METADATA_MISSING');
  const canonicalUrl=allowedUrl(attributes(link[0]).href??'');
  const kind=new URL(canonicalUrl).pathname.split('/')[2];
  const status=text(element(html,'object_status')??'');
  // An absent catalog badge proves no status. Candidate details must resolve it before storage.
  const availabilityStatus=status?availability(status):'unknown';
  const area=text(html.match(/<span\b[^>]*title="Woonoppervlakte"[^>]*>([\s\S]*?)<\/span>/i)?.[1]??'').match(/^([\d.,]+)\s*m²$/);
  const areaM2=area?Number(area[1].replace(',','.')):NaN;
  const rooms=Number(text(element(html,'object_rooms')??''));
  const typeDescription=text(html.match(/<li\b[^>]*>([\s\S]*?)<\/li>/i)?.[1]??'');
  if(!typeDescription||!Number.isFinite(areaM2)||areaM2<=0||areaM2>999999||!Number.isInteger(rooms)||rooms<1||rooms>999)throw new FundaError('CARD_METADATA_MISSING');
  const listing={externalId:id,canonicalUrl,title,address:place[1],city:place[2],rentPrice:price(text(element(html,'obj_price')??'')),areaM2,rooms,availabilityStatus};
  return {listing,kind,typeDescription};
}
function parseSearch(html,currentUrl=SEARCH_URL) {
  allowedUrl(currentUrl,'search');checkBlocked(html);
  if(text(html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1]??'')!=='Zoekresultaten')throw new FundaError('SEARCH_STRUCTURE_CHANGED');
  const count=text(html).match(/\b(\d+)\s+objecten gevonden\b/i);
  if(!count)throw new FundaError('SEARCH_COUNT_MISSING');
  const total=Number(count[1]);if(total>200)throw new FundaError('LISTING_LIMIT');
  const sections=[...html.matchAll(/<article\b([^>]*)>([\s\S]*?)<\/article>/gi)].filter(m=>hasClass(m[1],'objectcontainer'));
  const starts=[...html.matchAll(/<article\b[^>]*>/gi)].filter(m=>hasClass(m[0],'objectcontainer')).length;
  if(starts!==sections.length)throw new FundaError('HTML_TRUNCATED');
  const cards=sections.map(m=>parseCard(m[0]));
  if(new Set(cards.map(x=>x.listing.externalId)).size!==cards.length||new Set(cards.map(x=>x.listing.canonicalUrl)).size!==cards.length)throw new FundaError('DUPLICATE_CARD');
  const skip=Number(new URL(currentUrl).searchParams.get('skip')??0);
  if(cards.length!==Math.min(10,Math.max(0,total-skip))||skip>0&&skip>=total)throw new FundaError('INCOMPLETE_SEARCH');
  const nextLinks=[...html.matchAll(/<a\b[^>]*>/gi)].filter(m=>hasClass(m[0],'next-page'));
  const nextUrls=new Set(nextLinks.map(m=>allowedUrl(attributes(m[0]).href??'','search')));
  if(nextUrls.size>1)throw new FundaError('PAGINATION_CHANGED');
  const next=[...nextUrls][0];
  if(Boolean(next)!==(skip+cards.length<total)||next&&Number(new URL(next).searchParams.get('skip'))!==skip+10)throw new FundaError('PAGINATION_CHANGED');
  return {cards,total,next};
}
function candidate(card) {
  const {listing,kind,typeDescription}=card;
  return kind==='huur'&&listing.city.toLowerCase()==='groningen'&&listing.rentPrice<=FILTERS.maxAdvertisedRent
    &&/\bappartement\b/i.test(typeDescription)&&!/studentenkamer|kamerverhuur/i.test(typeDescription)
    &&!/\b(?:semi[-\s]?zelfstandig\w*|onzelfstandig\w*|studentenkamer\w*)\b/i.test(listing.title);
}
function dutchDate(value) {
  const months=['januari','februari','maart','april','mei','juni','juli','augustus','september','oktober','november','december'];
  const m=value.toLowerCase().match(/(?:^|\s)(\d{1,2})\s+([a-z]+)\s+(\d{4})$/);
  if(!m||!months.includes(m[2]))throw new FundaError('DATE_INVALID');
  const iso=`${m[3]}-${String(months.indexOf(m[2])+1).padStart(2,'0')}-${m[1].padStart(2,'0')}`;
  const date=new Date(iso+'T00:00:00Z');
  if(!Number.isFinite(date.getTime())||date.toISOString().slice(0,10)!==iso)throw new FundaError('DATE_INVALID');return date;
}
function parseDetail(html,card) {
  checkBlocked(html);const fields=new Map();
  const wanted=new Set(['Referentienummer','Huurprijs','Servicekosten','Status','Type object','Aangeboden sinds','Aanvaarding','Energielabel']);
  for(const row of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells=[...row[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(m=>text(m[1]));
    if(cells.length!==2||!wanted.has(cells[0]))continue;
    if(fields.has(cells[0])&&fields.get(cells[0])!==cells[1])throw new FundaError('DETAIL_CONFLICT');
    fields.set(cells[0],cells[1]);
  }
  if(fields.get('Referentienummer')!==card.listing.externalId)throw new FundaError('DETAIL_ID_MISMATCH');
  const rent=fields.get('Huurprijs'),type=fields.get('Type object');
  if(!rent||!type||!fields.get('Status'))throw new FundaError('DETAIL_METADATA_MISSING');
  const availabilityStatus=availability(fields.get('Status'));
  if(price(rent)!==card.listing.rentPrice||card.listing.availabilityStatus!=='unknown'&&availabilityStatus!==card.listing.availabilityStatus)throw new FundaError('DETAIL_CONFLICT');
  const description=text(element(html,'description')??'');if(!description)throw new FundaError('DETAIL_METADATA_MISSING');
  // Do not infer independence from an Appartement label: shared sanitary/kitchen facilities are excluded.
  if(!/\bappartement\b/i.test(type)||/studentenkamer|kamerverhuur/i.test(type)||/\b(?:semi[-\s]?zelfstandig\w*|onzelfstandig\w*)\b/i.test(description)
    ||/(?:gedeeld\w*|gemeenschappelijk\w*)\s+(?:\w+\s+){0,3}(?:keuken|badkamer|toilet|douche|sanitair)|(?:keuken|badkamer|toilet|douche|sanitair)\b[^.!?]{0,100}\b(?:gedeeld|delen)\b/i.test(description))return null;
  const service=fields.get('Servicekosten');
  const serviceCosts=service===undefined?undefined:price(service);
  const published=fields.get('Aangeboden sinds');
  const acceptance=fields.get('Aanvaarding');let availableFrom;
  if(acceptance&&/^(?:Per direct|Direct)$/i.test(acceptance))availableFrom='now';
  else if(acceptance&&/^Per\s/i.test(acceptance))availableFrom=dutchDate(acceptance).toISOString().slice(0,10);
  const included=/\bincl\.\s*servicekosten\b/i.test(rent)?true:/\bexcl\.\s*servicekosten\b/i.test(rent)?false:undefined;
  const energy=fields.get('Energielabel');
  const energyLabel=energy&&/^(A\+{0,4}|[B-G])$/.test(energy)?energy:undefined;
  return {...card.listing,availabilityStatus,...(serviceCosts===undefined?{}:{serviceCosts}),...(published?{publishedAt:dutchDate(published)}:{}),
    housingDetails:{propertyType:/\bstudio\b/i.test(card.listing.title)?'studio':'apartment',applicationsClosed:false,priceBasis:'advertised',
      ...(included===undefined?{}:{serviceCostsIncluded:included}),...(availableFrom?{availableFrom}:{}),...(energyLabel?{energyLabel}:{})}};
}

async function fetchHtml(url,transport,signal,pause,kind='search') {
  allowedUrl(url,kind);let response;
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
  const all=[],ids=new Set(),urls=new Set();let next=SEARCH_URL,total,pages=0;
  while(next) {
    if(++pages>20)throw new FundaError('PAGE_LIMIT');
    const page=parseSearch(await fetchHtml(next,transport,signal,pause),next);
    if(total!==undefined&&total!==page.total)throw new FundaError('SEARCH_COUNT_CHANGED');total=page.total;
    for(const card of page.cards) {
      if(ids.has(card.listing.externalId)||urls.has(card.listing.canonicalUrl))throw new FundaError('DUPLICATE_CARD');
      ids.add(card.listing.externalId);urls.add(card.listing.canonicalUrl);all.push(card);
    }
    next=page.next;
  }
  if(all.length!==total)throw new FundaError('INCOMPLETE_SEARCH');
  const candidates=all.filter(candidate);if(candidates.length>80)throw new FundaError('DETAIL_LIMIT');
  const listings=[];
  for(const card of candidates) {
    const listing=parseDetail(await fetchHtml(card.listing.canonicalUrl,transport,signal,pause,'detail'),card);
    if(listing)listings.push(listing);
  }
  return {listings,inspected:all.length,total,pages,details:candidates.length,available:listings.filter(x=>x.availabilityStatus==='available').length};
}
module.exports={SOURCE_ID,SEARCH_URL,FILTERS,FundaError,allowedUrl,parseCard,parseSearch,parseDetail,candidate,dutchDate,collect};
