import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { BrowserManager } from '../src/core/browser.mjs';

const endpoint='http://127.0.0.1:9223';
const wanted='https://www.tradingview.com/chart/Copied01/';
function fixture({desktop=true,versionPatch={},newCount=1,wrongUrl=false,throwAfterOpen=false,existingCopy=false}={}){
  const traffic=[],opens=[];
  const row=(id,url)=>({id,type:'page',url,title:'Fixture',webSocketDebuggerUrl:`ws://127.0.0.1:9223/devtools/page/${id}`});
  let targets=[row('source','https://www.tradingview.com/chart/Source01/'),row('other','https://www.tradingview.com/chart/Other001/')];
  if(existingCopy)targets.push(row('existing-copy',wanted));
  const version={Browser:desktop?'Chrome/156':'Chrome/155','User-Agent':desktop?'TradingView/3.5.1 TVDesktop/3.5.1':'Chrome/155',webSocketDebuggerUrl:'ws://127.0.0.1:9223/devtools/browser/desktop',...versionPatch};
  const context=vm.createContext({URL,Headers,location:new URL(targets[0].url),fetch:async()=>new Response('{}')});
  context.window=context;
  context.open=(url,target)=>{
    opens.push({url,target});
    for(let i=0;i<newCount;i++)targets.push(row(`new-${i}`,wrongUrl?'https://www.tradingview.com/chart/Another1/':url));
    if(throwAfterOpen)throw new Error('submitted before renderer acknowledgement');
  };
  class Socket extends EventTarget{
    constructor(url){super();this.url=url;this.readyState=0;queueMicrotask(()=>{this.readyState=1;this.dispatchEvent(new Event('open'));});}
    send(raw){const m=JSON.parse(raw);traffic.push({kind:'cdp',method:m.method,url:this.url});
      let result;
      try{result={result:{type:'object',value:vm.runInContext(m.params.expression,context)}};}
      catch(e){result={exceptionDetails:{text:'Uncaught',exception:{description:String(e)}}};}
      Promise.resolve(result.result?.value).then(value=>{
        if(result.result)result.result.value=value;
        this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({id:m.id,result})}));
      },e=>this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({id:m.id,result:{exceptionDetails:{text:'Uncaught',exception:{description:String(e)}}}})})));
    }
    close(){this.readyState=3;this.dispatchEvent(new Event('close'));}
  }
  const browser=new BrowserManager({endpoint,WebSocketImpl:Socket,fetchImpl:async(url,options)=>{
    const u=new URL(url);traffic.push({kind:'http',path:u.pathname,method:options.method});
    if(u.pathname==='/json/version')return Response.json(version);
    if(u.pathname==='/json/list')return Response.json(targets);
    if(u.pathname==='/json/new')return Response.json(row('chrome-new',decodeURIComponent(u.search.slice(1))));
    throw new Error('Unexpected fixture request');
  }});
  return {browser,traffic,opens,getTargets:()=>targets};
}

test('Desktop opens one verified new native tab from the exact source without /json/new',async()=>{
  const f=fixture({existingCopy:true});
  try{
    const result=await f.browser.openTarget(wanted,{sourceTargetId:'source'});
    assert.equal(result.id,'new-0');assert.equal(result.verified,true);assert.equal(result.opened_via,'desktop_native_window_open');
    assert.deepEqual(f.opens,[{url:wanted,target:'_blank'}]);
    assert.equal(f.traffic.some(x=>x.path==='/json/new'),false);
    assert.ok(f.traffic.filter(x=>x.kind==='cdp').every(x=>x.method==='Runtime.evaluate'&&x.url.endsWith('/source')));
    assert.equal(f.traffic.some(x=>x.path?.startsWith('/json/close')||x.path?.startsWith('/json/activate')),false);
  }finally{await f.browser.close();}
});

test('Desktop identity probe returns a fresh boolean without opening a tab',async()=>{
  for(const desktop of [true,false]){
    const f=fixture({desktop});
    try{
      assert.equal(await f.browser.isDesktop(),desktop);assert.equal(await f.browser.isDesktop(),desktop);
      assert.equal(f.opens.length,0);assert.equal(f.traffic.length,2);
      assert.ok(f.traffic.every(item=>item.path==='/json/version'));
    }finally{await f.browser.close();}
  }
});

