/* Orpheus - NCM 3.x runtime adapter. No arbitrary-code tool is exposed. */
(() => {
  'use strict';
  const previous=window.__orpheus;
  if(previous)previous.dispose();
  let disposed=false, socket=null, retryTimer=null, refreshTimer=null, connection=null, adapter=null;
  let status='正在初始化', lastAction='尚未执行命令', lastError='', active=false, ncmVersion='';
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
      const assignments=[...prefix.matchAll(/[,;]([\w$]+)=\(?(?:\([^)]*\)=>)?(?:Object\([\w$]+\.[\w$]+\)\()/g)];
      const variable=assignments[assignments.length-1]?.[1];
      const escaped=variable?.replace(/[$]/g,'\\$');
      const getter=apiSource.match(new RegExp('\\.d\\([^,]+,"([^"]+)",\\(function\\(\\)\\{return '+escaped+'\\}\\)\\)'));
      const fn=getter&&req(apiId)[getter[1]];
      if(typeof fn!=='function')throw Error('UNSUPPORTED_API_EXPORT: '+path);
      return fn;
    }
    const api={search:endpoint('/api/cloudsearch/pc'),details:endpoint('/api/v3/song/detail'),playlist:endpoint('/api/v6/playlist/detail'),mine:endpoint('/api/user/playlist'),charts:endpoint('/api/toplist/detail/v2'),daily:endpoint('/api/v3/discovery/recommend/songs')};
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
      if(name==='get_player_state')return {connected:true,clientVersion:betterncm.ncm.getNCMVersion(),...player(),capabilities:['get_player_state','search_music','list_my_playlists','play_song','play_playlist','get_queue','enqueue','control_player','list_charts','play_daily']};
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
      if(name==='list_charts'){
        const r=await api.charts({});
        const isChart=i=>!!i&&typeof i==='object'&&i.id!=null&&(i.name||i.title);
        const out=[];const collect=x=>{if(Array.isArray(x)){if(x.length&&x.every(isChart)){for(const c of x)out.push(c);return;}for(const v of x)collect(v);return;}if(x&&typeof x==='object'){for(const k in x)collect(x[k]);}};
        collect(r);
        const seen=new Set();const list=out.filter(c=>{const k=String(c.id);if(!k||k==='0'||seen.has(k))return false;seen.add(k);return true;});
        if(!list){const first=Array.isArray(r&&r.list)?r.list[0]:null;throw Error('BAD_CHART_RESPONSE firstKeys='+(first?JSON.stringify(Object.keys(first)).slice(0,200):'n/a')+' topKeys='+(r&&typeof r==='object'?JSON.stringify(Object.keys(r)).slice(0,120):typeof r));}
        return {items:list.map(c=>({id:String(c.id),name:c.name||c.title||'',frequency:c.updateFrequency||'',updatedAt:c.trackNumberUpdateTime||c.updateTime||null})),total:list.length};
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
        if(args.action==='mode'){
          const map={list:'playCycle',single:'playOneCycle',random:'playRandom',order:'playOrder',fm:'playFm',ai:'playAi'};
          const target=map[args.mode]||args.mode;
          if(player().mode===target)return {verified:true,state:player()};
          dispatch('playing/switchPlayingMode',{playingMode:target,triggerScene:'playingList',HeartBeatFlage:false});
          return {verified:true,state:await waitFor(()=>player().mode===target,deadline)};
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
      if(name==='play_daily'){
        const r=await api.daily({},{uid:state().host?.uid||''});
        const songs=r&&(r.recommend||(r.data&&r.data.dailySongs)||r.dailySongs);
        if(!Array.isArray(songs)||!songs.length)throw Error('NO_DAILY_RECOMMEND keys='+(r&&typeof r==='object'?JSON.stringify(Object.keys(r)).slice(0,140):typeof r));
        const playable=songs.filter(t=>!(t.privilege?.status<0||t.privilege?.maxPlayBr===0));
        if(!playable.length)throw Error('NO_PLAYABLE_TRACKS');
        checkDeadline(deadline);play(playable,{clear:true,play:true,playId:playable[0].id});
        const observed=await waitFor(()=>player().id===String(playable[0].id)&&player().playing,deadline);
        return {verified:true,source:'每日推荐',queued:playable.length,skipped:songs.length-playable.length,items:playable.slice(0,5).map(summary),state:observed};
      }
      throw Error('UNKNOWN_TOOL');
    }
    // Access now to ensure the app store has finished initialising.
    player();return {execute,player};
  }

  const TOOL_NAMES=['get_player_state','search_music','list_my_playlists','list_charts','get_queue','play_song','play_playlist','play_daily','enqueue','control_player'];
  const LOG=[];const LOG_MAX=40;let logVer=0;
  const esc=s=>String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  const shortArgs=a=>{try{const s=JSON.stringify(a||{});return(!s||s==='{}')?'':(s.length>46?s.slice(0,46)+'…':s);}catch{return '';}};
  function appTheme(el){try{const m=getComputedStyle(el).color.match(/[\d.]+/g);if(!m)return 'dark';const r=+m[0],g=+m[1],b=+m[2];return(0.299*r+0.587*g+0.114*b)>150?'dark':'light';}catch{return 'dark';}}
  function pushLog(cmd,args,result,level){LOG.unshift({t:new Date().toLocaleTimeString('zh-CN',{hour12:false}),c:cmd+(args?' '+args:''),r:result,lv:level||''});if(LOG.length>LOG_MAX)LOG.pop();logVer++;render();}
  function render(){
    for(const p of panels){
      if(!p.isConnected){p._miss=(p._miss||0)+1;if(p._miss>20)panels.delete(p);continue;}
      p._miss=0;
      const th=appTheme(p);if(p.dataset.theme!==th)p.dataset.theme=th;
      const st=p.querySelector('[data-status]'),dot=p.querySelector('[data-dot]'),ep=p.querySelector('[data-ep]'),nv=p.querySelector('[data-ncmv]'),tk=p.querySelector('[data-token]'),body=p.querySelector('[data-log]');
      if(st)st.textContent=status;
      if(dot)dot.className='dot '+(/已连接/.test(status)?'ok':/正在连接|正在初始化/.test(status)?'warn':/未连接|失败|尚未/.test(status)?'err':'');
      if(ep)ep.textContent=connection?connection.url.replace(/^ws:\/\//,'').replace(/\/plugin$/,''):'未配对';
      if(nv)nv.textContent=ncmVersion||'—';
      if(tk)tk.textContent=connection?'已配对':'未配对';
      if(body&&body.dataset.ver!==String(logVer)){body.dataset.ver=String(logVer);body.innerHTML=LOG.length?LOG.map(x=>'<div class="line"><span class="t">'+x.t+'</span><span class="c">'+esc(x.c)+'</span><span class="r '+x.lv+'">'+esc(x.r)+'</span></div>').join(''):'<div class="empty">暂无命令记录</div>';}
    }
  }
  async function start(){
    try{ncmVersion=betterncm.ncm.getNCMVersion();}catch{}
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
      if(msg.type==='ready'){status='已连接 · Agent 可控制';lastError='';pushLog('已连接本地服务','','ok','ok');return;}
      if(msg.type!=='command')return;
      let result,error;const started=Date.now();
      try{
        if(active)throw Error('BUSY');active=true;
        if(!adapter)adapter=discover();
        lastAction='执行 '+msg.name;render();
        result=await adapter.execute(msg.name,msg.args,msg.deadline);
        lastAction=msg.name+' · '+(result.verified?'已确认':'已读取');lastError='';
        pushLog(msg.name,shortArgs(msg.args),result.verified?'verified':'ok · '+(Date.now()-started)+'ms',result.verified?'ok':'');
      }catch(e){error=e.message;lastError=error;const code=(String(error).split(':')[0]||'ERROR').trim().slice(0,24);pushLog(msg.name,shortArgs(msg.args),code,/TIMEOUT|NOT_CONFIRMED|BUSY/.test(code)?'warn':'err');}
      finally{active=false;render();}
      if(current.readyState===WebSocket.OPEN)current.send(JSON.stringify({type:'result',id:msg.id,...(error?{error}:{result})}));
    };
    current.onerror=()=>{lastError='本地服务尚未启动，正在自动重连';render();};
    current.onclose=()=>{if(disposed)return;status='服务未连接';render();retryTimer=setTimeout(connect,3000);};
  }
  plugin.onLoad(()=>{setTimeout(()=>{if(!disposed)start();},1500);});
  const PANEL_CSS=`
.orpheus{font-size:14px;line-height:1.55;color:inherit;max-width:720px;padding:26px 30px;--gap:14px;--pad:18px;--radius:16px}
.orpheus[data-theme="dark"]{--card:rgba(255,255,255,.055);--card-hi:rgba(255,255,255,.1);--border:rgba(255,255,255,.12);--hair:rgba(255,255,255,.07);--muted:rgba(255,255,255,.6);--faint:rgba(255,255,255,.38);--code:rgba(255,255,255,.08);--ok:#3fb950;--warn:#d29922;--err:#f85149;--idle:#8b949e}
.orpheus[data-theme="light"]{--card:rgba(255,255,255,.7);--card-hi:rgba(0,0,0,.045);--border:rgba(0,0,0,.11);--hair:rgba(0,0,0,.07);--muted:rgba(0,0,0,.6);--faint:rgba(0,0,0,.4);--code:rgba(0,0,0,.05);--ok:#1a7f37;--warn:#9a6700;--err:#cf222e;--idle:#6e7781}
.orpheus *{box-sizing:border-box}
.orpheus code{font-family:ui-monospace,Consolas,monospace}
.orpheus .brand{display:flex;align-items:baseline;gap:10px}
.orpheus .wordmark{font-size:34px;font-weight:700;letter-spacing:1.5px;line-height:1.05}
.orpheus .ver{font-size:12px;letter-spacing:2px;font-weight:700;color:var(--faint)}
.orpheus .sub{margin:12px 0 22px;color:var(--muted);font-size:12.5px;line-height:1.55;max-width:60ch}
.orpheus .card{border:1px solid var(--border);border-radius:var(--radius);background:var(--card);padding:var(--pad);margin-bottom:var(--gap)}
.orpheus .label{font-size:11.5px;letter-spacing:1.4px;font-weight:700;color:var(--faint);text-transform:uppercase}
.orpheus .status{display:flex;align-items:flex-start;gap:12px}
.orpheus .dot{width:9px;height:9px;border-radius:50%;flex:none;margin-top:6px;background:var(--idle)}
.orpheus .dot.ok{background:var(--ok)}.orpheus .dot.warn{background:var(--warn)}.orpheus .dot.err{background:var(--err)}
.orpheus .sbody{flex:1;min-width:0}
.orpheus .stitle{font-weight:600;font-size:15px}
.orpheus .smeta{margin-top:5px;font-size:12px;color:var(--muted);display:flex;flex-wrap:wrap;gap:6px 16px}
.orpheus .smeta code{background:var(--code);padding:1px 6px;border-radius:6px;font-size:11.5px}
.orpheus .btn{font:inherit;font-size:13px;color:inherit;cursor:pointer;padding:7px 14px;border-radius:10px;border:1px solid var(--border);background:var(--card-hi);transition:background .15s}
.orpheus .btn:hover{background:rgba(128,128,128,.2)}
.orpheus .btn.small{padding:4px 10px;font-size:12px;border-radius:8px}
.orpheus .chips{display:flex;flex-wrap:wrap;gap:8px;margin-top:11px}
.orpheus .chip{display:inline-flex;align-items:center;gap:7px;padding:5px 11px;border-radius:999px;border:1px solid var(--border);background:var(--card-hi);font-size:12.5px;font-family:ui-monospace,Consolas,monospace;color:var(--muted)}
.orpheus .chip i{width:6px;height:6px;border-radius:50%;background:var(--idle);flex:none}
.orpheus .log-head{display:flex;align-items:center;justify-content:space-between}
.orpheus .log-body{margin-top:11px;max-height:184px;overflow:auto;font-family:ui-monospace,Consolas,monospace;font-size:12px}
.orpheus .line{display:flex;gap:12px;padding:4px 0;border-bottom:1px solid var(--hair)}
.orpheus .line:last-child{border-bottom:0}
.orpheus .line .t{color:var(--faint);flex:none}
.orpheus .line .c{flex:1;min-width:0;color:inherit;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.orpheus .line .r{flex:none;color:var(--muted)}
.orpheus .r.ok{color:var(--ok)}.orpheus .r.warn{color:var(--warn)}.orpheus .r.err{color:var(--err)}
.orpheus .empty{color:var(--faint);font-size:12px;padding:6px 0}
.orpheus .foot{display:flex;gap:9px;align-items:center;margin-top:2px}
.orpheus .foot .hint{margin-left:auto;font-size:12px;color:var(--faint)}
`;
  function fallbackCopy(text){try{const ta=document.createElement('textarea');ta.value=text;ta.style.position='fixed';ta.style.opacity='0';document.body.appendChild(ta);ta.select();const ok=document.execCommand('copy');ta.remove();return ok;}catch{return false;}}
  function copyText(text,label){const ok2=ok=>{for(const p of panels){const h=p.querySelector('.foot .hint');if(h){const old=h.dataset.old||h.textContent;h.dataset.old=old;h.textContent=ok?'已复制 '+(label||''):'复制失败';clearTimeout(h._t);h._t=setTimeout(()=>{h.textContent=h.dataset.old;},1400);}}};
    try{if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(text).then(()=>ok2(true),()=>ok2(fallbackCopy(text)));return;}ok2(fallbackCopy(text));}catch{ok2(fallbackCopy(text));}}
  plugin.onConfig(()=>{
    if(!document.getElementById('orpheus-style')){const s=document.createElement('style');s.id='orpheus-style';s.textContent=PANEL_CSS;document.head.appendChild(s);}
    const panel=document.createElement('div');
    panel.className='orpheus';panel.dataset.theme='dark';
    panel.innerHTML=`
      <div class="brand"><span class="wordmark">ORPHEUS</span><span class="ver">0.1</span></div>
      <p class="sub">任何支持 MCP 的 Agent 都能用它点歌、放歌单、切歌；播放与账号权限由网易云自己处理。</p>
      <section class="card status">
        <span class="dot" data-dot></span>
        <div class="sbody">
          <div class="stitle" data-status>正在初始化</div>
          <div class="smeta">
            <span>本机服务 <code data-ep>—</code></span>
            <span>网易云 <code data-ncmv>—</code></span>
            <span>令牌 <code data-token>—</code></span>
          </div>
        </div>
        <button class="btn small" data-reconnect>重新连接</button>
      </section>
      <section class="card">
        <div class="label">可用工具 · ${TOOL_NAMES.length}</div>
        <div class="chips">${TOOL_NAMES.map(n=>'<span class="chip"><i></i>'+n+'</span>').join('')}</div>
      </section>
      <section class="card">
        <div class="log-head"><span class="label">命令日志</span><button class="btn small" data-clear>清空</button></div>
        <div class="log-body" data-log></div>
      </section>
      <div class="foot">
        <button class="btn" data-copy-diag>复制诊断信息</button>
        <button class="btn" data-copy-token>复制令牌</button>
        <span class="hint">仅本机 127.0.0.1 · 配对令牌鉴权</span>
      </div>
    `;
    panel.querySelector('[data-reconnect]').onclick=()=>{clearTimeout(retryTimer);if(socket){socket.onclose=null;socket.close();}adapter=null;start();};
    panel.querySelector('[data-clear]').onclick=()=>{LOG.length=0;logVer++;render();};
    panel.querySelector('[data-copy-token]').onclick=()=>copyText(connection?connection.token:'（未配对）','令牌');
    panel.querySelector('[data-copy-diag]').onclick=()=>copyText(['Orpheus 0.1 诊断信息','服务地址: '+(connection?connection.url:'未配对'),'网易云版本: '+(ncmVersion||'未知'),'当前状态: '+status,'— 最近命令 —'].concat(LOG.slice(0,10).map(x=>x.t+'  '+x.c+'  →  '+x.r)).join('\n'),'诊断信息');
    panels.add(panel);render();return panel;
  });
  refreshTimer=setInterval(render,1500);
  window.__orpheus={dispose(){disposed=true;clearTimeout(retryTimer);clearInterval(refreshTimer);if(socket){socket.onclose=null;socket.close();}panels.clear();}};
})();
