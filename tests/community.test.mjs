import test from 'node:test';
import assert from 'node:assert/strict';
import {PublicCommunityClient,CommunityRequestLimiter,communitySearchRequest,parseCommunitySearch} from '../src/core/public-community.mjs';
import tools from '../src/features/community.mjs';
const item={script_id_part:'PUB;abc123',name:'Test',user:{username:'Author'},script_type:'strategy',script_access:1,version:'2',chart_url:'https://www.tradingview.com/script/abcd1234/',description:'A script',likes_count:1};
const feed=items=>({data:{ideas:{data:{items,total:items.length,next:null}}}});
const response=body=>new Response(JSON.stringify(body),{status:200,headers:{'content-type':'application/json'}});
const client=options=>new PublicCommunityClient({...options,limiter:new CommunityRequestLimiter({minIntervalMs:1,cooldownMs:10})});

test('topic search builds only fixed public destinations and bounded pagination',()=>{
 const r=communitySearchRequest({topic:' Trend Following ',type:'strategies',page:2,limit:3});assert.equal(new URL(r.url).pathname,'/scripts/trend-following/page-2/');assert.equal(new URL(r.url).searchParams.get('script_access'),'open');
 for(const args of [{page:51},{limit:25},{topic:'привет'},{type:'private'},{topic:'a'.repeat(101)}])assert.throws(()=>communitySearchRequest(args),e=>e.code==='INVALID_COMMUNITY_REQUEST');
});
test('community output filters protected scripts and limits untrusted text/destinations',()=>{
 const r=parseCommunitySearch(feed([{...item,script_access:2},{...item,description:'x'.repeat(1000),chart_url:'https://evil.test/x'}]),communitySearchRequest({limit:1}));assert.equal(r.returned,1);assert.equal(r.filtered_non_open,1);assert.equal(r.items[0].description.length,500);assert.equal(r.items[0].chart_url,null);assert.equal(r.untrusted_content,true);
});
test('community parser rejects malformed identities and duplicate scripts',()=>{
 assert.throws(()=>parseCommunitySearch(feed([{...item,script_id_part:'USER;private'}]),communitySearchRequest()),e=>e.code==='COMMUNITY_RESPONSE_SHAPE');assert.throws(()=>parseCommunitySearch(feed([item,item]),communitySearchRequest()),e=>e.code==='COMMUNITY_RESPONSE_SHAPE');assert.throws(()=>parseCommunitySearch({},communitySearchRequest()),e=>e.code==='COMMUNITY_RESPONSE_SHAPE');
});
test('public requests omit credentials, refuse redirects and do not accept caller destinations',async()=>{
 let options,url;const c=client({fetchImpl:async(u,o)=>{url=u;options=o;return response(feed([item]));}});const r=await c.search({topic:'trend'});assert.equal(r.returned,1);assert.equal(options.credentials,'omit');assert.equal(options.redirect,'error');assert.equal(options.method,'GET');assert.equal(new URL(url).origin,'https://www.tradingview.com');await assert.rejects(c.request('http://127.0.0.1:1/'),e=>e.code==='INVALID_COMMUNITY_REQUEST');
});
test('public source is PUB-only, exact-version and refuses protected responses',async()=>{
 const c=client({fetchImpl:async()=>response({source:'plot(close)',scriptName:'Test',scriptAccess:'open_no_auth',version:'2.0'})});const r=await c.source({script_id:'PUB;abc',version:'2'});assert.equal(r.version,'2.0');assert.equal(r.source_sha256.length,64);await assert.rejects(c.source({script_id:'USER;private',version:'2'}),e=>e.code==='INVALID_COMMUNITY_REQUEST');
 for(const p of [{source:'secret',scriptAccess:'protected',version:'2'},{success:false},{source:'x',scriptAccess:'open_no_auth',version:'3'}]){const bad=client({fetchImpl:async()=>response(p)});await assert.rejects(bad.source({script_id:'PUB;abc',version:'2'}));}
});
test('public client enforces response bytes, cancellation and HTTP status',async()=>{
 const huge=client({maxBytes:128,fetchImpl:async()=>response({padding:'x'.repeat(300)})});await assert.rejects(huge.search(),e=>e.code==='COMMUNITY_RESPONSE_LIMIT');
 const fail=client({fetchImpl:async()=>new Response('',{status:429})});await assert.rejects(fail.search(),e=>e.code==='COMMUNITY_RATE_LIMITED'&&e.details.status===429);
 const controller=new AbortController();controller.abort();await assert.rejects(fail.search({},{signal:controller.signal}),e=>e.code==='CANCELLED');
});
test('community tools are read-only and work without a browser target',async()=>{assert.equal(tools.length,2);for(const t of tools){assert.equal(t.scope,'local');assert.equal(t.mutates,false);assert.equal(t.publicNetwork,true);}const r=await tools[0].handler({topic:'x'},{publicCommunity:{search:async a=>({topic:a.topic})}});assert.equal(r.topic,'x');});

