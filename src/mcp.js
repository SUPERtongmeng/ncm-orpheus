import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema,ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { toolDefinitions,validateCommand } from './tools.js';
import { callBridge } from './client.js';
import { ensureService } from './ensure-service.js';
await ensureService();
const server=new Server({name:'orpheus',version:'0.1.0'},{capabilities:{tools:{}}});
server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:toolDefinitions}));
server.setRequestHandler(CallToolRequestSchema,async({params})=>{
  try{const result=await callBridge(params.name,validateCommand(params.name,params.arguments));return {content:[{type:'text',text:JSON.stringify(result)}]};}
  catch(e){return {isError:true,content:[{type:'text',text:e.message}]};}
});
await server.connect(new StdioServerTransport());