test('Desktop identity probe refuses partial vendor identity and changed debugger origin',async()=>{
  for(const versionPatch of [{'User-Agent':'TVDesktop/3.5.1'},{'User-Agent':'TradingView/3.5.1'},{webSocketDebuggerUrl:'ws://127.0.0.1:9222/devtools/browser/desktop'}]){
    const f=fixture({versionPatch});
    try{await assert.rejects(f.browser.isDesktop(),e=>['DESKTOP_IDENTITY_UNVERIFIED','UNSAFE_DEBUGGER_URL'].includes(e.code));assert.equal(f.opens.length,0);}
    finally{await f.browser.close();}
  }
});

test('Desktop reconciles a lost renderer acknowledgement without submitting a second open',async()=>{
  const f=fixture({throwAfterOpen:true});
  try{assert.equal((await f.browser.openTarget(wanted,{sourceTargetId:'source'})).id,'new-0');assert.equal(f.opens.length,1);}
  finally{await f.browser.close();}
});

test('Desktop refuses a missing or unavailable exact source target before opening',async()=>{
  const f=fixture();
  try{
    await assert.rejects(f.browser.openTarget(wanted),e=>e.code==='SOURCE_TARGET_REQUIRED');
    await assert.rejects(f.browser.openTarget(wanted,{sourceTargetId:'missing'}),e=>e.code==='TARGET_NOT_FOUND');
    assert.equal(f.opens.length,0);assert.equal(f.traffic.some(x=>x.path==='/json/new'),false);
  }finally{await f.browser.close();}
});

test('Desktop requires both vendor tokens and a same-loopback debugger identity',async()=>{
  for(const versionPatch of [{'User-Agent':'TVDesktop/3.5.1'},{webSocketDebuggerUrl:'ws://10.0.0.1:9223/devtools/browser/desktop'}]){
    const f=fixture({versionPatch});
    try{await assert.rejects(f.browser.openTarget(wanted,{sourceTargetId:'source'}),e=>['DESKTOP_IDENTITY_UNVERIFIED','UNSAFE_DEBUGGER_URL'].includes(e.code));assert.equal(f.opens.length,0);assert.equal(f.traffic.some(x=>x.path==='/json/new'),false);}
    finally{await f.browser.close();}
  }
});

test('Desktop fails closed on multiple new targets and never closes one automatically',async()=>{
  const f=fixture({newCount:2});
  try{await assert.rejects(f.browser.openTarget(wanted,{sourceTargetId:'source'}),e=>e.code==='TAB_CREATE_AMBIGUOUS'&&e.details.mutation_attempted===true);assert.equal(f.opens.length,1);assert.equal(f.getTargets().length,4);assert.equal(f.traffic.some(x=>x.path?.startsWith('/json/close')),false);}
  finally{await f.browser.close();}
});

test('Desktop refuses a wrong or absent new target instead of reusing a preexisting match',async()=>{
  for(const options of [{wrongUrl:true},{newCount:0,existingCopy:true}]){
    const f=fixture(options);
    try{await assert.rejects(f.browser.openTarget(wanted,{sourceTargetId:'source',timeoutMs:100}),e=>e.code==='TAB_CREATE_UNVERIFIED'&&e.details.mutation_attempted===true);assert.equal(f.opens.length,1);}
    finally{await f.browser.close();}
  }
});

test('Chrome keeps the discovery PUT path and does not invoke a renderer opener',async()=>{
  const f=fixture({desktop:false});
  try{assert.equal((await f.browser.openTarget(wanted)).id,'chrome-new');assert.equal(f.opens.length,0);assert.ok(f.traffic.some(x=>x.path==='/json/new'&&x.method==='PUT'));}
  finally{await f.browser.close();}
});

test('Tab opening rejects non-TradingView URLs before discovery or mutation',async()=>{
  const f=fixture();
  try{await assert.rejects(f.browser.openTarget('https://example.com/chart/'),e=>e.code==='UNSAFE_ORIGIN');assert.equal(f.traffic.length,0);assert.equal(f.opens.length,0);}
  finally{await f.browser.close();}
});
