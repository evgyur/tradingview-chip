import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import tools,{pineTableCellsPage} from '../src/features/pine-outputs.mjs';
import {assertFixedFunction} from '../src/core/security.mjs';
function run({rows=[[0,{tid:0,row:0,col:0,t:''}],[1,{tid:0,row:1,col:0,t:'0'}]],nested=true,missing=false,duplicate=false,registered=true,ambiguous=false}={},args={entity_id:'wanted'}) {
 const data=new Map(rows),bucket={_primitivesDataById:data};const cellContainer=nested?{get:x=>x===false?bucket:undefined}:bucket;
 if(ambiguous)cellContainer._primitivesDataById=new Map();
 const s={id:()=> 'wanted',metaInfo:()=>({description:'Dashboard',scriptIdPart:'USER;test'}),_graphics:{_primitivesCollection:missing?{}:{dwgtablecells:new Map([['tableCells',cellContainer]])}}};
 const other={id:()=> 'other',metaInfo:()=>({description:'Secret other study'}),get _graphics(){throw new Error('Unrelated study read');}};
 const chart={getAllStudies:()=>registered?[{id:'wanted'},{id:'other'}]:[{id:'other'}],symbol:()=> 'RUS:IRUS.P',resolution:()=> '1D',_chartWidget:{model:()=>({model:()=>({dataSources:()=>duplicate?[s,s,other]:[other,s]})})}};
 const context=vm.createContext({window:{TradingViewApi:{activeChart:()=>chart}},Date,args});
 return JSON.parse(JSON.stringify(vm.runInContext(`(${pineTableCellsPage.toString()})(args)`,context)));
}
test('strict Pine table reader passes fixed-function gate and registers read-only schema',()=>{assert.equal(typeof assertFixedFunction(pineTableCellsPage),'string');assert.equal(tools[0].mutates,false);assert.deepEqual(tools[0].inputSchema.required,['entity_id']);});
test('reads only exact attached study, retaining blanks, zero IDs and coordinates',()=>{const r=run();assert.equal(r.ok,true);assert.equal(r.entity_id,'wanted');assert.equal(r.cells[0].text,'');assert.equal(r.cells[0].table_id,0);assert.equal(r.cells[1].text,'0');assert.equal(r.text_is_untrusted,true);});
test('supports direct current container and bounded pagination',()=>{const r=run({nested:false},{entity_id:'wanted',offset:1,limit:1});assert.equal(r.ok,true);assert.equal(r.adapter_shape,'tableCells.direct');assert.equal(r.returned,1);assert.equal(r.cells[0].id,1);assert.equal(r.next_offset,null);});
test('returns next offset without materialising complete collection',()=>{const r=run({}, {entity_id:'wanted',limit:1});assert.equal(r.next_offset,1);assert.equal(r.total_cells,2);});
for(const [name,options] of [['unregistered',{registered:false}],['duplicate source',{duplicate:true}],['unavailable collection',{missing:true}],['ambiguous containers',{ambiguous:true}],['missing table ID',{rows:[[1,{row:0,col:0,t:'value'}]]}],['missing text',{rows:[[1,{tid:1,row:0,col:0}]]}],['invalid coordinates',{rows:[[1,{tid:1,row:-1,col:0,t:'value'}]]}]])test('fails closed for '+name,()=>{assert.equal(run(options).ok,false)});
test('empty explicit Map is an empty observed collection',()=>{const r=run({rows:[]});assert.equal(r.ok,true);assert.equal(r.total_cells,0);assert.deepEqual(r.cells,[]);});
test('bounds cell text and request limits',()=>{assert.equal(run({rows:[[1,{tid:0,row:0,col:0,t:'x'.repeat(4097)}]]}).code,'PAYLOAD_LIMIT');assert.equal(run({}, {entity_id:'wanted',limit:1001}).code,'INVALID_ARGUMENT');});
