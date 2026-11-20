import { ToolError } from './errors.mjs';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { connect } from 'node:net';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { assertCdpEndpoint, assertDebuggerUrl } from './security.mjs';

// Chrome needs platform/session settings, not credentials from its MCP parent.
const BROWSER_ENV = new Set([
  'PATH','HOME','USER','LOGNAME','SHELL','TMPDIR','TMP','TEMP',
  'SystemRoot','SYSTEMROOT','WINDIR','windir','COMSPEC','ComSpec',
  'PROGRAMFILES','PROGRAMFILES(X86)','LOCALAPPDATA','APPDATA',
  'USERPROFILE','HOMEDRIVE','HOMEPATH','DISPLAY','WAYLAND_DISPLAY',
  'XDG_RUNTIME_DIR','XDG_CONFIG_HOME','DBUS_SESSION_BUS_ADDRESS',
  'XAUTHORITY','LANG','LC_ALL','LC_CTYPE','TZ',
]);

export function browserEnvironment(environment=process.env) {
  return Object.fromEntries(Object.entries(environment).filter(([key])=>BROWSER_ENV.has(key)));
}

export function parseLaunchOptions(args) {
  const result={};
  for(let i=0;i<args.length;i+=2){
    const key=args[i],value=args[i+1];
    if(!['--browser','--profile','--url'].includes(key)||!value||value.startsWith('--')||Object.hasOwn(result,key)) {
      throw new ToolError('INVALID_OPTION','Use --browser, --profile or --url once each, with a value.');
    }
    result[key]=value;
  }
  return result;
}

export function parseDesktopLaunchOptions(args) {
  if(args.length===0)return {};
  if(args.length!==2||args[0]!=='--endpoint'||!args[1])throw new ToolError('INVALID_OPTION','Use launch-desktop [--endpoint http://127.0.0.1:9223].');
  return {endpoint:assertCdpEndpoint(args[1])};
}

const runFile=promisify(execFile);
async function discoverDesktop() {
  const script="$p=Get-AppxPackage -Name TradingView.Desktop; if (@($p).Count -ne 1) { throw 'One TradingView Desktop package is required' }; [pscustomobject]@{path=$p.InstallLocation;running=[bool](Get-Process -Name TradingView -ErrorAction SilentlyContinue)} | ConvertTo-Json -Compress";
  const {stdout}=await runFile('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,timeout:10000,maxBuffer:65536,env:browserEnvironment()});
  const result=JSON.parse(stdout);
  if(typeof result.path!=='string'||!result.path||typeof result.running!=='boolean')throw new ToolError('DESKTOP_DISCOVERY_FAILED','TradingView Desktop package discovery returned unexpected data.');
  const executable=join(result.path,'TradingView.exe');await access(executable);return {executable,running:result.running};
}
async function portBusy(endpoint) {
  const url=new URL(endpoint);
  return new Promise(resolve=>{const socket=connect({host:url.hostname.replace(/^\[|\]$/g,''),port:Number(url.port||80)});const done=value=>{socket.destroy();resolve(value);};socket.once('connect',()=>done(true));socket.once('error',error=>done(error.code!=='ECONNREFUSED'));socket.setTimeout(1000,()=>done(true));});
}
async function desktopVersion(endpoint) {
  const response=await fetch(endpoint+'/json/version',{redirect:'error',credentials:'omit',signal:AbortSignal.timeout(2000)});
  if(!response.ok||!response.body?.getReader)throw new ToolError('DESKTOP_IDENTITY_UNVERIFIED','The debugging endpoint did not return a readable version.');
  const reader=response.body.getReader();let size=0;const chunks=[];
  try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>65536){await reader.cancel();throw new ToolError('DESKTOP_IDENTITY_UNVERIFIED','Desktop version response exceeds its limit.');}chunks.push(Buffer.from(value));}}finally{reader.releaseLock();}
  return assertDesktopVersion(JSON.parse(Buffer.concat(chunks).toString('utf8')),endpoint);
}
export function assertDesktopVersion(version,endpoint) {
  if(!version||typeof version['User-Agent']!=='string'||!/(?:^|\s)TVDesktop\/\d/.test(version['User-Agent'])||!/(?:^|\s)TradingView\/\d/.test(version['User-Agent']))throw new ToolError('DESKTOP_IDENTITY_UNVERIFIED','The listener is not a verified TradingView Desktop debugging endpoint.');
  assertDebuggerUrl(version.webSocketDebuggerUrl,endpoint);return version;
}
async function spawnDesktop(executable,args) {
  const child=spawn(executable,args,{detached:true,stdio:'ignore',windowsHide:true,env:browserEnvironment()});
  await new Promise((yes,no)=>{child.once('spawn',yes);child.once('error',no);});child.unref();return child.pid;
}

/** Explicit Windows Desktop mode. Never quits an app, copies a profile or replaces a listener. */
export async function launchDesktop(options={},dependencies={}) {
  const deps={platform:process.platform,discover:discoverDesktop,portBusy,version:desktopVersion,spawn:spawnDesktop,wait:ms=>new Promise(r=>setTimeout(r,ms)),...dependencies};
  if(deps.platform!=='win32')throw new ToolError('DESKTOP_PLATFORM_UNSUPPORTED','This opt-in Desktop launcher currently supports Windows MSIX only.');
  const endpoint=assertCdpEndpoint(options.endpoint||'http://127.0.0.1:9223');
  if(await deps.portBusy(endpoint)){
    await deps.version(endpoint);
    return {desktop_started:false,reused:true,endpoint,identity_verified:true};
  }
  const app=await deps.discover();
  if(app.running)throw new ToolError('DESKTOP_ALREADY_RUNNING','TradingView Desktop is already running without this debug endpoint. Close it normally, resolve any save prompts, then retry. No process was stopped.');
  const url=new URL(endpoint),pid=await deps.spawn(app.executable,[`--remote-debugging-address=${url.hostname.replace(/^\[|\]$/g,'')}`,`--remote-debugging-port=${url.port||80}`]);
  for(let attempt=0;attempt<40;attempt++){
    if(await deps.portBusy(endpoint)){
      await deps.version(endpoint);
      return {desktop_started:true,reused:false,pid,endpoint,identity_verified:true};
    }
    await deps.wait(250);
  }
  throw new ToolError('DESKTOP_DEBUGGING_UNAVAILABLE','TradingView Desktop started but no verified debug endpoint appeared. This build may block debugging; the app was left running and no retry or forced stop was attempted.');
}
