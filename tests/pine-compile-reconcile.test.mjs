import test from 'node:test';
import assert from 'node:assert/strict';
import {guarded,sourceHash} from '../src/features/pine.mjs';
const source='//@version=6\nindicator("Test")\nplot(close)';
function fixture(change={}) {
 let after=false;
 const ctx={callPage:async(fn,a)=>{
  if(a.op==='get_source')return {ok:true,source,title:'Test'};
  if(a.op==='native_binding')return {ok:true,source,title:'Test',native_binding:{script_id:'USER;x',version:after?'2':'1',is_draft:false,is_modified:!after}};
  if(a.op==='chart_pine_versions')return {ok:true,matches:[{study_id:change.study && after?'other':'study',version:after?(change.stale?'1':'2'):'1'}]};
  if(a.op==='compile'){after=true;return {ok:false,code:'VERIFICATION_FAILED',message:'not confirmed',mutation_attempted:true,action:'Update on chart'};}
  if(a.op==='get_errors')return {ok:true,error_count:change.errors?1:0};
  if(a.op==='get_source'&&a.script_id)return {ok:true,source};
  throw new Error('Unexpected '+a.op);
 }};
 // Library and editor both use get_source; distinguish by script_id.
 const call=ctx.callPage;ctx.callPage=async(fn,a)=>a.op==='get_source'&&a.script_id?{ok:true,source:change.source?'different':source,version:'2'}:call(fn,a);
 return guarded('compile',{expected_title:'Test',expected_source_sha256:sourceHash(source)},ctx);
}
test('compile reconciles exact new source and version on the same study',async()=>{const r=await fixture();assert.equal(r.verified,true);assert.equal(r.version,'2');});
for(const key of ['study','stale','source','errors'])test('compile fails closed when '+key+' differs',async()=>{await assert.rejects(fixture({[key]:true}),e=>e.code==='VERIFICATION_FAILED');});
