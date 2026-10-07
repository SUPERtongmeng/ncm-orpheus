import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {fileURLToPath} from 'node:url';
test('real MCP stdio handshake, tool discovery, argument rejection',async t=>{
 const client=new Client({name:'bridge-protocol-test',version:'1.0'});
 const transport=new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../src/mcp.js',import.meta.url))]});
 await client.connect(transport);t.after(()=>client.close());
 const list=await client.listTools();assert.equal(list.tools.length,8);
 const result=await client.callTool({name:'play_song',arguments:{id:'invalid'}});assert.equal(result.isError,true);
});
