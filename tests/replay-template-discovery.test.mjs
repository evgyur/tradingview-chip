import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { replayPage } from '../src/features/replay.mjs';
import { templatePage } from '../src/features/templates.mjs';
import { assertFixedFunction } from '../src/core/security.mjs';

function run(fn,window,args){
  const context=vm.createContext({window,args,setTimeout,clearTimeout,Date});
  return vm.runInContext(`(${fn.toString()})(args)`,context);
}
const replayApi=()=>({isReplayAvailable:()=>true,isReplayStarted:()=>false,isAutoplayStarted:()=>false});

test('replay lazily loads its native API with the host receiver and reads state without starting replay',async()=>{
  let calls=0;
  const host={_replayApi:null,async replayApi(){assert.equal(this,host);calls++;return this._replayApi=replayApi();}};
  const result=await run(replayPage,{TradingViewApi:host},{op:'status'});
  assert.equal(result.ok,true);assert.equal(result.available,true);assert.equal(result.started,false);assert.equal(calls,1);
});

test('an initialized replay API does not invoke the lazy loader',async()=>{
  const result=await run(replayPage,{TradingViewApi:{_replayApi:replayApi(),replayApi(){throw new Error('unnecessary load');}}},{op:'status'});
  assert.equal(result.ok,true);assert.equal(result.started,false);
});

test('replay supports a loader that populates the native cache without returning it',async()=>{
  const host={_replayApi:null,async replayApi(){this._replayApi=replayApi();}};
  const result=await run(replayPage,{TradingViewApi:host},{op:'status'});
  assert.equal(result.ok,true);assert.equal(result.started,false);
});

test('replay loader failure and malformed API fail closed before any operation',async()=>{
  const failed=await run(replayPage,{TradingViewApi:{async replayApi(){throw new Error('module unavailable');}}},{op:'start',time:1});
  assert.equal(failed.ok,false);assert.equal(failed.code,'CAPABILITY_UNAVAILABLE');assert.notEqual(failed.mutation_attempted,true);
  let starts=0;
  const malformed=await run(replayPage,{TradingViewApi:{async replayApi(){return {selectDate(){starts++;}};}}},{op:'start',time:1});
  assert.equal(malformed.ok,false);assert.equal(malformed.code,'ADAPTER_MISMATCH');assert.equal(starts,0);
});

function templateWindow(exportsList){
  return {TradingViewApi:{_activeChartWidgetWV:{value:()=>({})}},webpackChunktradingview:{push(parts){parts[2]({c:Object.fromEntries(exportsList.map((exports,i)=>[i,{exports}]))});}}};
}
const templateBackend=()=>({getStudyTemplatesList:async()=>[{id:'custom-1',name:'Test',meta_info:{indicators:[]}}],saveStudyTemplate:async()=>{throw new Error('unexpected save');}});

test('template discovery accepts a direct native backend export',async()=>{
  const result=await run(templatePage,templateWindow([templateBackend()]),{op:'list'});
  assert.equal(result.ok,true);assert.equal(result.total,1);assert.equal(result.templates[0].template_id,'custom-1');
});

test('template discovery deduplicates identical direct and wrapped backend exports',async()=>{
  const backend=templateBackend();backend.backend=backend;
  const result=await run(templatePage,templateWindow([backend,{backend}]),{op:'list'});
  assert.equal(result.ok,true);assert.equal(result.total,1);
});

test('template discovery rejects distinct matching backends instead of choosing one',async()=>{
  const result=await run(templatePage,templateWindow([templateBackend(),{backend:templateBackend()}]),{op:'list'});
  assert.equal(result.ok,false);assert.equal(result.code,'CAPABILITY_UNAVAILABLE');
});

test('replay and template discovery remain fixed page functions',()=>{
  assertFixedFunction(replayPage);assertFixedFunction(templatePage);
});
