import test from 'node:test';
import assert from 'node:assert/strict';
import {pinePage} from '../src/features/pine.mjs';
import {createFakeCdp} from './fake-cdp.mjs';
function fixture(t,{change=false,missingMarkers=false}={}) {
 let source='original',submitted=false;
 const box=()=>({width:100,height:100});
 const dom={isConnected:true,getBoundingClientRect:box,contains(x){return x===dom;},closest(){return root;}};
 const title={isConnected:true,getBoundingClientRect:box,textContent:'Test'};
 const button={isConnected:true,getBoundingClientRect:box,textContent:'Update on chart',disabled:false,getAttribute(){return null;},click(){submitted=true;if(change)source='changed';}};
 const root={querySelectorAll(s){return s==='button,[role="button"]'?[button]:[];}};
 const row={isConnected:true,getBoundingClientRect:box,textContent:'Script updated on chart'};
 const e={getDomNode:()=>dom,getValue:()=>source,getModel:()=>({uri:'x'})};
 const editor={getEditors:()=>[e]};if(!missingMarkers)editor.getModelMarkers=()=>[];
 const h=createFakeCdp({page:{monaco:{editor},document:{querySelectorAll(s){if(s==='.monaco-editor.pine-editor-monaco')return [dom];if(s==='[data-qa-id="pine-script-title-button"]')return [title];if(s.includes('consoleRow'))return submitted?[row]:[];return [];}}}});t.after(()=>h.close());
 return ()=>h.browser.evaluate('chart-1',pinePage,{op:'compile',expected_source:'original',expected_title:'Test'});
}
test('compile confirms newly observed success for unchanged source',async t=>{const r=await fixture(t)();assert.equal(r.verified,true)});
test('compile refuses success if buffer changed after submission',async t=>{const r=await fixture(t,{change:true})();assert.equal(r.code,'PRECONDITION_FAILED');assert.equal(r.mutation_attempted,true)});
test('compile refuses success without readable diagnostics',async t=>{const r=await fixture(t,{missingMarkers:true})();assert.equal(r.code,'VERIFICATION_FAILED')});
