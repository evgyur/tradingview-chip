import test from 'node:test';
import assert from 'node:assert/strict';
import {capabilitiesPage} from '../src/features/browser-tools.mjs';
import {createFakeCdp} from './fake-cdp.mjs';
async function probe(t,mode){
 const box=()=>({width:100,height:100});const node={isConnected:mode!=='detached',getBoundingClientRect:box,contains(other){return other===this;}};
 const editor={getDomNode:()=>node};const doc={title:'Test',querySelectorAll:s=>s==='.monaco-editor.pine-editor-monaco'&&mode!=='unrelated'?[node]:[]};
 const h=createFakeCdp({page:{document:doc,monaco:{editor:{getEditors:()=>mode==='bound'?[editor]:[]}}}});t.after(()=>h.close());return h.browser.evaluate('chart-1',capabilitiesPage,{});
}
for(const mode of ['unrelated','detached','unbound'])test('capabilities does not claim Pine editor for '+mode,async t=>assert.equal((await probe(t,mode)).observed.pine_editor,false));
test('capabilities confirms a visible bound Pine editor',async t=>assert.equal((await probe(t,'bound')).observed.pine_editor,true));