test('search and source share sequential pacing, including different clients',async()=>{
 const limiter=new CommunityRequestLimiter({minIntervalMs:20,cooldownMs:30}),starts=[];let active=0,maxActive=0;
 const fetchImpl=async url=>{starts.push(Date.now());active++;maxActive=Math.max(maxActive,active);await new Promise(r=>setTimeout(r,3));active--;return response(url.includes('pine-facade')?{source:'plot(close)',scriptAccess:'open_no_auth',version:'2'}:feed([item]));};
 const a=new PublicCommunityClient({fetchImpl,limiter}),b=new PublicCommunityClient({fetchImpl,limiter});await Promise.all([a.search(),b.source({script_id:'PUB;abc',version:'2'}),a.search()]);assert.equal(maxActive,1);assert.equal(starts.length,3);assert.ok(starts[1]-starts[0]>=18);assert.ok(starts[2]-starts[1]>=18);
});
test('default clients share one process-wide limiter',()=>{const a=new PublicCommunityClient(),b=new PublicCommunityClient();assert.equal(a.limiter,b.limiter);assert.equal(a.limiter.minIntervalMs,1000);});
test('queue is bounded and an aborted queued call returns promptly without dispatch',async()=>{
 const limiter=new CommunityRequestLimiter({minIntervalMs:1,maxQueue:2,cooldownMs:30});let release,calls=0;
 const gate=new Promise(r=>{release=r;});const c=new PublicCommunityClient({limiter,fetchImpl:async()=>{calls++;await gate;return response(feed([item]));}});
 const first=c.search();await Promise.resolve();const controller=new AbortController(),queued=c.search({},{signal:controller.signal});const rejected=assert.rejects(queued,e=>e.code==='CANCELLED');await assert.rejects(c.search(),e=>e.code==='COMMUNITY_QUEUE_FULL');controller.abort();await rejected;assert.equal(calls,1);release();await first;await limiter.tail;assert.equal(calls,1);assert.equal(limiter.pending,0);
});
for(const status of [429,403])test('HTTP '+status+' opens the shared cooldown circuit without retries',async()=>{
 const limiter=new CommunityRequestLimiter({minIntervalMs:1,cooldownMs:30});let calls=0;const fetchImpl=async()=>{calls++;return calls===1?new Response('',{status}):response(feed([item]));};const a=new PublicCommunityClient({limiter,fetchImpl}),b=new PublicCommunityClient({limiter,fetchImpl});
 const one=a.search(),two=b.search();await assert.rejects(one,e=>e.code==='COMMUNITY_RATE_LIMITED'&&e.details.status===status);await assert.rejects(two,e=>e.code==='COMMUNITY_RATE_LIMITED');assert.equal(calls,1);await assert.rejects(b.search(),e=>e.code==='COMMUNITY_RATE_LIMITED');assert.equal(calls,1);await new Promise(r=>setTimeout(r,35));assert.equal((await b.search()).returned,1);assert.equal(calls,2);
});
test('public source rejects an explicit mismatched returned script identity',async()=>{for(const key of ['scriptIdPart','script_id_part']){const c=client({fetchImpl:async()=>response({source:'plot(close)',scriptAccess:'open_no_auth',version:'2',[key]:'PUB;other'})});await assert.rejects(c.source({script_id:'PUB;abc',version:'2'}),e=>e.code==='COMMUNITY_RESPONSE_SHAPE');}});
