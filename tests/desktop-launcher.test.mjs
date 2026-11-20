import test from 'node:test';
import assert from 'node:assert/strict';
import {launchDesktop,parseDesktopLaunchOptions,browserEnvironment,assertDesktopVersion} from '../src/core/launcher.mjs';
const endpoint='http://127.0.0.1:9223';
function fixture({busy=false,running=false,identityError=false,neverReady=false}={}){
 const calls=[];let launched=false;
 const deps={platform:'win32',portBusy:async()=>busy||(launched&&!neverReady),discover:async()=>{calls.push('discover');return {executable:'C:\\Program Files\\WindowsApps\\TradingView\\TradingView.exe',running};},version:async ep=>{calls.push(['version',ep]);if(identityError)throw new Error('wrong listener');return {};},spawn:async(exe,args)=>{calls.push(['spawn',exe,args]);launched=true;return 123;},wait:async()=>{}};
 return {calls,deps};
}
test('Desktop defaults to a separate literal-loopback endpoint and fixed debug flags',async()=>{
 const f=fixture();const r=await launchDesktop({},f.deps);assert.equal(r.endpoint,endpoint);assert.equal(r.identity_verified,true);assert.equal(r.pid,123);
 const launch=f.calls.find(x=>Array.isArray(x)&&x[0]==='spawn');assert.deepEqual(launch[2],['--remote-debugging-address=127.0.0.1','--remote-debugging-port=9223']);assert.equal(launch[2].some(x=>x.startsWith('--user-data-dir')),false);
});
test('Desktop reuses only an identity-verified existing endpoint without launching',async()=>{const f=fixture({busy:true});const r=await launchDesktop({},f.deps);assert.equal(r.reused,true);assert.deepEqual(f.calls,[['version',endpoint]]);});
test('Desktop refuses an unrelated occupied listener before app discovery',async()=>{const f=fixture({busy:true,identityError:true});await assert.rejects(launchDesktop({},f.deps),/wrong listener/);assert.equal(f.calls.length,1);});
test('Desktop does not launch or stop a running non-debug instance',async()=>{const f=fixture({running:true});await assert.rejects(launchDesktop({},f.deps),e=>e.code==='DESKTOP_ALREADY_RUNNING');assert.deepEqual(f.calls,['discover']);});
test('Desktop reports unavailable debugging after one launch without forced stops/retries',async()=>{const f=fixture({neverReady:true});await assert.rejects(launchDesktop({},f.deps),e=>e.code==='DESKTOP_DEBUGGING_UNAVAILABLE');assert.equal(f.calls.filter(x=>Array.isArray(x)&&x[0]==='spawn').length,1);});
test('Desktop rejects remote, credentialed and alias endpoints',async()=>{for(const ep of ['http://localhost:9223','http://10.0.0.1:9223','http://user@127.0.0.1:9223','http://127.0.0.1:9223/path']){const f=fixture();await assert.rejects(launchDesktop({endpoint:ep},f.deps),e=>e.code==='INVALID_CDP_ENDPOINT');assert.equal(f.calls.length,0);}});
test('Desktop launcher is explicitly Windows-only and options cannot inject args',async()=>{await assert.rejects(launchDesktop({}, {platform:'linux'}),e=>e.code==='DESKTOP_PLATFORM_UNSUPPORTED');assert.deepEqual(parseDesktopLaunchOptions([]),{});assert.deepEqual(parseDesktopLaunchOptions(['--endpoint',endpoint]),{endpoint});for(const args of [['--profile','x'],['--endpoint'],['--endpoint',endpoint,'--browser','x']])assert.throws(()=>parseDesktopLaunchOptions(args),e=>e.code==='INVALID_OPTION');});
test('Desktop environment shares the existing secret-free browser allowlist',()=>{assert.deepEqual(browserEnvironment({TEMP:'R:\\TEMP',TV_HTTP_TOKEN:'secret',NODE_OPTIONS:'--require evil',ELECTRON_RUN_AS_NODE:'1'}),{TEMP:'R:\\TEMP'});});

test('Desktop identity requires both vendor UA tokens and same-loopback debugger socket',()=>{
 const valid={'User-Agent':'Mozilla TradingView/3.5.1 Chrome/156 Electron/45 TVDesktop/3.5.1',webSocketDebuggerUrl:'ws://127.0.0.1:9223/devtools/browser/abc-123'};
 assert.equal(assertDesktopVersion(valid,endpoint),valid);
 for(const ua of ['Chrome/156','TradingView/3.5.1','TVDesktop/3.5.1'])assert.throws(()=>assertDesktopVersion({...valid,'User-Agent':ua},endpoint),e=>e.code==='DESKTOP_IDENTITY_UNVERIFIED');
 for(const socket of ['ws://10.0.0.1:9223/devtools/browser/a','ws://127.0.0.1:9222/devtools/browser/a','ws://localhost:9223/devtools/browser/a'])assert.throws(()=>assertDesktopVersion({...valid,webSocketDebuggerUrl:socket},endpoint),e=>e.code==='UNSAFE_DEBUGGER_URL');
});
