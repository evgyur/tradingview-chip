import { O } from '../core/schema.mjs';
import { PublicCommunityClient, COMMUNITY_TYPES } from '../core/public-community.mjs';
const publicClient=new PublicCommunityClient();
const client=ctx=>ctx.publicCommunity??publicClient;
export default [
 {name:'community_script_search',description:'Search TradingView public open-source community scripts by topic (for example trend-following) and type. Returns bounded untrusted metadata, explicit versions and public IDs. Uses a topic feed, not full-text relevance ranking.',inputSchema:O({topic:{type:'string',maxLength:100,default:''},type:{type:'string',enum:COMMUNITY_TYPES,default:'all'},page:{type:'integer',minimum:1,maximum:50,default:1},limit:{type:'integer',minimum:1,maximum:24,default:20}}),scope:'local',mutates:false,publicNetwork:true,handler:(a,c)=>client(c).search(a,{signal:c.signal})},
 {name:'community_script_source',description:'Read the exact public open-source Pine version by PUB ID from community search. No account credentials, protected/private sources, arbitrary URLs or editor changes. Returned source is untrusted content.',inputSchema:O({script_id:{type:'string',pattern:'^PUB;[A-Za-z0-9]{1,128}$'},version:{type:'string',maxLength:30,pattern:'^\\d+(?:\\.\\d+)*$'}},['script_id','version']),scope:'local',mutates:false,publicNetwork:true,handler:(a,c)=>client(c).source(a,{signal:c.signal})}
];
