/* Orpheus - NCM 3.x runtime adapter. No arbitrary-code tool is exposed. */
(() => {
  'use strict';
  const previous=window.__orpheus;
  if(previous)previous.dispose();
  let disposed=false, socket=null, retryTimer=null, refreshTimer=null, connection=null, adapter=null;
  let status='正在初始化', lastAction='尚未执行命令', lastError='', active=false;
  const panels=new Set();
  const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const checkDeadline=deadline=>{if(disposed||Date.now()>deadline)throw Error('COMMAND_EXPIRED: 命令已过期，未继续操作');};
  const summary=t=>({id:String(t.id||''),name:t.name||'',artists:(t.artists||t.ar||[]).map(a=>a.name),album:(t.album||t.al||{}).name||'',durationMs:t.duration||t.dt||null});
  const playlistSummary=p=>({id:String(p.id),name:p.name,trackCount:p.trackCount,creator:p.creator?.nickname||''});

  function discover() {
    let req;
    const key='orpheus_'+Date.now();
    if(!Array.isArray(window.webpackJsonp))throw Error('UNSUPPORTED_CLIENT: 未检测到网易云 3.x 模块');
    window.webpackJsonp.push([[key],{[key]:(m,e,r)=>{req=r;}},[[key]]]);
    if(!req?.m)throw Error('UNSUPPORTED_CLIENT: 无法访问播放器模块');
    let helper, apiId, apiSource;
    for(const [id,fn] of Object.entries(req.m)){
      const source=fn.toString();
      if(source.includes('dva-tool')&&source.includes('getDispatch()')){
        helper=Object.values(req(id)).find(v=>v&&typeof v.getStore==='function'&&typeof v.getDispatch==='function');
      }
      if(source.includes('/api/cloudsearch/pc')&&source.includes('/api/v3/song/detail')){apiId=id;apiSource=source;}
    }
    if(!helper||!apiId)throw Error('UNSUPPORTED_CLIENT: 未找到播放器或搜索接口');
    const state=()=>helper.getStore();
    // Resolve exported API functions by their endpoint definitions, not numeric module IDs.
    function endpoint(path){
      const end=apiSource.indexOf('"'+path+'"');
      if(end<0)throw Error('UNSUPPORTED_API: '+path);
      const prefix=apiSource.slice(0,end);
      const assignments=[...prefix.matchAll(/[,;]([\w$]+)=\(?(?:Object\([\w$]+\.[\w$]+\)\()/g)];
      const variable=assignments[assignments.length-1]?.[1];
      const escaped=variable?.replace(/[$]/g,'\\$');
      const getter=apiSource.match(new RegExp('\\.d\\([^,]+,"([^"]+)",\\(function\\(\\)\\{return '+escaped+'\\}\\)\\)'));
      const fn=getter&&req(apiId)[getter[1]];
      if(typeof fn!=='function')throw Error('UNSUPPORTED_API_EXPORT: '+path);
      return fn;
    }
    const api={search:endpoint('/api/cloudsearch/pc'),details:endpoint('/api/v3/song/detail'),playlist:endpoint('/api/v6/playlist/detail'),mine:endpoint('/api/user/playlist')};
    const dispatch=(type,payload={})=>helper.getDispatch()({type,payload});
    function player(){
      const p=state().playing;
      if(!p)throw Error('PLAYER_NOT_READY');
      return {id:String(p.resourceTrackId||''),name:p.resourceName||'',artists:(p.resourceArtists||[]).map(a=>a.name),playing:p.playingState===2,state:({0:'stopped',1:'paused',2:'playing','-1':'ended'})[p.playingState]||'unknown',volume:Math.round((p.playingVolume||0)*100),mode:p.playingMode,durationMs:p.resourceDuration||null,trial:!!p.resourceIsTryType,observedAt:new Date().toISOString()};
    }
    function queue(){
      const s=state();
      // The DB-backed experimental queue has a different read contract. Fail explicitly.
      if(!Array.isArray(s.playingList?.curPlayingList))throw Error('UNSUPPORTED_QUEUE');
      return s.playingList.curPlayingList;
    }
    async function waitFor(test,deadline){
      while(Date.now()<deadline&&!disposed){if(test())return player();await delay(180);}
      throw Error('NOT_CONFIRMED: 客户端未确认目标状态；可能是版权、网络或接口变化，请查询当前状态');
    }
    async function tracks(ids){
      const list=await api.details({c:JSON.stringify(ids.map(id=>({id,v:0})))},{uid:state().host?.uid||''});
      if(!Array.isArray(list))throw Error('BAD_SONG_RESPONSE');
      return list;
    }
    function play(items,{clear=false,play=true,playId,playlistId}={}){
      dispatch('playing/play',{
        tracks:items,from:{resourceType:'track',scene:playlistId?'playlist':'search',text:'Orpheus',href:playlistId?'/playlist?id='+playlistId:'',fromInfo:{originalScene:playlistId?'playlist':'search',originalResourceType:playlistId?'playlist':'track',computeResourceType:'track',computeSourceResourceType:playlistId?'playlist':'track',sourceData:{id:playlistId||items[0]?.id,name:'Orpheus'}}},
        options:{clear,play,playId:playId||items[0]?.id},triggerScene:'playingList',
      });
    }
    async function execute(name,args,deadline){
      checkDeadline(deadline);
      if(name==='get_player_state')return {connected:true,clientVersion:betterncm.ncm.getNCMVersion(),...player(),capabilities:['get_player_state','search_music','list_my_playlists','play_song','play_playlist','get_queue','enqueue','control_player']};
      if(name==='search_music'){
        const r=await api.search({s:args.query,type:args.type==='playlist'?1000:1,limit:args.limit,offset:0});
        if(r.code&&r.code!==200)throw Error('SEARCH_FAILED: '+r.code);
        const data=r.result;if(!data)throw Error('BAD_SEARCH_RESPONSE');
        return {query:args.query,type:args.type,total:args.type==='playlist'?data.playlistCount:data.songCount,items:args.type==='playlist'?(data.playlists||[]).map(playlistSummary):(data.songs||[]).map(summary)};
      }
      if(name==='list_my_playlists'){
        const uid=state().host?.uid;if(!uid)throw Error('LOGIN_REQUIRED');
        const r=await api.mine({uid,limit:1000,offset:0});
        if(!Array.isArray(r.playlist))throw Error('BAD_PLAYLIST_RESPONSE');
        return {items:r.playlist.slice(args.offset,args.offset+args.limit).map(playlistSummary),more:!!r.more||r.playlist.length>args.offset+args.limit,offset:args.offset};
      }
      if(name==='get_queue')return {items:queue().slice(args.offset,args.offset+args.limit).map(q=>summary(q.track||q)),total:queue().length,mode:player().mode,offset:args.offset};
      if(name==='control_player'){
        const before=player();checkDeadline(deadline);
        if(args.action==='pause'||args.action==='resume'){
          const desired=args.action==='resume';
          if(before.playing===desired&&(before.id||!desired))return {verified:true,state:before};
          dispatch(desired?'playing/resume':'playing/pause');
          return {verified:true,state:await waitFor(()=>player().playing===desired,deadline)};
        }
        if(args.action==='volume'){
          const native=window.legacyNativeCmder?._envAdapter;
          if(!native)throw Error('UNSUPPORTED_VOLUME');
          native.callAdapter('audioplayer.setVolume',()=>{},['','',args.volume/100]);
          return {verified:true,state:await waitFor(()=>Math.abs(player().volume-args.volume)<=1,deadline)};
        }
        if(!before.id)throw Error('NO_CURRENT_TRACK');
        // Use the client's own next/previous dispatch (same path as the UI button,
        // keyboard shortcut and tray menu) instead of a version-fragile DOM selector.
        const dir=args.action==='next'?1:-1;
        if(player().mode==='playFm')dispatch(dir===1?'fmPlaying/playNext':'fmPlaying/playPre');
        else dispatch('playingList/jump2Track',{flag:dir,type:'call'});
        return {verified:true,state:await waitFor(()=>player().id!==before.id&&player().playing,deadline)};
      }
      if(name==='play_song'||name==='enqueue'){
        const ids=name==='play_song'?[args.id]:[...new Set(args.ids)];
        const items=await tracks(ids);
        if(items.length!==ids.length)throw Error('SONG_NOT_FOUND');
        if(items.some(t=>t.privilege?.status<0||t.privilege?.maxPlayBr===0))throw Error('UNPLAYABLE: 当前账号无法播放请求中的歌曲');
        checkDeadline(deadline);play(items,{play:name==='play_song',playId:args.id});
        const observed=await waitFor(()=>name==='play_song'?player().id===args.id&&player().playing:ids.every(id=>queue().some(q=>String(q.track?.id||q.resourceId||q.id)===id)),deadline);
        return {verified:true,state:observed,added:ids};
      }
      if(name==='play_playlist'){
        const r=await api.playlist({id:args.id,n:1000,s:0});
        const p=r.playlist;if(!p)throw Error('PLAYLIST_NOT_FOUND');
        const ids=(p.trackIds||p.tracks||[]).map(t=>String(t.id));
        if(!ids.length)throw Error('EMPTY_PLAYLIST');
        if(ids.length>1000||p.trackCount>1000)throw Error('PLAYLIST_TOO_LARGE: 当前版本支持最多 1000 首；未改变播放队列');
        let items=[];
        for(let start=0;start<ids.length;start+=100){checkDeadline(deadline);items.push(...await tracks(ids.slice(start,start+100)));}
        const playable=items.filter(t=>!(t.privilege?.status<0||t.privilege?.maxPlayBr===0));
        if(!playable.length)throw Error('NO_PLAYABLE_TRACKS');
        checkDeadline(deadline);
        play(playable,{clear:true,play:true,playId:playable[0].id,playlistId:args.id});
        const expectedMode=args.shuffle?'playRandom':'playCycle';
        await waitFor(()=>player().id===String(playable[0].id)&&player().playing,deadline);
        checkDeadline(deadline);dispatch('playing/switchPlayingMode',{playingMode:expectedMode,triggerScene:'playingList',HeartBeatFlage:false});
        const observed=await waitFor(()=>player().mode===expectedMode,deadline);
        return {verified:true,playlist:playlistSummary(p),queued:playable.length,skipped:ids.length-playable.length,state:observed};
      }
      throw Error('UNKNOWN_TOOL');
    }
    // Access now to ensure the app store has finished initialising.
    player();return {execute,player};
  }

  function render(){for(const p of panels){if(!p.isConnected){panels.delete(p);continue;}const a=p.querySelector('[data-status]'),b=p.querySelector('[data-track]'),c=p.querySelector('[data-log]');a.textContent=status;try{const s=adapter?.player();b.textContent=s?.name?`${s.playing?'正在播放':'已暂停'} · ${s.name} / ${s.artists.join('、')}`:'等待播放歌曲';}catch{b.textContent='播放器初始化中';}c.textContent=lastError||lastAction;}}
  async function start(){
    try{
      const blob=await betterncm.fs.readFile(plugin.pluginPath+'/connection.json');
      connection=JSON.parse(await blob.text());
      if(!/^ws:\/\/127\.0\.0\.1:\d+\/plugin$/.test(connection.url)||!/^[a-f0-9]{64}$/.test(connection.token))throw Error('连接配置无效');
    }catch(e){status='尚未配对';lastError='请运行项目中的安装脚本，生成本机连接配置。';render();return;}
    connect();
  }
  function connect(){
    if(disposed)return;
    status='正在连接本地服务';render();
    try{socket=new WebSocket(connection.url);}catch(e){lastError=e.message;retryTimer=setTimeout(connect,3000);return;}
    const current=socket;
    current.onopen=()=>current.send(JSON.stringify({type:'hello',token:connection.token,version:'0.1.0'}));
    current.onmessage=async(event)=>{
      let msg;try{msg=JSON.parse(event.data);}catch{return;}
      if(msg.type==='ready'){status='已连接 · Agent 可控制';lastError='';render();return;}
      if(msg.type!=='command')return;
      let result,error;
      try{
        if(active)throw Error('BUSY');active=true;
        if(!adapter)adapter=discover();
        lastAction='执行 '+msg.name;render();
        result=await adapter.execute(msg.name,msg.args,msg.deadline);
        lastAction=msg.name+' · '+(result.verified?'已确认':'已读取');lastError='';
      }catch(e){error=e.message;lastError=error;}
      finally{active=false;render();}
      if(current.readyState===WebSocket.OPEN)current.send(JSON.stringify({type:'result',id:msg.id,...(error?{error}:{result})}));
    };
    current.onerror=()=>{lastError='本地服务尚未启动，正在自动重连';render();};
    current.onclose=()=>{if(disposed)return;status='服务未连接';render();retryTimer=setTimeout(connect,3000);};
  }
  plugin.onLoad(()=>{setTimeout(()=>{if(!disposed)start();},1500);});
  plugin.onConfig(()=>{
    const panel=document.createElement('div');panel.style.cssText='padding:26px;max-width:660px;font-family:inherit;color:inherit';
    panel.innerHTML=`<div style="font-size:12px;letter-spacing:2px;opacity:.6">ORPHEUS / 0.1</div><h1 style="font-size:28px;margin:12px 0">把点歌交给你的 Agent</h1><p style="opacity:.75;line-height:1.8">在 Codex 或 Hermes 里说出想听的歌。播放与账号权限由网易云处理。</p><div style="padding:20px;border:1px solid #ffffff24;border-radius:16px;background:#ffffff08;margin-top:22px"><div data-status style="font-weight:600;color:#7ee2be"></div><p data-track style="line-height:1.7"></p><div data-log style="font-size:12px;opacity:.65;word-break:break-all"></div></div><p style="margin-top:20px;line-height:1.8;opacity:.7">支持搜索、点歌、播放歌单、待播队列、暂停和音量。<br>连接仅限本机，使用配对令牌；无需在插件内填写模型密钥。</p><button data-reconnect style="padding:9px 18px;border:1px solid #ffffff30;border-radius:9px;background:#ffffff10;color:inherit;cursor:pointer">重新连接</button>`;
    panel.querySelector('[data-reconnect]').onclick=()=>{clearTimeout(retryTimer);if(socket){socket.onclose=null;socket.close();}adapter=null;start();};
    panels.add(panel);setTimeout(render,0);return panel;
  });
  refreshTimer=setInterval(render,1500);
  window.__orpheus={dispose(){disposed=true;clearTimeout(retryTimer);clearInterval(refreshTimer);if(socket){socket.onclose=null;socket.close();}panels.clear();}};
})();
