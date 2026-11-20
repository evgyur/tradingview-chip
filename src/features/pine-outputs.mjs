import { ToolError } from '../core/errors.mjs';

/** Read only the table-cell collection owned by one exact registered study.
 * Raw primitive fields are validated rather than inferred from missing values. */
export function pineTableCellsPage(a) {
  const fail=(code,message)=>({ok:false,code,message});
  try {
    if(typeof a.entity_id!=='string'||!a.entity_id||a.entity_id.length>300)return fail('INVALID_ARGUMENT','An exact study entity ID is required.');
    const offset=a.offset??0,limit=a.limit??500;
    if(!Number.isInteger(offset)||offset<0||offset>100000||!Number.isInteger(limit)||limit<1||limit>1000)return fail('INVALID_ARGUMENT','Table-cell pagination exceeds supported bounds.');
    const api=window.TradingViewApi,chart=api?.activeChart?.()??api?._activeChartWidgetWV?.value?.();
    if(!chart)return fail('CAPABILITY_UNAVAILABLE','Chart API unavailable.');
    const all=chart.getAllStudies?.(),sources=chart._chartWidget?.model?.().model?.().dataSources?.();
    if(!Array.isArray(all)||!Array.isArray(sources))return fail('CAPABILITY_UNAVAILABLE','Registered study inventory unavailable.');
    if(all.filter(s=>s.id===a.entity_id).length!==1)return fail('TARGET_NOT_FOUND','No unique registered study matched the exact entity ID.');
    const matched=sources.filter(s=>{try{return s.id?.()===a.entity_id;}catch{return false;}});
    if(matched.length!==1)return fail('TARGET_NOT_FOUND','No unique data source matched the exact entity ID.');
    const source=matched[0],meta=source.metaInfo?.();
    if(!meta||typeof meta!=='object')return fail('ADAPTER_MISMATCH','Study metadata unavailable.');
    const owner=source._graphics?._primitivesCollection?.dwgtablecells;
    if(typeof owner?.get!=='function')return fail('CAPABILITY_UNAVAILABLE','This study exposes no readable table-cell collection.');
    const tableCells=owner.get('tableCells');
    const nested=typeof tableCells?.get==='function'?tableCells.get(false):null;
    const direct=tableCells?._primitivesDataById,nestedMap=nested?._primitivesDataById;
    if(direct&&nestedMap&&direct!==nestedMap)return fail('ADAPTER_MISMATCH','Multiple distinct table-cell containers matched.');
    const cells=nestedMap??direct;
    if(!cells||typeof cells.entries!=='function'||!Number.isSafeInteger(cells.size)||cells.size<0||cells.size>100000)return fail('ADAPTER_MISMATCH','Table-cell storage shape or size is unsupported.');
    const total=cells.size,items=[];let index=0,textChars=0;
    for(const entry of cells.entries()) {
      if(index>=offset+limit)break;
      if(index++<offset)continue;
      if(!Array.isArray(entry)||entry.length!==2)return fail('ADAPTER_MISMATCH','Invalid table-cell entry.');
      const [id,v]=entry;
      const identifier=x=>(typeof x==='string'&&x.length>0&&x.length<=300)||(Number.isSafeInteger(x)&&x>=0);
      if(!identifier(id)||!v||typeof v!=='object'||!identifier(v.tid)||!Number.isSafeInteger(v.row)||v.row<0||v.row>100000||!Number.isSafeInteger(v.col)||v.col<0||v.col>100000||typeof v.t!=='string')return fail('ADAPTER_MISMATCH','A table cell lacks an explicit ID, table ID, coordinates or text.');
      if(v.t.length>4096||(textChars+=v.t.length)>262144)return fail('PAYLOAD_LIMIT','Table text exceeds the bounded response budget.');
      items.push({id,table_id:v.tid,row:v.row,column:v.col,text:v.t});
    }
    if(cells.size!==total||source.id()!==a.entity_id)return fail('DATA_CHANGED','Study table cells changed during extraction.');
    return {ok:true,entity_id:a.entity_id,study_name:typeof meta.description==='string'?meta.description.slice(0,500):null,
      script_id:typeof meta.scriptIdPart==='string'?meta.scriptIdPart:null,
      symbol:typeof chart.symbol==='function'?chart.symbol():null,timeframe:typeof chart.resolution==='function'?String(chart.resolution()):null,
      source:'exact_study_native_table_cell_primitives',adapter_shape:nestedMap?'tableCells.get(false)':'tableCells.direct',
      total_cells:total,offset,returned:items.length,next_offset:offset+items.length<total?offset+items.length:null,cells:items,
      observed_at:new Date().toISOString(),text_is_untrusted:true,coverage:'loaded_native_primitives_only',
      note:'Cells preserve explicit native coordinates and blank strings. Merged-cell geometry and visual placement are not inferred.'};
  }catch{return fail('TABLE_CELLS_UNAVAILABLE','The selected study table-cell adapter could not be read.');}
}

export default [{name:'pine_read_table_cells',description:'Read bounded table-cell text and explicit coordinates from one exact attached Pine study. Rejects unknown primitive shapes instead of inventing table IDs or blanks.',
  inputSchema:{type:'object',properties:{entity_id:{type:'string',minLength:1,maxLength:300},offset:{type:'integer',minimum:0,maximum:100000},limit:{type:'integer',minimum:1,maximum:1000}},required:['entity_id'],additionalProperties:false},mutates:false,
  handler:async(args,ctx)=>{const result=await ctx.callPage(pineTableCellsPage,args);if(!result?.ok)throw new ToolError(result?.code??'TABLE_CELLS_UNAVAILABLE',result?.message??'Table-cell read failed.',result);return result;}
}];
