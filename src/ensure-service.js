import { spawn } from 'node:child_process';
import { openSync,closeSync } from 'node:fs';
import { join } from 'node:path';
import { getConfig,root } from './config.js';
export async function ensureService(){
 const {port,token}=getConfig();
 async function health(){try{const r=await fetch(`http://127.0.0.1:${port}/health`,{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(800)});if(!r.ok)throw Error('端口被其他服务占用或令牌不匹配');const data=await r.json();if(data.service!=='orpheus')throw Error('端口服务不匹配');return data;}catch(e){if(e.message.includes('fetch failed')||e.name==='TimeoutError')return null;throw e;}}
 if(await health())return;
 const log=openSync(join(root,'.local','service.log'),'a');
 const child=spawn(process.execPath,[join(root,'src','server.js')],{cwd:root,detached:true,windowsHide:true,stdio:['ignore',log,log]});
 child.on('error',e=>console.error('Bridge startup:',e.message));child.unref();closeSync(log);
 for(let i=0;i<30;i++){await new Promise(r=>setTimeout(r,200));if(await health())return;}
 throw Error('本地控制服务启动失败，请检查 .local/service.log');
}
