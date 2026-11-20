import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { ToolError } from './errors.mjs';
const ORIGIN='https://www.tradingview.com';
const FACADE='https://pine-facade.tradingview.com';
const TYPES=Object.freeze(['all','indicators','strategies','libraries']);
export { TYPES as COMMUNITY_TYPES };
const invalid=message=>{throw new ToolError('INVALID_COMMUNITY_REQUEST',message);};
const bounded=(value,max)=>typeof value==='string'?value.slice(0,max):null;
const versionKey=v=>String(v).replace(/(?:\.0)+$/,'');
const cancelled=()=>new ToolError('CANCELLED','Community request cancelled.');
function abortable(promise,signal) {
  if(!signal)return promise;
  if(signal.aborted)return Promise.reject(cancelled());
  return new Promise((resolve,reject)=>{
    const onAbort=()=>reject(cancelled());signal.addEventListener('abort',onAbort,{once:true});
    promise.then(resolve,reject).finally(()=>signal.removeEventListener('abort',onAbort));
  });
}

/** One process-wide queue serves both public hosts and all client instances. */
export class CommunityRequestLimiter {
  constructor({minIntervalMs=1000,maxQueue=8,cooldownMs=60000}={}) {
    if(!Number.isInteger(minIntervalMs)||minIntervalMs<1||minIntervalMs>10000||!Number.isInteger(maxQueue)||maxQueue<1||maxQueue>32||!Number.isInteger(cooldownMs)||cooldownMs<1||cooldownMs>300000)invalid('Invalid internal community rate limits.');
    this.minIntervalMs=minIntervalMs;this.maxQueue=maxQueue;this.cooldownMs=cooldownMs;this.pending=0;this.nextStart=0;this.blockedUntil=0;this.tail=Promise.resolve();
  }
  rateError(){return new ToolError('COMMUNITY_RATE_LIMITED','TradingView community requests are cooling down; no request was retried.',{retry_after_seconds:Math.max(1,Math.ceil((this.blockedUntil-Date.now())/1000))});}
  block(){this.blockedUntil=Math.max(this.blockedUntil,Date.now()+this.cooldownMs);}
  run(task,signal) {
    if(signal?.aborted)return Promise.reject(cancelled());
    if(this.blockedUntil>Date.now())return Promise.reject(this.rateError());
    if(this.pending>=this.maxQueue)return Promise.reject(new ToolError('COMMUNITY_QUEUE_FULL','Community request queue is full.'));
    this.pending++;
    const operation=this.tail.then(async()=>{
      if(signal?.aborted)throw cancelled();
      if(this.blockedUntil>Date.now())throw this.rateError();
      const delay=Math.max(0,this.nextStart-Date.now());
      if(delay)try{await sleep(delay,undefined,{signal});}catch{throw cancelled();}
      if(this.blockedUntil>Date.now())throw this.rateError();
      this.nextStart=Date.now()+this.minIntervalMs;
      return task();
    }).finally(()=>{this.pending--;});
    // Keep aborted callers in sequence until preceding work finishes; they never dispatch.
    this.tail=operation.catch(()=>{});
    return abortable(operation,signal);
  }
}
const sharedLimiter=new CommunityRequestLimiter();

