import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {toolDefinitions,validateCommand} from '../src/tools.js';

const source=fs.readFileSync(new URL('../plugin/main.js',import.meta.url),'utf8');
// Execute the production adapter functions with a fake NCM API, never a real account.
function adapter(api,extra={}){
  let now=0;
  const context={api,Date:{now:()=>now},state:()=>({host:{uid:'1'}}),player:()=>({id:'2'}),
    checkDeadline:d=>{if(now>=d)throw Error('COMMAND_EXPIRED');},...extra};
  const code=source.slice(source.indexOf('    function requireSuccess('),source.indexOf('    // Access now'));
  return {execute:vm.runInNewContext(code+';execute',context),time:n=>{now=n;}};
}
const playlist=(ids)=>({code:200,playlist:{id:'3',trackCount:ids.length,trackIds:ids.map(id=>({id}))}});
test('tool registry, UI and parameter boundary agree',()=>{
 const names=JSON.parse(source.match(/const TOOL_NAMES=(\[[^\n]*\]);/)[1]);
 assert.deepEqual(names,toolDefinitions.map(t=>t.name));
 for(const name of ['add_to_playlist','remove_from_playlist'])assert.throws(()=>validateCommand(name,{playlistId:'3',ids:[]}));
 assert.throws(()=>validateCommand('create_playlist',{name:'   '}));
});
test('expired playlist read cannot initiate a write',async()=>{
 let writes=0;const a=adapter({playlist:async()=>{a.time(101);return playlist([]);},manipulate:async()=>{writes++;}});
 await assert.rejects(a.execute('add_to_playlist',{playlistId:'3',ids:['2']},100),/COMMAND_EXPIRED/);
 assert.equal(writes,0);
});
test('write failures are not automatically retried',async()=>{
 let writes=0;const a=adapter({playlist:async()=>playlist([]),manipulate:async()=>{writes++;return {code:500};}});
 await assert.rejects(a.execute('add_to_playlist',{playlistId:'3',ids:['2']},100),/NOT_CONFIRMED/);assert.equal(writes,1);
});
test('remove never confirms malformed or incomplete readback',async()=>{
 for(const response of [{code:500},{playlist:{}},{code:200,playlist:{trackCount:2,tracks:[]}}]){
  let reads=0;const a=adapter({playlist:async()=>++reads===1?playlist(['2']):response,manipulate:async()=>({code:200})});
  await assert.rejects(a.execute('remove_from_playlist',{playlistId:'3',ids:['2']},100),/PLAYLIST/);
 }
});
test('add and remove confirm complete readback and deduplicate IDs',async()=>{
 for(const name of ['add_to_playlist','remove_from_playlist']){
  let reads=0,writes=0;const adding=name==='add_to_playlist';
  const a=adapter({playlist:async()=>playlist((++reads===1)!==adding?['2']:[]),manipulate:async args=>{writes++;assert.equal(args.trackIds.length,1);return {code:200};}});
  assert.equal((await a.execute(name,{playlistId:'3',ids:['2','2']},100)).verified,true);assert.equal(writes,1);
 }
});
test('delete requires acknowledged write and valid complete readback',async()=>{
 for(const [del,mine] of [[undefined,{}],[{code:200},{}],[{code:200},{code:500,playlist:[]}]]){
  const a=adapter({del:async()=>del,mine:async()=>mine});
  await assert.rejects(a.execute('delete_playlist',{playlistId:'3'},100),/NOT_CONFIRMED/);
 }
});
test('delete checks later pages before reporting success',async()=>{
 let reads=0;const a=adapter({del:async()=>({code:200}),mine:async()=>++reads===1?{playlist:[{id:'4'}],more:true}:{playlist:[{id:'3'}],more:false}});
 await assert.rejects(a.execute('delete_playlist',{playlistId:'3'},100),/NOT_CONFIRMED/);assert.equal(reads,2);
 const b=adapter({del:async()=>({code:200}),mine:async()=>({playlist:[],more:false})});
 assert.equal((await b.execute('delete_playlist',{playlistId:'3'},100)).verified,true);
});
test('create cannot confirm an older playlist with the same name',async()=>{
 const a=adapter({create:async()=>({code:200}),mine:async()=>({playlist:[{id:'4',name:'same'}]})});
 await assert.rejects(a.execute('create_playlist',{name:'same'},100),/CREATE_NOT_CONFIRMED/);
 const b=adapter({create:async()=>({code:200,id:'3'}),playlist:async()=>playlist([])});
 assert.equal((await b.execute('create_playlist',{name:'same'},100)).id,'3');
});
test('playlist pagination bounds extra API results and removes duplicate pinned lists',async()=>{
 let calls=0;
 const a=adapter({mine:async args=>{assert.equal(args.offset,calls++*1000);return calls===1?{playlist:[{id:'1'},{id:'2'}],more:true}:{playlist:[{id:'1'},{id:'3'}],more:false};}},{playlistSummary:p=>p});
 const result=await a.execute('list_my_playlists',{offset:2,limit:1},100);
 assert.equal(result.items.length,1);assert.equal(result.items[0].id,'3');assert.equal(result.more,false);
 const b=adapter({mine:async()=>({playlist:[{id:'1'},{id:'2'},{id:'3'}],more:false})},{playlistSummary:p=>p});
 const first=await b.execute('list_my_playlists',{offset:0,limit:1},100);
 assert.equal(first.items.length,1);assert.equal(first.more,true);
});
test('player converts native seconds to milliseconds',()=>{
 const code=source.slice(source.indexOf('    function player(){'),source.indexOf('    function queue(){'));
 const player=vm.runInNewContext(code+';player',{state:()=>({playing:{resourceDuration:132.16}})});
 assert.equal(player().durationMs,132160);
});
test('basic player status survives unavailable optional APIs',async()=>{
 const helper={getStore:()=>({playing:{resourceDuration:132}}),getDispatch:()=>()=>{}};
 const modules={1:function(){/* dva-tool getDispatch() */},2:function(){/* /api/cloudsearch/pc /api/v3/song/detail */}};
 const req=id=>String(id)==='1'?{helper}:{};req.m=modules;
 const webpackJsonp=[];webpackJsonp.push=([,entries])=>Object.values(entries)[0]({}, {},req);
 const context={window:{webpackJsonp},document:{hidden:true},
  plugin:{onLoad:()=>{},onConfig:()=>{}},betterncm:{ncm:{getNCMVersion:()=> 'test'}},setInterval:()=>0,clearInterval,clearTimeout};
 const injected=source.replace('  plugin.onLoad(()=>{','  window.testDiscover=discover;\n  plugin.onLoad(()=>{');
 vm.runInNewContext(injected,context);
 const a=context.window.testDiscover();
 assert.equal((await a.execute('get_player_state',{},Date.now()+1000)).durationMs,132000);
 await assert.rejects(a.execute('search_music',{query:'test'},Date.now()+1000),/UNSUPPORTED_API/);
 context.window.__orpheus.dispose();
});
test('a rejected concurrent plugin command cannot unlock an active command',async()=>{
 let onLoad,finish,calls=0,socket;
 class WS{static OPEN=1;readyState=1;sent=[];constructor(){socket=this;}send(s){this.sent.push(JSON.parse(s));}close(){}}
 const context={window:{},document:{hidden:false},console,WebSocket:WS,setTimeout,clearTimeout,setInterval:()=>0,clearInterval,
  plugin:{onLoad:fn=>{onLoad=fn;},onConfig:()=>{}},betterncm:{},};
 const injected=source.replace('  plugin.onLoad(()=>{',`  window.testSetup=a=>{adapter=a;connection={url:'ws://127.0.0.1:1/plugin'};connect();};\n  plugin.onLoad(()=>{`);
 vm.runInNewContext(injected,context);
 context.window.testSetup({execute:()=>{calls++;return new Promise(r=>{finish=r;});}});
 const message=id=>({data:JSON.stringify({type:'command',id,name:'get_player_state',args:{},deadline:Date.now()+1000})});
 const first=socket.onmessage(message('1'));
 await socket.onmessage(message('2'));await socket.onmessage(message('3'));
 assert.equal(calls,1);assert.equal(socket.sent.filter(m=>m.error?.startsWith('BUSY')).length,2);
 finish({connected:true});await first;context.window.__orpheus.dispose();
});
