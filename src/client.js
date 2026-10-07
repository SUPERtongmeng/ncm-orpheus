import { getConfig } from './config.js';
export async function callBridge(name,args={}) {
  const {port,token}=getConfig();
  const res=await fetch(`http://127.0.0.1:${port}/command`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},body:JSON.stringify({name,args}),signal:AbortSignal.timeout(28000)});
  const body=await res.json();if(!res.ok)throw Error(body.error||`HTTP ${res.status}`);return body.result;
}
