import {readFileSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {toolDefinitions} from './tools.js';

// BetterNCM executes a standalone script; generate its registry from MCP definitions.
export function syncTools(){
  const path=fileURLToPath(new URL('../plugin/main.js',import.meta.url));
  const source=readFileSync(path,'utf8');
  const updated=source.replace(/const TOOL_NAMES=\[[^\n]*\];/,`const TOOL_NAMES=${JSON.stringify(toolDefinitions.map(t=>t.name))};`);
  if(updated!==source)writeFileSync(path,updated);
}
if(process.argv[1]===fileURLToPath(import.meta.url))syncTools();
