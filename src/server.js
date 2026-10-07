import http from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { getConfig } from './config.js';
import { validateCommand } from './tools.js';

export function createBridge({token,timeoutMs=25000}) {
  let peer=null, pending=null, lastSeen=0;
  const same=(s)=>typeof s==='string'&&Buffer.byteLength(s)===Buffer.byteLength(token)&&timingSafeEqual(Buffer.from(s),Buffer.from(token));
  const finish=(err,data)=>{if(!pending)return;const p=pending;pending=null;clearTimeout(p.timer);err?p.reject(err):p.resolve(data);};
  function execute(name,args) {
    const validated=validateCommand(name,args);
    if(!peer||peer.readyState!==WebSocket.OPEN)throw Error('PLUGIN_OFFLINE: 请打开网易云并启用 Orpheus');
    if(pending)throw Error('BUSY: 上一个命令仍在执行');
    return new Promise((resolve,reject)=>{
      const id=randomUUID(),deadline=Date.now()+timeoutMs-1000;
      pending={id,resolve,reject,timer:setTimeout(()=>finish(Error('TIMEOUT: 结果未确认；不要自动重试写操作，请先查询状态')),timeoutMs)};
      peer.send(JSON.stringify({type:'command',id,name,args:validated,deadline}));
    });
  }
  const server=http.createServer(async(req,res)=>{
    res.setHeader('Content-Type','application/json; charset=utf-8');
    res.setHeader('Cache-Control','no-store');
    const send=(status,data)=>{res.writeHead(status);res.end(JSON.stringify(data));};
    // Local tool clients do not need browser CORS. Reject browser-origin requests.
    if(req.headers.origin)return send(403,{error:'ORIGIN_DENIED'});
    if(!same(req.headers.authorization?.replace(/^Bearer /,'')))return send(401,{error:'UNAUTHORIZED'});
    if(req.url==='/health'&&req.method==='GET')return send(200,{service:'orpheus',version:'0.1.0',pluginConnected:!!peer,lastSeen,busy:!!pending});
    if(req.url!=='/command'||req.method!=='POST')return send(404,{error:'NOT_FOUND'});
    try{
      let body='';for await(const chunk of req){body+=chunk;if(Buffer.byteLength(body)>16384)return send(413,{error:'BODY_TOO_LARGE'});}
      const {name,args}=JSON.parse(body);
      const result=await execute(name,args);
      send(200,{result});
    }catch(e){send(400,{error:e.message});}
  });
  server.requestTimeout=10000;server.headersTimeout=10000;
  const wss=new WebSocketServer({noServer:true,maxPayload:1024*1024});
  server.on('upgrade',(req,socket,head)=>{
    const origin=req.headers.origin;
    if(req.url!=='/plugin'||(origin&&origin!=='null'&&origin!=='orpheus://orpheus')){socket.destroy();return;}
    wss.handleUpgrade(req,socket,head,ws=>wss.emit('connection',ws));
  });
  wss.on('connection',ws=>{
    let authenticated=false;
    const authTimer=setTimeout(()=>ws.close(1008,'auth required'),3000);
    ws.on('error',()=>{});
    ws.on('message',raw=>{
      let msg;try{msg=JSON.parse(raw);}catch{ws.close(1008,'invalid json');return;}
      if(!authenticated){
        if(msg.type!=='hello'||!same(msg.token)){ws.close(1008,'auth failed');return;}
        if(peer&&peer.readyState===WebSocket.OPEN){ws.close(1013,'already connected');return;}
        clearTimeout(authTimer);authenticated=true;peer=ws;lastSeen=Date.now();ws.send(JSON.stringify({type:'ready'}));return;
      }
      lastSeen=Date.now();
      if(msg.type==='result'&&pending?.id===msg.id){
        if(msg.error)finish(Error(String(msg.error)));else if(Object.hasOwn(msg,'result'))finish(null,msg.result);
      }
    });
    ws.on('pong',()=>{lastSeen=Date.now();});
    ws.on('close',()=>{clearTimeout(authTimer);if(peer===ws){peer=null;finish(Error('DISCONNECTED: 执行结果未确认，请先查询状态'));}});
  });
  const heartbeat=setInterval(()=>{if(peer){if(Date.now()-lastSeen>45000)peer.terminate();else peer.ping();}},15000);
  heartbeat.unref();
  return {server,execute,close:()=>new Promise(resolve=>{clearInterval(heartbeat);for(const ws of wss.clients)ws.terminate();wss.close();server.close(resolve);})};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const config=getConfig();const bridge=createBridge(config);
  bridge.server.on('error',e=>{console.error(e.code==='EADDRINUSE'?'端口已被占用；服务可能已经运行。':e.message);process.exitCode=1;});
  bridge.server.listen(config.port,'127.0.0.1',()=>console.error(`Orpheus 已启动：127.0.0.1:${config.port}`));
  for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>bridge.close().then(()=>process.exit()));
}
