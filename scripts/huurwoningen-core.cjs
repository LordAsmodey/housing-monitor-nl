'use strict';
const { FundaError } = require('./funda-core.cjs');
const SOURCE_ID = 'huurwoningen:groningen-25km-within-3-months';
const SEARCH_URL = 'https://www.huurwoningen.com/in/groningen/?radius=25&available_from=within_3_months';
const FILTERS = Object.freeze({city:'Groningen',radiusKm:25,availableFrom:'within_3_months',filtering:'huurwoningen-search'});
function text(html) {
  return html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,'')
    .replace(/<[^>]*>/g,' ').replace(/&(?:nbsp|#160);/g,' ').replace(/&amp;/g,'&').replace(/&(?:euro|#8364);/g,'€')
    .replace(/&quot;/g,'"').replace(/&#39;|&apos;/g,"'").replace(/&sup2;/g,'²').replace(/\s+/g,' ').trim();
}
function attributes(tag) {
  return Object.fromEntries([...tag.matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map(m=>[m[1].toLowerCase(),m[2]??m[3]]));
}
function allowedUrl(value, kind='detail') {
  let url;try {url=new URL(value.replace(/&amp;/g,'&'),SEARCH_URL)}catch{throw new FundaError('INVALID_URL')}
  if(url.protocol!=='https:'||url.hostname!=='www.huurwoningen.com'||url.port||url.username||url.password)throw new FundaError('URL_NOT_ALLOWED');
  if(kind==='search') {
    if(url.pathname!=='/in/groningen/')throw new FundaError('URL_NOT_ALLOWED');
    const expected=new URL(SEARCH_URL);
    for(const key of ['radius','available_from'])if(url.searchParams.getAll(key).length!==1||url.searchParams.get(key)!==expected.searchParams.get(key))throw new FundaError('SEARCH_FILTER_CHANGED');
    for(const key of url.searchParams.keys())if(!['radius','available_from','page'].includes(key))throw new FundaError('SEARCH_FILTER_CHANGED');
    if(url.searchParams.has('page')&&(url.searchParams.getAll('page').length!==1||!/^([1-9]\d*)$/.test(url.searchParams.get('page'))))throw new FundaError('INVALID_PAGE');
    url.search=new URLSearchParams({radius:'25',available_from:'within_3_months',...(url.searchParams.has('page')?{page:url.searchParams.get('page')}:{})}).toString();
  } else {
    if(!/^\/huren\/[^/]+\/[a-f0-9]{8}\/[^/]+\/$/.test(url.pathname))throw new FundaError('URL_NOT_ALLOWED');
    url.search='';
  }
  url.hash='';return url.href;
}
function guardPage(html) {
  const visible=text(html);
  if(/captcha|verify you are human|just a moment|unusual traffic|verifieer.{0,20}mens|bevestig.{0,20}mens/i.test(visible))throw new FundaError('HUMAN_CHECK',true);
  if(/access denied|forbidden/i.test(visible))throw new FundaError('ACCESS_BLOCKED',true);
}
// Scan balanced sections: nested feature lists must not cut a card short.
function cardSections(html) {
  const cards=[];let depth=0,start;
  for(const match of html.matchAll(/<\/?section\b[^>]*>/gi)) {
    if(/^<\/section/i.test(match[0])) {
      if(start!==undefined&&--depth===0){cards.push(html.slice(start,match.index+match[0].length));start=undefined;}
    } else if(start!==undefined)depth++;
    else if((attributes(match[0]).class??'').split(/\s+/).includes('listing-search-item')){start=match.index;depth=1;}
  }
  if(start!==undefined)throw new FundaError('CARD_STRUCTURE_CHANGED');
  return cards;
}
function parseCard(html) {
  const heading=html.match(/<h[23]\b[^>]*>([\s\S]*?)<\/h[23]>/i);
  const link=heading?.[1].match(/<a\b([^>]*)>([\s\S]*?)<\/a>/i);
  const title=heading?text(heading[1]):'';
  if(!link||!title||title.length>500)throw new FundaError('CARD_STRUCTURE_CHANGED');
  const canonicalUrl=allowedUrl(attributes(link[1]).href??'');
  const visible=text(html), city=visible.match(/\b[1-9]\d{3}\s?[A-Z]{2}\s+(.+?)\s*\(/)?.[1];
  const price=visible.match(/€\s*([\d.]+(?:,\d{1,2})?)\s+per maand/i);
  const rentPrice=price?Number(price[1].replace(/\./g,'').replace(',','.')):NaN;
  const priceOnRequest=/^Prijs op aanvraag$/i.test(text(html.match(/<span\b[^>]*class="listing-search-item__price-main"[^>]*>([\s\S]*?)<\/span>/i)?.[1]??''));
  if(!city||city.length>200||(!priceOnRequest&&!(rentPrice>0&&rentPrice<100000000))) {
    const error=new FundaError('CARD_METADATA_MISSING');
    error.diagnostic={title:title.slice(0,200),location:text(html.match(/<div\b[^>]*class="listing-search-item__sub-title"[^>]*>([\s\S]*?)<\/div>/i)?.[1]??'').slice(0,200),
      price:text(html.match(/<span\b[^>]*class="listing-search-item__price-main"[^>]*>([\s\S]*?)<\/span>/i)?.[1]??'').slice(0,100)};
    throw error;
  }
  const area=visible.match(/\b(\d+(?:[.,]\d+)?)\s*m²/),rooms=visible.match(/\b(\d+)\s+kamers?\b/i);
  // The selected search includes rooms, studios, houses and woningruil; retain them.
  return {externalId:new URL(canonicalUrl).pathname.split('/')[3],canonicalUrl,title,city,...(!priceOnRequest?{rentPrice}:{}),availabilityStatus:'unknown',
    ...(area?{areaM2:Number(area[1].replace(',','.'))}:{}),...(rooms?{rooms:Number(rooms[1])}:{})};
}
function parseSearch(html,currentUrl=SEARCH_URL) {
  guardPage(html);allowedUrl(currentUrl,'search');
  const visible=text(html);
  // Confirm the rendered page retained both selected filters, rather than trusting the requested URL alone.
  const heading=html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
  if(!heading||!/huurwoningen in een straal van 25\s*km van Groningen/i.test(text(heading[1]))||!/Binnen 3 maanden/i.test(visible))throw new FundaError('SEARCH_FILTER_CHANGED');
  const count=visible.match(/\b([\d.]+)\s+Huurwoningen in een straal van 25\s*km van Groningen/i);
  if(!count)throw new FundaError('SEARCH_COUNT_MISSING');
  const total=Number(count[1].replace(/\./g,''));
  const listings=cardSections(html).map(parseCard);
  const urls=new Set(listings.map(x=>x.canonicalUrl));
  if(urls.size!==listings.length)throw new FundaError('DUPLICATE_CARD');
  if((total===0&&listings.length)||(!listings.length&&total>0))throw new FundaError('SEARCH_COUNT_MISMATCH');
  let next;
  for(const match of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const attr=attributes(match[1]);
    if(/^(Volgende|Next)$/i.test(text(match[2]))||(attr.rel??'').split(' ').includes('next')) {
      if(next)throw new FundaError('PAGINATION_AMBIGUOUS');
      next=allowedUrl(new URL((attr.href??'').replace(/&amp;/g,'&'),currentUrl).href,'search');
    }
  }
  return {listings,total,next};
}
async function fetchHtml(url,signal,transport,pause) {
  allowedUrl(url,'search');let response;
  for(let attempt=0;attempt<3;attempt++) {
    if(signal.aborted)throw new FundaError('RUN_TIMEOUT');
    try{response=await transport(url,{redirect:'manual',signal,headers:{Accept:'text/html','Accept-Language':'nl-NL'}})}catch{
      if(attempt===2||signal.aborted)throw new FundaError(signal.aborted?'RUN_TIMEOUT':'HTTP_TRANSPORT');
      await pause(2000);continue;
    }
    if(![502,503,504].includes(response.status)||attempt===2)break;
    await response.body?.cancel();await pause(2000);
  }
  if([401,403].includes(response.status))throw new FundaError('ACCESS_BLOCKED',true);
  if(response.status===429)throw new FundaError('RATE_LIMIT',false,900);
  if(response.status>=300&&response.status<400)throw new FundaError('UNEXPECTED_REDIRECT');
  if(!response.ok)throw new FundaError('HTTP_STATUS');
  if(!/text\/html/i.test(response.headers.get('content-type')??''))throw new FundaError('CONTENT_TYPE');
  const reader=response.body?.getReader();if(!reader)throw new FundaError('EMPTY_BODY');
  const chunks=[];let size=0;
  try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>5*1024*1024){await reader.cancel();throw new FundaError('BODY_TOO_LARGE')}chunks.push(value)}}catch(e){if(e instanceof FundaError)throw e;throw new FundaError('HTTP_TRANSPORT')}
  return Buffer.concat(chunks).toString('utf8');
}
async function collect({transport=fetch,maxPages=20,maxListings=600,signal=AbortSignal.timeout(120000),pause=ms=>new Promise(r=>setTimeout(r,ms)),onPage=()=>{}}={}) {
  const listings=new Map(),pages=new Set();let url=SEARCH_URL,total;
  while(url) {
    if(signal.aborted)throw new FundaError('RUN_TIMEOUT');
    if(pages.has(url)||pages.size>=maxPages)throw new FundaError('PAGINATION_LIMIT');
    pages.add(url);const page=parseSearch(await fetchHtml(url,signal,transport,pause),url);
    if(total!==undefined&&total!==page.total)throw new FundaError('SEARCH_CHANGED_DURING_RUN');total=page.total;
    if(total>maxListings)throw new FundaError('LISTING_LIMIT');
    for(const item of page.listings){if(listings.has(item.canonicalUrl))throw new FundaError('PAGINATION_NOT_ADVANCING');listings.set(item.canonicalUrl,item)}
    if(listings.size>maxListings||listings.size>total)throw new FundaError('SEARCH_COUNT_MISMATCH');
    onPage({page:pages.size,found:page.listings.length,total,accumulated:listings.size});
    url=page.next;if(url) {
      const current=Number(new URL([...pages].at(-1)).searchParams.get('page')??1);
      if(Number(new URL(url).searchParams.get('page')??1)!==current+1)throw new FundaError('PAGINATION_NOT_ADVANCING');
      await pause(1000);
    }
  }
  if(listings.size!==total)throw new FundaError('INCOMPLETE_SEARCH');
  return {listings:[...listings.values()],inspected:listings.size,pages:pages.size};
}
module.exports={SOURCE_ID,SEARCH_URL,FILTERS,FundaError,allowedUrl,parseSearch,parseCard,collect};
