import { z } from 'zod';
import type { ListingInput } from '../listings/listings.service';
export const SourceError: new (category: string, blocked?: boolean, retryAfterSeconds?: number) =>
  Error & { category: string; blocked: boolean; retryAfterSeconds: number } = require('../../scripts/funda-core.cjs').FundaError;
export const SOURCE_ID = 'gohome:groningen-homes';
const registry = require('../../scripts/search-settings.cjs');
export const SEARCH_URL = registry.queryUrl(SOURCE_ID, 'https://resident.gohome.io/zoeken/', registry.defaults(SOURCE_ID)) as string;
export const FILTERS = { city: 'Groningen', minRent: 500, maxRent: 1500 };
export const RUN_TIMEOUT_MS = 240000;
const API = 'https://qb4ubme4cj.execute-api.eu-central-1.amazonaws.com/prod//v1/public/property/';
type Settings = Record<string, number | null>;
const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const price = z.number().finite().positive().max(99999999);
const slug = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(500);
const area = z.string().regex(/^\d+(?:\.\d+)?$/).nullable();
const rooms = z.number().int().positive().max(999).nullable();
const cardSchema = z.object({propertyId:id,title:z.string().min(1).max(500),urlSlug:slug,location:z.literal('Groningen'),
  minimumRent:price,livingArea:area,nrOfRooms:rooms,isRented:z.boolean().nullable(),
  type:z.object({name:z.literal('Property')}),propertyCollectionDetails:z.null()});
const pageSchema = z.object({totalPropertiesCount:z.number().int().nonnegative().max(1500),properties:z.array(cardSchema).max(15)});
export type Card = z.infer<typeof cardSchema>;
const detailSchema = z.object({id,title:z.string().min(1).max(500),urlSlug:slug,isRented:z.boolean().nullable(),offerType:z.string(),
  type:z.object({name:z.literal('Property')}),propertyCollectionDetails:z.null(),
  propertyDetails:z.object({city:z.literal('Groningen'),country:z.enum(['Netherlands','Nederland']),type:z.string(),published:z.boolean().nullable(),
    minimumRent:price,streetAddress:z.string().min(1),streetNumber:z.number().int().positive(),additionalStreetNumber:z.string().nullable(),
    availableFromDate:z.string().nullable(),description:z.string()}),
  propertyFeatures:z.object({livingArea:area,noOfRooms:rooms}).nullable()});
