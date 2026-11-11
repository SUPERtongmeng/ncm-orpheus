import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
export const root = fileURLToPath(new URL('../', import.meta.url));
const defaultFlag = fileURLToPath(new URL('../.local/disabled', import.meta.url));
// 开关标志文件：默认 .local/disabled，可在 config.json 里用 "flag" 指到插件目录
export function flagPath(){
  try{ const c=JSON.parse(readFileSync(join(root,'.local','config.json'),'utf8')); if(typeof c.flag==='string'&&c.flag) return c.flag; }catch{}
  return defaultFlag;
}
export const isDisabled = () => existsSync(flagPath());
export const setDisabled = (on) => {
  const p=flagPath();
  if(on){ mkdirSync(dirname(p),{recursive:true}); writeFileSync(p,String(Date.now())); return true; }
  if(existsSync(p)) rmSync(p,{force:true});
  return false;
};
export function getConfig() {
  const dir=join(root,'.local'), path=join(dir,'config.json');
  mkdirSync(dir,{recursive:true});
  if(!existsSync(path)) writeFileSync(path,JSON.stringify({port:17632,token:randomBytes(32).toString('hex')}),{mode:0o600,flag:'wx'});
  const config=JSON.parse(readFileSync(path,'utf8'));
  if(!Number.isInteger(config.port)||config.port<1024||config.port>65535||!/^[a-f0-9]{64}$/.test(config.token))throw Error('INVALID_LOCAL_CONFIG');
  return config;
}
