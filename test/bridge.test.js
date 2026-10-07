import {test} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {WebSocket} from 'ws';
import {createBridge} from '../src/server.js';
import {validateCommand} from '../src/tools.js';
const token='a'.repeat(64);
async function setup(t,timeoutMs=1000){
 const bridge=createBridge({token,timeoutMs});bridge.server.listen(0,'127.0.0.1');await once(bridge.server,'listening');
 const port=bridge.server.address().port;t.after(()=>bridge.close());return {bridge,url:`http://127.0.0.1:${port}`,wsurl:`ws://127.0.0.1:${port}/plugin`};
}
async function connect(wsurl){const ws=new WebSocket(wsurl);await once(ws,'open');ws.send(JSON.stringify({type:'hello',token}));await once(ws,'message');return ws;}
test('HTTP rejects missing auth and browser origins',async t=>{const {url}=await setup(t);assert.equal((await fetch(url+'/health')).status,401);assert.equal((await fetch(url+'/health',{headers:{Authorization:`Bearer ${token}`,Origin:'https://evil.example'}})).status,403);});
test('plugin must authenticate; offline never reports success',async t=>{const {bridge,wsurl}=await setup(t);const ws=new WebSocket(wsurl);await once(ws,'open');ws.send(JSON.stringify({type:'hello',token:'bad'}));await once(ws,'close');assert.throws(()=>bridge.execute('get_player_state',{}),/OFFLINE/);});
test('round trip correlates result and rejects concurrent commands',async t=>{const {bridge,wsurl}=await setup(t);const ws=await connect(wsurl);const received=once(ws,'message');const p=bridge.execute('play_song',{id:'186016'});assert.throws(()=>bridge.execute('get_player_state',{}),/BUSY/);const [raw]=await received;const cmd=JSON.parse(raw);assert.equal(cmd.name,'play_song');ws.send(JSON.stringify({type:'result',id:'wrong',result:{verified:true}}));ws.send(JSON.stringify({type:'result',id:cmd.id,result:{verified:true,state:{id:'186016'}}}));assert.deepEqual(await p,{verified:true,state:{id:'186016'}});});
test('timeout is an error, with no queued retry',async t=>{const {bridge,wsurl}=await setup(t,80);await connect(wsurl);await assert.rejects(bridge.execute('control_player',{action:'next'}),/TIMEOUT/);});
test('disconnect reports unknown outcome',async t=>{const {bridge,wsurl}=await setup(t);const ws=await connect(wsurl);const p=bridge.execute('play_song',{id:'186016'});const rejection=assert.rejects(p,/DISCONNECTED/);ws.close();await rejection;});
test('schema rejects arbitrary execution and invalid volume / IDs',()=>{assert.throws(()=>validateCommand('eval',{code:'1'}));assert.throws(()=>validateCommand('control_player',{action:'volume',volume:150}));assert.throws(()=>validateCommand('control_player',{action:'volume'}));assert.throws(()=>validateCommand('play_song',{id:'../../etc'}));assert.throws(()=>validateCommand('play_song',{id:'1',code:'evil'}));});