function schema<T>(validator:z.ZodType<T>, value:unknown):T {
  const result=validator.safeParse(value);if(!result.success)throw new SourceError('STRUCTURE_CHANGED');return result.data;
}
export function searchBody(pageIndex=0,settings:Settings=registry.defaults(SOURCE_ID)) {
  registry.validate(SOURCE_ID,settings);
  if(!Number.isInteger(pageIndex)||pageIndex<0||pageIndex>=100)throw new SourceError('PAGE_LIMIT');
  return {teamId:1,pageIndex,pageSize:15,location:'Groningen',minPrice:settings.minRent,maxPrice:settings.maxRent};
}
export function parseSearch(value:unknown,settings:Settings=registry.defaults(SOURCE_ID)) {
  registry.validate(SOURCE_ID,settings);const result=schema(pageSchema,value);
  if(result.properties.some(x=>x.minimumRent<settings.minRent!||x.minimumRent>settings.maxRent!))throw new SourceError('SEARCH_FILTER_CHANGED');
  return result;
}
export function detailUrl(value:string) {
  if(!slug.safeParse(value).success)throw new SourceError('URL_NOT_ALLOWED');
  return 'https://resident.gohome.io/te-huur/'+value;
}
function numberArea(value:string|null) {
  if(value===null)return undefined;const n=Number(value);
  if(!Number.isFinite(n)||n<=0||n>999999)throw new SourceError('AREA_INVALID');return n;
}
function date(value:string|null) {
  if(value===null)return undefined;
  if(!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(Date.parse(value))||new Date(value).toISOString().slice(0,10)!==value)throw new SourceError('DATE_INVALID');
  return value;
}
export function parseDetail(value:unknown,card:Card):ListingInput|null {
  const d=schema(detailSchema,value),p=d.propertyDetails,f=d.propertyFeatures;
  if(d.id!==card.propertyId||d.urlSlug!==card.urlSlug||d.title!==card.title||p.minimumRent!==card.minimumRent||d.isRented!==card.isRented||
    (card.livingArea!==null&&f?.livingArea!=null&&Number(card.livingArea)!==Number(f.livingArea))||
    (card.nrOfRooms!==null&&f?.noOfRooms!=null&&card.nrOfRooms!==f.noOfRooms))throw new SourceError('DETAIL_MISMATCH');
  const description=p.description.replace(/<[^>]*>/g,' ').replace(/&nbsp;/g,' ').replace(/\s+/g,' ').trim();
  // Room counts and permission to share an entire apartment are not shared facilities.
  if(!['APARTMENT','STUDIO','HOUSE'].includes(p.type)||!description||
    /\b(studentenkamer|onzelfstandig|kamerhuur|room\s+for\s+rent)\b|(?:gedeelde|gezamenlijke|shared)\s+(?:keuken|badkamer|toilet|kitchen|bathroom|facilities)/i.test(description+' '+d.title))return null;
  const areaM2=numberArea(f?.livingArea??card.livingArea),availableFrom=date(p.availableFromDate);
  return {externalId:String(d.id),canonicalUrl:detailUrl(d.urlSlug),title:d.title,city:p.city,
    address:[p.streetAddress,p.streetNumber,p.additionalStreetNumber].filter(x=>x!==null&&x!=='').join(' '),
    rentPrice:p.minimumRent,...(areaM2===undefined?{}:{areaM2}),...(f?.noOfRooms??card.nrOfRooms?{rooms:(f?.noOfRooms??card.nrOfRooms)!}:{}),
    availabilityStatus:d.isRented===true||p.published===false||d.offerType!=='RENTAL'?'unavailable':d.isRented===false&&p.published===true?'available':'unknown',
    pricingDetails:{baseRent:false},
    ...(p.type==='HOUSE'?{}:{housingDetails:{propertyType:p.type==='STUDIO'?'studio':'apartment',priceBasis:'advertised',applicationsClosed:false,...(availableFrom?{availableFrom}:{})}})};
}
export type CollectOptions={settings?:Settings;transport?:typeof fetch;signal?:AbortSignal;pause?:(ms:number)=>Promise<void>};
export async function collect({settings=registry.defaults(SOURCE_ID),transport=fetch,signal=AbortSignal.timeout(RUN_TIMEOUT_MS),
  pause=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms))}:CollectOptions={}) {
  registry.validate(SOURCE_ID,settings);
  const request=async(endpoint:string,body?:ReturnType<typeof searchBody>)=>{
    // Endpoints are constructed locally; no URLs from API responses are fetched.
    if(endpoint!=='listProperties'&&!/^getPropertyBySlug\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(endpoint))throw new SourceError('URL_NOT_ALLOWED');
    let response:Response|undefined;
    for(let attempt=0;attempt<3;attempt++) {
      if(signal.aborted)throw new SourceError('RUN_TIMEOUT');
      try {response=await transport(API+endpoint,{method:body?'POST':'GET',redirect:'manual',signal,
        headers:{Accept:'application/json',...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});}
      catch {if(attempt===2||signal.aborted)throw new SourceError(signal.aborted?'RUN_TIMEOUT':'HTTP_TRANSPORT');await pause(1000);continue;}
      if(![502,503,504].includes(response.status)||attempt===2)break;
      await response.body?.cancel();await pause(1000);
    }
    if(!response)throw new SourceError('HTTP_TRANSPORT');
    if([401,403].includes(response.status))throw new SourceError('ACCESS_BLOCKED',true);
    if(response.status===429)throw new SourceError('RATE_LIMIT',false,900);
    if(!response.ok)throw new SourceError('HTTP_STATUS');
    if(!/application\/json/i.test(response.headers.get('content-type')??''))throw new SourceError('CONTENT_TYPE');
    const reader=response.body?.getReader();if(!reader)throw new SourceError('EMPTY_BODY');
    const chunks:Uint8Array[]=[];let size=0;
    try {while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;
      if(size>4*1024*1024){await reader.cancel();throw new SourceError('BODY_TOO_LARGE');}chunks.push(value);}}
    catch(e){if(e instanceof SourceError)throw e;throw new SourceError(signal.aborted?'RUN_TIMEOUT':'HTTP_TRANSPORT');}
    try{return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;}catch{throw new SourceError('INVALID_JSON');}
  };
  const cards:Card[]=[],ids=new Set<number>(),slugs=new Set<string>();let total:number|undefined,pages=1;
  for(let page=0;page<pages;page++) {
    if(page)await pause(250);
    const result=parseSearch(await request('listProperties',searchBody(page,settings)),settings);
    total??=result.totalPropertiesCount;pages=Math.max(1,Math.ceil(total/15));
    if(result.totalPropertiesCount!==total||result.properties.length!==Math.min(15,total-page*15))throw new SourceError('INCOMPLETE_SEARCH');
    for(const card of result.properties){if(ids.has(card.propertyId)||slugs.has(card.urlSlug))throw new SourceError('DUPLICATE_CARD');
      detailUrl(card.urlSlug);ids.add(card.propertyId);slugs.add(card.urlSlug);cards.push(card);}
  }
  if(cards.length!==total)throw new SourceError('INCOMPLETE_SEARCH');
  const listings:ListingInput[]=[];
  for(const card of cards){await pause(250);const item=parseDetail(await request('getPropertyBySlug/'+card.urlSlug),card);
    if(item&&registry.matches(settings,item,SOURCE_ID))listings.push(item);}
  return {listings,total:total!,inspected:cards.length,pages,available:listings.filter(x=>x.availabilityStatus==='available').length};
}
