'use strict';
const { FundaError } = require('./funda-core.cjs');
function createCore(settings) {
const SOURCE_ID = 'pararius:groningen-25km-homes';
const DEFAULT_SEARCH_URL = 'https://www.pararius.nl/huurwoningen/groningen/0-1500/straal-25';
const FILTERS = Object.freeze({city:'Groningen',radiusKm:25,minRent:0,maxRent:1500,types:['apartment','studio','house'],filtering:'pararius-search-and-server'});
// Preserve the user's search. Editable price/area constraints narrow it on the server.
const SEARCH_URL = DEFAULT_SEARCH_URL;
const registry = require('./search-settings.cjs');
const filters = registry.validate(SOURCE_ID, settings ?? registry.defaults(SOURCE_ID));
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
  if(url.protocol!=='https:'||url.hostname!=='www.pararius.nl'||url.port||url.username||url.password||url.search||url.hash)throw new FundaError('URL_NOT_ALLOWED');
  if(kind==='search') {
    if(!/^\/huurwoningen\/groningen\/0-1500\/straal-25(?:\/page-[1-9]\d*)?$/.test(url.pathname))throw new FundaError('SEARCH_FILTER_CHANGED');
  } else if(!/^\/(?:appartement|studio|huis|kamer)-te-huur\/[a-z0-9-]+\/[a-f0-9]{8}\/[a-z0-9-]+$/.test(url.pathname))throw new FundaError('URL_NOT_ALLOWED');
  return url.href;
}
const pageNumber = url => Number(new URL(url).pathname.match(/\/page-(\d+)$/)?.[1] ?? 1);
function guardPage(html) {
  const visible=text(html);
  if(/captcha|verify you are human|just a moment|even geduld\s*\.{0,3}|verifiëren dat onze bezoekers echte mensen zijn|unusual traffic|verifieer.{0,20}mens|bevestig.{0,20}mens/i.test(visible)||/id=["']challenge-form["']|window\._cf_chl_opt\s*=/.test(html))throw new FundaError('HUMAN_CHECK',true);
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
function classContent(html, name, tag='div') {
  const result=[]; let start, depth=0;
  for(const m of html.matchAll(new RegExp('<\\/?'+tag+'\\b[^>]*>','gi'))) {
    if(m[0].startsWith('</')) {
      if(start!==undefined&&--depth===0){result.push(text(html.slice(start,m.index)));start=undefined;}
    } else if(start!==undefined)depth++;
    else if((attributes(m[0]).class??'').split(/\s+/).includes(name)){start=m.index+m[0].length;depth=1;}
  }
  if(start!==undefined)throw new FundaError('HTML_TRUNCATED');
  return result;
}
function parseCard(html) {
  const heading=html.match(/<h3\b[^>]*>([\s\S]*?)<\/h3>/i);
  const links=[...(heading?.[1]??'').matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)];
  const title=heading?text(heading[1]):'';
  if(links.length!==1||!title||title.length>500)throw new FundaError('CARD_STRUCTURE_CHANGED');
  const canonicalUrl=allowedUrl(attributes(links[0][1]).href??'');
  const location=classContent(html,'listing-search-item__sub-title');
  const city=location.length===1?location[0].match(/^[1-9]\d{3}\s?[A-Z]{2}\s+(.+?)\s*\(/)?.[1]:undefined;
  const visible=text(html);
  // Base rent appears first on transparent-price cards; total rent is a separate badge.
  const prices=classContent(html,'listing-search-item__price');
  const price=prices.length===1?prices[0].match(/^(?:Kale huurprijs\s+)?€\s*([\d.]+(?:,\d{1,2})?)\s+per maand/):undefined;
  const rentPrice=price?Number(price[1].replace(/\./g,'').replace(',','.')):NaN;
  const area=visible.match(/\b(\d+(?:[.,]\d+)?)\s*m²/),rooms=visible.match(/\b(\d+)\s+kamers?\b/i);
  if(!city||city.length>200||!(rentPrice>0&&rentPrice<100000000)||!area||Number(area[1].replace(',','.'))<=0||Number(area[1].replace(',','.'))>999999||!rooms||Number(rooms[1])<1||Number(rooms[1])>999)throw new FundaError('CARD_METADATA_MISSING');
  const totals=classContent(html,'price-transparency-badge__total-price-value','span');
  if(totals.length>1)throw new FundaError('CARD_METADATA_MISSING');
  const totalMatch=totals[0]?.match(/^€\s*([\d.]+(?:,\d{1,2})?)\s+per maand$/);
  const totalRentPrice=totalMatch?Number(totalMatch[1].replace(/\./g,'').replace(',','.')):undefined;
  if(totals.length&&(!totalMatch||totalRentPrice<rentPrice||totalRentPrice>99999999))throw new FundaError('CARD_METADATA_MISSING');
  const labels=[...html.matchAll(/<span\b([^>]*)>([\s\S]*?)<\/span>/gi)].filter(m=>(attributes(m[1]).class??'').split(/\s+/).includes('listing-label')).map(m=>text(m[2]).toLowerCase());
  const unavailable=labels.some(x=>/verhuurd|onder optie|gereserveerd/.test(x));
  const unknown=labels.some(x=>!['nieuw'].includes(x)&&!/verhuurd|onder optie|gereserveerd/.test(x));
  // Unlabelled cards are active rental offers; Nieuw is only a freshness badge.
  return {externalId:new URL(canonicalUrl).pathname.split('/')[3],canonicalUrl,title,city,
    rentPrice,pricingDetails:{baseRent:prices[0].startsWith('Kale huurprijs '),...(totalRentPrice===undefined?{}:{totalRentPrice})},areaM2:Number(area[1].replace(',','.')),rooms:Number(rooms[1]),
    availabilityStatus:unavailable?'unavailable':unknown?'unknown':'available'};
}
function filterError(field, actual) {
  const error=new FundaError('SEARCH_FILTER_CHANGED');
  // Only fixed field names and numeric filter values, never raw HTML, cookies or URLs.
  error.diagnostic={field,actual};
  return error;
}
function selectedValues(html, name) {
  return [...html.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/gi)]
    .filter(m=>attributes(m[1]).name===name).map(m=>{
      if(/\smultiple(?:\s|=|$)/i.test(m[1]))throw filterError(name+'-multiple','unexpected');
      const selected=[...m[2].matchAll(/<option\b([^>]*)>[\s\S]*?<\/option>/gi)].filter(o=>/\sselected(?:\s|=|$)/i.test(o[1]));
      if(!selected.length)throw filterError(name+'-selected-count',0);
      // HTML single-select reset rules keep the last selected option. Pararius
      // renders both its default radius and the requested radius as selected.
      return attributes(selected.at(-1)[1]).value;
    });
}
function parseSearch(html,currentUrl=SEARCH_URL) {
  guardPage(html);allowedUrl(currentUrl,'search');
  const heading=html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
  if(!heading||text(heading[1])!=='Huurwoningen Groningen')throw filterError('heading',heading?'unexpected':'missing');
  for(const [name,value] of [['filters[price][min]',''],['filters[price][max]','1500'],['filters[radius][value]','25']]) {
    const values=selectedValues(html,name);
    if(!values.length||values.some(v=>v!==value))throw filterError(name,values.map(v=>/^\d{0,8}$/.test(v??'')?v:'unexpected'));
  }
  const counts=classContent(html,'search-list-header__count','span');
  if(counts.length!==1||!/^\d+(?:\.\d{3})*$/.test(counts[0]))throw new FundaError('SEARCH_COUNT_MISSING');
  const total=Number(counts[0].replace(/\./g,''));
  // A real zero-result page has not yet been observed; fail closed.
  if(!total)throw new FundaError('EMPTY_SEARCH_UNCONFIRMED');
  const listings=cardSections(html).map(parseCard);
  if(new Set(listings.map(x=>x.canonicalUrl)).size!==listings.length||new Set(listings.map(x=>x.externalId)).size!==listings.length)throw new FundaError('DUPLICATE_CARD');
  const page=pageNumber(currentUrl),pages=Math.ceil(total/30);
  if(page>pages||listings.length!==Math.min(30,total-(page-1)*30))throw new FundaError('SEARCH_COUNT_MISMATCH');
  if(listings.some(x=>x.rentPrice>1500))throw filterError('card-price',Math.max(...listings.map(x=>x.rentPrice)));
  let next;
  for(const match of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const attr=attributes(match[1]);
    if((attr.class??'').split(/\s+/).includes('pagination__link--next')) {
      if(next)throw new FundaError('PAGINATION_AMBIGUOUS');
      next=allowedUrl(attr.href??'','search');
    }
  }
  if(page<pages?(!next||pageNumber(next)!==page+1):next)throw new FundaError('PAGINATION_NOT_ADVANCING');
  return {listings,total,next};
}
function candidate(item) {
  return /^\/(?:appartement|studio|huis)-te-huur\//.test(new URL(item.canonicalUrl).pathname)&&registry.matches(filters,item,SOURCE_ID);
}
async function fetchHtml(url,signal,transport,pause) {
  allowedUrl(url,'search');let response;
  for(let attempt=0;attempt<3;attempt++) {
    if(signal.aborted)throw new FundaError('RUN_TIMEOUT');
    try{response=await transport(url,{redirect:'manual',signal,headers:{Accept:'text/html','Accept-Language':'nl-NL'}})}catch(error){
      if(error instanceof FundaError)throw error;
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
async function collect({settings,transport=fetch,maxPages=20,maxListings=600,signal=AbortSignal.timeout(120000),pause=ms=>new Promise(r=>setTimeout(r,ms)),onPage=()=>{}}={}) {
  if (settings) return createCore(settings).collect({transport,maxPages,maxListings,signal,pause,onPage});
  const listings=new Map(),pages=new Set();let url=SEARCH_URL,total;
  while(url) {
    if(signal.aborted)throw new FundaError('RUN_TIMEOUT');
    if(pages.has(url)||pages.size>=maxPages)throw new FundaError('PAGINATION_LIMIT');
    pages.add(url);const page=parseSearch(await fetchHtml(url,signal,transport,pause),url);
    if(total!==undefined&&total!==page.total)throw new FundaError('SEARCH_CHANGED_DURING_RUN');total=page.total;
    if(total>maxListings)throw new FundaError('LISTING_LIMIT');
    for(const item of page.listings){if(listings.has(item.canonicalUrl)||[...listings.values()].some(x=>x.externalId===item.externalId))throw new FundaError('PAGINATION_NOT_ADVANCING');listings.set(item.canonicalUrl,item)}
    if(listings.size>maxListings||listings.size>total)throw new FundaError('SEARCH_COUNT_MISMATCH');
    onPage({page:pages.size,found:page.listings.length,total,accumulated:listings.size});
    url=page.next;if(url) {
      const current=Number(pageNumber([...pages].at(-1)));
      if(Number(pageNumber(url))!==current+1)throw new FundaError('PAGINATION_NOT_ADVANCING');
      await pause(5000);
    }
  }
  if(listings.size!==total)throw new FundaError('INCOMPLETE_SEARCH');
  return {listings:[...listings.values()].filter(candidate),inspected:listings.size,pages:pages.size};
}
return {SOURCE_ID,SEARCH_URL,FILTERS,FundaError,allowedUrl,parseSearch,parseCard,candidate,collect};

}
module.exports = { ...createCore(), createCore };