export function communitySearchRequest({topic='',type='all',page=1,limit=20}={}) {
  if(typeof topic!=='string'||topic.length>100||!TYPES.includes(type)||!Number.isInteger(page)||page<1||page>50||!Number.isInteger(limit)||limit<1||limit>24)invalid('Use a topic up to 100 characters, a supported type, page 1–50 and limit 1–24.');
  const slug=topic.trim().toLowerCase().replace(/['’]/g,'').replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'');
  if(topic.trim()&&!slug)invalid('A topic must contain Latin letters or digits.');
  const url=new URL('/scripts/'+(slug?slug+'/':'')+(page>1?'page-'+page+'/':''),ORIGIN);
  url.searchParams.set('component-data-only','1');url.searchParams.set('script_access','open');url.searchParams.set('script_type',type);
  return {url:url.href,topic:slug||null,type,page,limit};
}
export function parseCommunitySearch(payload,request) {
  const feed=payload?.data?.ideas?.data;
  if(!feed||!Array.isArray(feed.items)||feed.items.length>100||!Number.isSafeInteger(feed.total)||feed.total<0)throw new ToolError('COMMUNITY_RESPONSE_SHAPE','TradingView community feed shape is unrecognised.');
  const open=feed.items.filter(row=>row?.script_access===1);
  const items=open.slice(0,request.limit).map(row=>{
    if(typeof row.script_id_part!=='string'||!/^PUB;[A-Za-z0-9]{1,128}$/.test(row.script_id_part)||typeof row.name!=='string'||!['indicator','strategy','library'].includes(row.script_type)||typeof row.version!=='string'||row.version.length>30||!/^\d+(?:\.\d+)*$/.test(row.version))throw new ToolError('COMMUNITY_RESPONSE_SHAPE','Community result identity or version is unrecognised.');
    let chart_url=null;
    if(typeof row.chart_url==='string')try{const u=new URL(row.chart_url);if(u.origin===ORIGIN&&/^\/script\/[A-Za-z0-9_-]+\/$/.test(u.pathname)&&!u.search&&!u.hash)chart_url=u.href;}catch{/* Do not return an untrusted destination. */}
    return {script_id:row.script_id_part,name:bounded(row.name,200),author:bounded(row.user?.username,100),type:row.script_type,version:row.version,open_source:true,chart_url,description:typeof row.description==='string'?bounded(row.description.replace(/\s+/g,' ').trim(),500):null,likes:Number.isSafeInteger(row.likes_count)&&row.likes_count>=0?row.likes_count:null};
  });
  if(new Set(items.map(row=>row.script_id)).size!==items.length)throw new ToolError('COMMUNITY_RESPONSE_SHAPE','Community feed returned duplicate script identities.');
  return {topic:request.topic,type:request.type,page:request.page,items,returned:items.length,total_count:feed.total,filtered_non_open:feed.items.length-open.length,has_more:!!feed.next,truncated:open.length>request.limit,source:'tradingview_public_community',search_semantics:'TradingView topic feed; not a full-text relevance search',credentials_used:false,untrusted_content:true,retrieved_at:new Date().toISOString()};
}
async function readBody(response,maxBytes) {
  const n=Number(response.headers?.get?.('content-length'));
  if(Number.isFinite(n)&&n>maxBytes){await response.body?.cancel?.();throw new ToolError('COMMUNITY_RESPONSE_LIMIT','Community response exceeded its byte limit.');}
  if(!response.body?.getReader)throw new ToolError('COMMUNITY_RESPONSE_SHAPE','Community response has no bounded readable body.');
  const reader=response.body.getReader(),parts=[];let size=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>maxBytes){await reader.cancel();throw new ToolError('COMMUNITY_RESPONSE_LIMIT','Community response exceeded its byte limit.');}parts.push(Buffer.from(value));}return Buffer.concat(parts).toString('utf8');}finally{reader.releaseLock();}
}
export class PublicCommunityClient {
  constructor({fetchImpl=globalThis.fetch,timeoutMs=15000,maxBytes=2*1024*1024,limiter=sharedLimiter}={}) {
    if(typeof fetchImpl!=='function'||!Number.isInteger(timeoutMs)||timeoutMs<100||timeoutMs>30000||!Number.isInteger(maxBytes)||maxBytes<128||maxBytes>4*1024*1024)invalid('Invalid internal community client limits.');
    if(!(limiter instanceof CommunityRequestLimiter))invalid('Invalid internal community limiter.');
    this.fetchImpl=fetchImpl;this.timeoutMs=timeoutMs;this.maxBytes=maxBytes;this.limiter=limiter;
  }
  async request(url,signal) {
    const u=new URL(url);
    const feed=u.origin===ORIGIN&&/^\/scripts\/(?:[a-z0-9-]+\/)?(?:page-\d+\/)?$/.test(u.pathname)&&u.searchParams.get('component-data-only')==='1'&&u.searchParams.get('script_access')==='open'&&TYPES.includes(u.searchParams.get('script_type'))&&[...u.searchParams.keys()].length===3;
    const source=u.origin===FACADE&&/^\/pine-facade\/get\/PUB%3B[A-Za-z0-9]{1,128}\/\d+(?:\.\d+)*$/.test(u.pathname)&&!u.search;
    if(u.username||u.password||u.hash||!(feed||source))invalid('Community request destination is not permitted.');
    if(signal?.aborted)throw new ToolError('CANCELLED','Community request cancelled.');
    return this.limiter.run(()=>this.#fetchResponse(url,signal),signal);
  }
  async #fetchResponse(url,signal) {
    let response;
    try{response=await this.fetchImpl(url,{method:'GET',credentials:'omit',redirect:'error',cache:'no-store',headers:{Accept:'application/json'},signal:signal?AbortSignal.any([signal,AbortSignal.timeout(this.timeoutMs)]):AbortSignal.timeout(this.timeoutMs)});}catch{throw new ToolError(signal?.aborted?'CANCELLED':'COMMUNITY_UNAVAILABLE','Credential-free TradingView community request failed.');}
    if(response.url&&response.url!==url)throw new ToolError('COMMUNITY_DESTINATION','Community response came from an unexpected destination.');
    if(response.status===429||response.status===403){this.limiter.block();try{await response.body?.cancel?.();}catch{/* Preserve the cooldown error. */}throw new ToolError('COMMUNITY_RATE_LIMITED','TradingView denied public requests; the shared queue is cooling down with no automatic retry.',{status:response.status,retry_after_seconds:Math.ceil(this.limiter.cooldownMs/1000)});}
    if(!response.ok)throw new ToolError('COMMUNITY_HTTP_ERROR','TradingView community request returned an unsuccessful status.',{status:response.status});
    let text;try{text=await readBody(response,this.maxBytes);}catch(e){if(e instanceof ToolError)throw e;throw new ToolError('COMMUNITY_UNAVAILABLE','Community response read failed.');}
    try{return JSON.parse(text);}catch{throw new ToolError('COMMUNITY_RESPONSE_SHAPE','Community response is not JSON.');}
  }
  async search(args={}, {signal}={}) {const request=communitySearchRequest(args);return parseCommunitySearch(await this.request(request.url,signal),request);}
  async source({script_id,version}={}, {signal}={}) {
    if(typeof script_id!=='string'||!/^PUB;[A-Za-z0-9]{1,128}$/.test(script_id)||typeof version!=='string'||version.length>30||!/^\d+(?:\.\d+)*$/.test(version))invalid('Use a public PUB script ID and explicit numeric version from a search result.');
    const url=FACADE+'/pine-facade/get/'+encodeURIComponent(script_id)+'/'+encodeURIComponent(version),p=await this.request(url,signal);
    if(p?.success===false||p?.scriptAccess!=='open_no_auth'||typeof p.source!=='string')throw new ToolError('COMMUNITY_SOURCE_UNAVAILABLE','TradingView did not return public open source. No authenticated fallback was attempted.');
    for(const key of ['scriptIdPart','script_id_part'])if(p[key]!==undefined&&p[key]!==script_id)throw new ToolError('COMMUNITY_RESPONSE_SHAPE','Public source identity differs from the request.');
    if(typeof p.version!=='string'||versionKey(p.version)!==versionKey(version)||p.source.length>1000000)throw new ToolError('COMMUNITY_RESPONSE_SHAPE','Public source version or size differs from the request.');
    return {script_id,version:p.version,name:bounded(p.scriptName,200),source:p.source,source_sha256:createHash('sha256').update(p.source,'utf8').digest('hex'),source_chars:p.source.length,credentials_used:false,untrusted_content:true,origin:'tradingview_public_pine_facade',retrieved_at:new Date().toISOString()};
  }
}
