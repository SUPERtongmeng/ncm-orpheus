import { callBridge } from './client.js';
try{console.log(JSON.stringify(await callBridge(process.argv[2]||'get_player_state',JSON.parse(process.argv[3]||'{}')),null,2));}
catch(e){console.error(e.message);process.exitCode=1;}
