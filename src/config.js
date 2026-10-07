import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
export const root = fileURLToPath(new URL('../', import.meta.url));
export function getConfig() {
  const dir=join(root,'.local'), path=join(dir,'config.json');
  mkdirSync(dir,{recursive:true});
  if(!existsSync(path)) writeFileSync(path,JSON.stringify({port:17632,token:randomBytes(32).toString('hex')}),{mode:0o600,flag:'wx'});
  const config=JSON.parse(readFileSync(path,'utf8'));
  if(!Number.isInteger(config.port)||config.port<1024||config.port>65535||!/^[a-f0-9]{64}$/.test(config.token))throw Error('INVALID_LOCAL_CONFIG');
  return config;
}
