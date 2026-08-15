/* GLAZOK STUDIO */
const $=id=>document.getElementById(id);
const $$=(sel,root=document)=>[...root.querySelectorAll(sel)];
const log=(...a)=>console.log('%c[G]%c','color:#ff6b4a;font-weight:bold','',...a);
const err=(...a)=>console.error('%c[G!]','color:#ff4b4b;font-weight:bold',...a);

function toast(msg,type='ok',ms=3000){
  const el=document.createElement('div');
  el.className=`toast ${type}`;
  el.innerHTML=`<span class="ico">${type==='ok'?'✓':type==='err'?'✕':'⚠'}</span><span>${msg}</span>`;
  $('toasts').appendChild(el);
  setTimeout(()=>{el.classList.add('out');setTimeout(()=>el.remove(),300);},ms);
}
function vibrate(ms=20){try{navigator.vibrate&&navigator.vibrate(ms);}catch(e){}}
function debounce(fn,ms){let t;return(...a)=>{clearTimeout(t);t=setTimeout(()=>fn(...a),ms);};}

const state={mode:null,peer:null,room:null,stream:null,call:null,data:null,connections:new Map(),outputs:new Map(),activeCam:null,viewMode:'auto',filters:{contrast:100,sat:100},zen:false,torch:false,wakeLock:null,fps:{frames:0,last:performance.now(),val:0},ping:{last:0,val:0},bitrate:'auto',stats:new Map()};

(function setupPWA(){
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="112" fill="#0b0b0e"/><circle cx="256" cy="256" r="110" fill="none" stroke="#ff6b4a" stroke-width="36"/><circle cx="256" cy="256" r="46" fill="#ff6b4a"/></svg>`;
  const iconUrl='data:image/svg+xml;base64,'+btoa(svg);
  const manifest={name:'Glazok',short_name:'Glazok',start_url:'.',display:'standalone',background_color:'#0b0b0e',theme_color:'#0b0b0e',icons:[{src:iconUrl,sizes:'any',type:'image/svg+xml'}]};
  const blob=new Blob([JSON.stringify(manifest)],{type:'application/json'});
  const link=document.createElement('link');
  link.rel='manifest';link.href=URL.createObjectURL(blob);
  document.head.appendChild(link);
  let prompt=null;
  window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();prompt=e;if($('install-btn')){$('install-btn').style.display='flex';$('install-btn').onclick=()=>{prompt.prompt();prompt=null;};}});
  const m=new URLSearchParams(location.search).get('m');
  if(m==='monitor') setTimeout(()=>setMode('monitor'),100);
  if(m==='camera') setTimeout(()=>setMode('camera'),100);
})();

function setMode(mode){
  state.mode=mode;
  $$('.screen').forEach(s=>s.classList.remove('active'));
  if(mode==='monitor'){$('screen-monitor').classList.add('active');initMonitor();}
  else if(mode==='camera'){$('screen-camera').classList.add('active');initCamera();}
  else $('screen-select').classList.add('active');
}
function exit(){teardown();setMode(null);}
function teardown(){
  try{state.peer&&state.peer.destroy();}catch(e){}
  state.peer=null;
  if(state.stream){state.stream.getTracks().forEach(t=>t.stop());state.stream=null;}
  state.connections.clear();state.outputs.clear();
  state.call=null;state.data=null;
  if($('v-grid'))$('v-grid').innerHTML='';
  if(state.wakeLock){try{state.wakeLock.release();}catch(e){}state.wakeLock=null;}
}
function randCode(n){const a='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';let s='';for(let i=0;i<n;i++)s+=a[Math.floor(Math.random()*a.length)];return s;}

const PEER_CFG={config:{iceServers:[{urls:'stun:stun.l.google.com:19302'},{urls:'stun:stun1.l.google.com:19302'},{urls:'turn:openrelay.metered.ca:80',username:'openrelayproject',credential:'openrelayproject'},{urls:'turn:openrelay.metered.ca:443',username:'openrelayproject',credential:'openrelayproject'}]},debug:0};

function initMonitor(){
  const room=randCode(6).toLowerCase();
  state.room=room;
  const peer=new Peer('glz-'+room,PEER_CFG);
  state.peer=peer;
  peer.on('open',()=>{
    $('m-dot').className='dot ok';$('m-text').textContent='Готов';
    $('qr-code').textContent=room.toUpperCase();renderQR();showQR(true);
    toast('Код: '+room.toUpperCase());
  });
  peer.on('connection',conn=>{
    conn.on('open',()=>{
      const peerId=conn.peer;const isOutput=peerId.startsWith('output-');
      if(isOutput){
        state.outputs.set(peerId,{conn,mode:'single'});log('Output:',peerId);
        toast('OBS Output подключён');
        conn.on('data',d=>handleOutputMessage(peerId,d));
      }else{
        const entry=state.connections.get(peerId)||{};
        entry.conn=conn;entry.connectedAt=Date.now();state.connections.set(peerId,entry);
        log('Камера:',peerId);
        conn.on('data',d=>{
          if(d.type==='PING'){try{conn.send({type:'PONG',t:Date.now()});}catch(e){}}
          if(d.type==='FPS'){const e=state.connections.get(peerId);if(e)e.fps=d.fps;updateNetInfo();}
          if(d.type==='STATS'){const e=state.connections.get(peerId);if(e){e.remoteStats=d.stats;updateCamStats();}}
        });
        setTimeout(()=>sendAllSettings(conn),500);broadcastAir();
      }
    });
    conn.on('close',()=>{
      if(conn.peer.startsWith('output-')){state.outputs.delete(conn.peer);toast('OBS Output отключён','warn');}
    });
  });
  peer.on('call',call=>{
    call.answer();
    const entry=state.connections.get(call.peer)||{};
    entry.call=call;state.connections.set(call.peer,entry);
    call.on('stream',s=>{
      const e=state.connections.get(call.peer)||{};
      e.stream=s;state.connections.set(call.peer,e);
      showQR(false);updateGrid();
      broadcastStreamToOutputs(call.peer,s);
      startStatsCollection(call.peer);
      toast('Камера подключена');
    });
    call.on('close',()=>{
      state.connections.delete(call.peer);state.stats.delete(call.peer);
      updateGrid();updateCamStats();
      notifyOutputs('CAM_REMOVED',{camId:call.peer,count:state.connections.size});
      toast('Камера отключилась','warn');
    });
  });
  peer.on('error',e=>{
    err('Peer error:',e);
    if(e.type==='unavailable'){toast('Комната занята...','warn');setTimeout(()=>{teardown();initMonitor();},2000);}
  });
}

function handleOutputMessage(outputId,d){
  if(d.type==='OUTPUT_JOIN'){
    const output=state.outputs.get(outputId);if(output)output.mode=d.mode||'single';
    const cams=[...state.connections.keys()].filter(k=>state.connections.get(k).stream);
    try{state.outputs.get(outputId).conn.send({type:'CAM_LIST',cams});}catch(e){}
    state.connections.forEach((entry,camId)=>{
      if(entry.stream){try{state.peer.call(outputId,entry.stream);}catch(e){}}
    });
  }
}
function broadcastStreamToOutputs(camId,stream){
  state.outputs.forEach((output,outputId)=>{try{state.peer.call(outputId,stream);}catch(e){}});
  notifyOutputs('CAM_ADDED',{camId,count:state.connections.size});
}
function notifyOutputs(type,data){
  state.outputs.forEach(output=>{
    if(output.conn&&output.conn.open){try{output.conn.send({type,...data});}catch(e){}}
  });
}
function sendAllSettings(conn){
  try{
    const z=document.querySelector('[data-ctrl="zoom"]');
    const e=document.querySelector('[data-ctrl="exposure"]');
    conn.send({type:'CTRL',param:'bitrate',value:state.bitrate});
    if(z)conn.send({type:'CTRL',param:'zoom',value:z.value});
    if(e)conn.send({type:'CTRL',param:'exposure',value:e.value});
  }catch(e){}
}
function startStatsCollection(peerId){
  const interval=setInterval(()=>{
    const entry=state.connections.get(peerId);
    if(!entry||!entry.call||!entry.call.peerConnection){clearInterval(interval);return;}
    entry.call.peerConnection.getStats().then(stats=>{
      const s={bitrate:0,packetsLost:0,packetsReceived:0,jitter:0,rtt:0,fps:0,resolution:'',codec:''};
      stats.forEach(r=>{
        if(r.type==='inbound-rtp'&&r.kind==='video'){
          const prev=state.stats.get(peerId);
          if(prev&&prev.bytesReceived&&prev.timestamp){
            const t=(r.timestamp-prev.timestamp)/1000;const b=r.bytesReceived-prev.bytesReceived;
            s.bitrate=Math.round((b*8)/t/1000);
          }
          s.packetsLost=r.packetsLost||0;s.packetsReceived=r.packetsReceived||0;
          s.jitter=r.jitter||0;s.fps=r.framesPerSecond||0;
          s.resolution=r.frameWidth?`${r.frameWidth}x${r.frameHeight}`:'';
          state.stats.set(peerId,{bytesReceived:r.bytesReceived,timestamp:r.timestamp});
        }
        if(r.type==='candidate-pair'&&r.state==='succeeded'){s.rtt=r.currentRoundTripTime?Math.round(r.currentRoundTripTime*1000):0;}
        if(r.type==='codec'&&r.mimeType&&r.mimeType.includes('video')){s.codec=r.mimeType.split('/')[1]||'';}
      });
      const e=state.connections.get(peerId);if(e){e.webrtcStats=s;updateNetInfo();updateCamStats();}
    });
  },2000);
}
function renderQR(){
  $('qr-box').innerHTML='';
  const url=location.origin+location.pathname+'?m=camera&room='+state.room;
  new QRCode($('qr-box'),{text:url,width:160,height:160,colorDark:'#0b0b0e',colorLight:'#ffffff'});
}
function showQR(v){$('qr-modal').classList.toggle('visible',v);}
function updateGrid(){
  const g=$('v-grid'),bar=$('cam-bar');if(!g)return;
  g.innerHTML='';bar.innerHTML='';
  const keys=[...state.connections.keys()].filter(k=>state.connections.get(k).stream);
  if(keys.length===0){
    $('m-dot').className='dot';$('m-text').textContent='Ожидание...';
    $('live').classList.remove('on');showQR(true);
    g.className='video-grid v-1';
    g.innerHTML='<div class="video-box"><div class="empty">Ожидание камер...</div></div>';return;
  }
  $('m-dot').className='dot live';$('m-text').textContent=`В эфире: ${keys.length}`;
  $('live').classList.add('on');
  if(!state.activeCam||!keys.includes(state.activeCam))state.activeCam=keys[0];
  keys.forEach((k,i)=>{
    const b=document.createElement('button');
    b.className='btn'+(k===state.activeCam&&state.viewMode==='single'?' active':'');
    b.textContent='📱 К'+(i+1);
    b.onclick=()=>{state.activeCam=k;state.viewMode='single';updateGrid();broadcastAir();};
    bar.appendChild(b);
  });
  if(keys.length>1){
    const gb=document.createElement('button');
    gb.className='btn'+(state.viewMode==='grid'?' active':'');
    gb.textContent='🖼 Сетка';
    gb.onclick=()=>{state.viewMode='grid';updateGrid();broadcastAir();};
    bar.appendChild(gb);
  }
  const isGrid=state.viewMode==='grid'||(state.viewMode==='auto'&&keys.length>1);
  g.className='video-grid v-'+Math.min(keys.length,4);
  (isGrid?keys.slice(0,4):[state.activeCam]).forEach(k=>{
    const box=document.createElement('div');box.className='video-box';
    const v=document.createElement('video');v.autoplay=true;v.playsInline=true;
    v.srcObject=state.connections.get(k).stream;
    v.onloadeddata=()=>{v.classList.add('loaded');applyFilters(v);};
    box.appendChild(v);g.appendChild(box);
  });
}
function applyFilters(v){v.style.filter=`contrast(${state.filters.contrast}%) saturate(${state.filters.sat}%)`;}
function applyAllFilters(){$$('#v-grid video').forEach(applyFilters);}
function broadcastAir(){
  const keys=[...state.connections.keys()].filter(k=>state.connections.get(k).stream);
  const isGrid=state.viewMode==='grid'||(state.viewMode==='auto'&&keys.length>1);
  state.connections.forEach((item,k)=>{
    if(item.conn&&item.conn.open){try{item.conn.send({type:'AIR',onAir:isGrid||k===state.activeCam});}catch(e){}}
  });
}
function updateNetInfo(){
  const keys=[...state.connections.keys()].filter(k=>state.connections.get(k).stream);
  if(keys.length===0)return;
  const e=state.connections.get(state.activeCam||keys[0]);if(!e)return;
  const s=e.webrtcStats||{};
  const fps=e.fps||s.fps||0;const ping=s.rtt||state.ping.val||0;
  const bitrate=s.bitrate||0;
  const loss=s.packetsReceived?Math.round((s.packetsLost/(s.packetsLost+s.packetsReceived))*100):0;
  $('net-fps').textContent=fps;$('net-ping').textContent=ping;
  $('net-bitrate').textContent=bitrate;$('net-loss').textContent=loss;
  const box=$('net-info');
  box.classList.toggle('good',ping<50&&fps>25&&loss<2);
  box.classList.toggle('bad',ping>200||fps<15||loss>10);
}
function updateCamStats(){
  const c=$('cam-stats');if(!c)return;
  const keys=[...state.connections.keys()].filter(k=>state.connections.get(k).stream);
  if(keys.length===0){c.innerHTML='<span style="color:var(--muted)">Нет камер</span>';return;}
  let h='';
  keys.forEach((k,i)=>{
    const e=state.connections.get(k);const s=e.webrtcStats||{};
    h+=`<div style="margin-bottom:8px"><div style="color:var(--accent)">📱 К${i+1}</div>`;
    h+=`<div>Bitrate: ${s.bitrate||'—'} kbps</div>`;
    h+=`<div>FPS: ${s.fps||e.fps||'—'}</div>`;
    h+=`<div>RTT: ${s.rtt||'—'} ms</div>`;
    h+=`<div>Loss: ${s.packetsReceived?Math.round((s.packetsLost/(s.packetsLost+s.packetsReceived))*100):'—'}%</div>`;
    h+=`<div>Res: ${s.resolution||'—'}</div></div>`;
  });
  c.innerHTML=h;
}
const onCtrl=debounce((p,v)=>{
  state.connections.forEach(item=>{
    if(item.conn&&item.conn.open){try{item.conn.send({type:'CTRL',param:p,value:parseFloat(v)||v});}catch(e){}}
  });
},40);
async function initCamera(){
  if('wakeLock' in navigator){try{state.wakeLock=await navigator.wakeLock.request('screen');}catch(e){}}
  const room=new URLSearchParams(location.search).get('room');
  if(room){$('cam-card').style.display='none';startPhone('glz-'+room.toLowerCase());return;}
  $('cam-card').style.display='flex';
}
function presets(p){
  const m={'4k30':[3840,2160,30],'2k30':[2560,1440,30],'1080p60':[1920,1080,60],'1080p30':[1920,1080,30],'720p30':[1280,720,30],'480p30':[854,480,30]};
  const [w,h,f]=m[p]||m['2k30'];
  return {width:{ideal:w},height:{ideal:h},frameRate:{ideal:f},facingMode:{ideal:'environment'}};
}
async function startPhone(targetId){
  try{
    const q=$('c-quality').value;
    state.stream=await navigator.mediaDevices.getUserMedia({video:presets(q),audio:false});
    $('c-video').srcObject=state.stream;
    $('cam-view').classList.add('on');$('cam-card').style.display='none';
    await listCams();detectCaps();
    const p=new Peer('cam-'+randCode(8).toLowerCase(),PEER_CFG);state.peer=p;
    p.on('open',()=>{
      state.data=p.connect(targetId);
      state.data.on('data',d=>{
        if(d.type==='AIR')updateAirBadge(d.onAir);
        if(d.type==='CTRL')applyConstraint(d.param,d.value);
        if(d.type==='TORCH')toggleTorch(true,d.on);
        if(d.type==='PONG'){state.ping.val=Math.round(Date.now()-state.ping.last);updateCamNetInfo();sendFPS();}
      });
      state.data.on('open',()=>startCamStatsSender());
      state.call=p.call(targetId,state.stream);toast('Подключение...');
    });
    p.on('error',e=>{
      err('Phone peer:',e);toast('Ошибка: '+e.type,'err');
      if(e.type==='peer-unavailable'||e.type==='network'){setTimeout(()=>{teardown();startPhone(targetId);},3000);}
    });
    startFPSCounter();
  }catch(e){err('getUserMedia:',e);toast('Нет доступа к камере','err');exit();}
}
function startCamStatsSender(){
  setInterval(()=>{
    if(!state.call||!state.call.peerConnection)return;
    state.call.peerConnection.getStats().then(stats=>{
      const s={bitrate:0,fps:0,resolution:''};
      stats.forEach(r=>{
        if(r.type==='outbound-rtp'&&r.kind==='video'){
          s.fps=r.framesPerSecond||0;
          s.resolution=r.frameWidth?`${r.frameWidth}x${r.frameHeight}`:'';
          const prev=state._lastStats;
          if(prev&&prev.bytesSent&&prev.timestamp){
            const t=(r.timestamp-prev.timestamp)/1000;const b=r.bytesSent-prev.bytesSent;
            s.bitrate=Math.round((b*8)/t/1000);
          }
          state._lastStats={bytesSent:r.bytesSent,timestamp:r.timestamp};
        }
      });
      if(state.data&&state.data.open){try{state.data.send({type:'STATS',stats:s});}catch(e){}}
      updateCamNetInfo(s);
    });
  },2000);
}
function updateCamNetInfo(s={}){
  const ping=state.ping.val||0;const fps=state.fps.val||s.fps||0;const bitrate=s.bitrate||0;
  if($('c-net-ping'))$('c-net-ping').textContent=ping;
  if($('c-net-fps'))$('c-net-fps').textContent=fps;
  if($('c-net-bitrate'))$('c-net-bitrate').textContent=bitrate;
}
function updateAirBadge(on){
  const d=$('c-dot'),t=$('c-text');
  if(on){d.className='dot live';t.textContent='🔴 В ЭФИРЕ';t.style.color='var(--danger)';vibrate(30);}
  else{d.className='dot';t.textContent='⏸ ОЖИДАНИЕ';t.style.color='var(--muted)';}
}
async function listCams(){
  try{
    const devs=await navigator.mediaDevices.enumerateDevices();
    const sel=$('c-cam');sel.innerHTML='';
    devs.filter(d=>d.kind==='videoinput').forEach((d,i)=>{
      const o=document.createElement('option');
      o.value=d.deviceId;o.textContent=d.label||('Камера '+(i+1));sel.appendChild(o);
    });
  }catch(e){}
}
function detectCaps(){
  if(!state.stream)return;
  const t=state.stream.getVideoTracks()[0];if(!t.getCapabilities)return;
  const c=t.getCapabilities();
  if(c.zoom){$('r-zoom').style.display='flex';$('s-zoom').min=c.zoom.min||1;$('s-zoom').max=c.zoom.max||5;$('s-zoom').step=c.zoom.step||0.1;}
  if(c.exposureCompensation){$('r-exp').style.display='flex';$('s-exp').min=c.exposureCompensation.min||-2;$('s-exp').max=c.exposureCompensation.max||2;$('s-exp').step=c.exposureCompensation.step||0.1;}
  if($('b-torch'))$('b-torch').style.display=c.torch?'inline-flex':'none';
}
async function applyConstraint(p,v){
  if(!state.stream)return;
  const t=state.stream.getVideoTracks()[0];
  try{
    if(p==='bitrate'){
      state.bitrate=v;
      if(state.call&&state.call.peerConnection){
        const sender=state.call.peerConnection.getSenders().find(s=>s.track?.kind==='video');
        if(sender){
          const params=sender.getParameters();
          if(!params.encodings)params.encodings=[{}];
          if(v==='auto')delete params.encodings[0].maxBitrate;
          else params.encodings[0].maxBitrate=parseInt(v)*1000;
          await sender.setParameters(params);
        }
      }
      return;
    }
    const param=p==='exposure'?'exposureCompensation':p;
    await t.applyConstraints({advanced:[{[param]:parseFloat(v)}]});
    if(p==='zoom'){$('s-zoom').value=v;$('v-zoom').textContent=parseFloat(v).toFixed(1);}
    if(p==='exposure'){$('s-exp').value=v;$('v-exp').textContent=parseFloat(v).toFixed(1);}
  }catch(e){}
}
async function switchCam(id){
  if(!id||!state.stream)return;
  state.stream.getTracks().forEach(t=>t.stop());
  const c=presets($('c-quality').value);c.deviceId={exact:id};
  state.stream=await navigator.mediaDevices.getUserMedia({video:c,audio:false});
  $('c-video').srcObject=state.stream;detectCaps();
  if(state.call&&state.call.peerConnection){
    const sender=state.call.peerConnection.getSenders().find(s=>s.track?.kind==='video');
    if(sender)sender.replaceTrack(state.stream.getVideoTracks()[0]);
  }
}
async function changeQuality(){
  if(!state.stream)return;
  try{await state.stream.getVideoTracks()[0].applyConstraints(presets($('c-quality').value));}catch(e){}
}
async function toggleTorch(forced,on){
  if(!state.stream)return;
  const t=state.stream.getVideoTracks()[0];state.torch=forced?on:!state.torch;
  try{await t.applyConstraints({advanced:[{torch:state.torch}]});if($('b-torch'))$('b-torch').classList.toggle('active',state.torch);vibrate(20);}catch(e){}
}
(function pinchZoom(){
  const vid=$('c-video');if(!vid)return;let scale=1,lastDist=0;
  vid.addEventListener('touchstart',e=>{if(e.touches.length===2){lastDist=Math.hypot(e.touches[0].clientX-e.touches[1].clientX,e.touches[0].clientY-e.touches[1].clientY);}},{passive:true});
  vid.addEventListener('touchmove',e=>{if(e.touches.length===2){const d=Math.hypot(e.touches[0].clientX-e.touches[1].clientX,e.touches[0].clientY-e.touches[1].clientY);scale=Math.max(1,Math.min(5,scale+(d-lastDist)*0.01));lastDist=d;vid.style.transform=`scale(${scale})`;}},{passive:true});
  vid.addEventListener('touchend',()=>{lastDist=0;});
})();
(function tapFocus(){
  const vid=$('c-video'),focus=$('c-focus');if(!vid)return;
  vid.addEventListener('click',async e=>{
    if(!state.stream)return;
    const t=state.stream.getVideoTracks()[0];const caps=t.getCapabilities?.()||{};
    if(!caps.focusMode)return;
    const r=vid.getBoundingClientRect();
    const x=(e.clientX-r.left)/r.width;const y=(e.clientY-r.top)/r.height;
    focus.style.left=e.clientX+'px';focus.style.top=e.clientY+'px';
    focus.classList.add('show');setTimeout(()=>focus.classList.remove('show'),800);
    try{await t.applyConstraints({advanced:[{focusMode:'single-shot',pointOfInterest:{x,y}}]});vibrate(15);}catch(e){}
  });
})();
function startFPSCounter(){
  let last=performance.now(),frames=0;
  const tick=()=>{
    frames++;const now=performance.now();
    if(now-last>=1000){state.fps.val=frames;frames=0;last=now;sendFPS();}
    if(state.mode==='camera')requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
function sendFPS(){
  if(state.data?.open){
    state.ping.last=Date.now();
    try{state.data.send({type:'FPS',fps:state.fps.val});}catch(e){}
    try{state.data.send({type:'PING',t:Date.now()});}catch(e){}
  }
}
document.addEventListener('click',e=>{
  const t=e.target.closest('[data-act],[data-mode],[data-ctrl]');if(!t)return;
  if(t.dataset.mode){if(t.dataset.mode==='install')return;setMode(t.dataset.mode);return;}
  const act=t.dataset.act;
  if(act==='back')exit();if(act==='exit')exit();if(act==='stop')exit();
  if(act==='qr')showQR(true);if(act==='qr-close')showQR(false);
  if(act==='grid'){state.viewMode=state.viewMode==='grid'?'single':'grid';updateGrid();broadcastAir();}
  if(act==='full'){if(!document.fullscreenElement)document.documentElement.requestFullscreen?.();else document.exitFullscreen?.();}
  if(act==='zen'){state.zen=!state.zen;$('studio').classList.toggle('zen',state.zen);}
  if(act==='output'){
    const cam=state.activeCam?encodeURIComponent(state.activeCam):'all';
    const mode=state.viewMode==='grid'?'grid':'single';
    window.open(`output.html?room=${state.room}&cam=${cam}&mode=${mode}`,'_blank');
  }
  if(act==='torch')toggleTorch();if(act==='snap')snap();
  if(act==='reconnect'){toast('Переподключение...','warn');state.connections.forEach(e=>{if(e.call)e.call.close();});}
  if(act==='connect'){const v=$('c-input').value.trim().toLowerCase();if(v.length<4){toast('Минимум 4 символа','err');return;}startPhone('glz-'+v);}
});
document.addEventListener('input',e=>{
  const t=e.target;
  if(t.dataset.ctrl){
    const v=t.value;
    if(t.dataset.ctrl==='zoom'){$('v-z').textContent=parseFloat(v).toFixed(1);onCtrl('zoom',v);}
    if(t.dataset.ctrl==='exposure'){$('v-b').textContent=parseFloat(v).toFixed(1);onCtrl('exposure',v);}
    if(t.dataset.ctrl==='contrast'){$('v-c').textContent=v;state.filters.contrast=v;applyAllFilters();}
    if(t.dataset.ctrl==='sat'){$('v-s').textContent=v;state.filters.sat=v;applyAllFilters();}
    if(t.dataset.ctrl==='bitrate'){state.bitrate=v;onCtrl('bitrate',v);}
  }
  if(t.id==='s-zoom'){$('v-zoom').textContent=parseFloat(t.value).toFixed(1);applyConstraint('zoom',t.value);}
  if(t.id==='s-exp'){$('v-exp').textContent=parseFloat(t.value).toFixed(1);applyConstraint('exposure',t.value);}
});
document.addEventListener('change',e=>{
  if(e.target.dataset.ctrl==='bitrate'){state.bitrate=e.target.value;onCtrl('bitrate',e.target.value);}
});
$('c-quality')?.addEventListener('change',changeQuality);
$('c-cam')?.addEventListener('change',e=>switchCam(e.target.value));
$('qr-code')?.addEventListener('click',()=>{navigator.clipboard?.writeText($('qr-code').textContent).then(()=>toast('Скопировано'));});
window.addEventListener('keydown',e=>{
  if(state.mode!=='monitor')return;
  if(e.key==='h'||e.key==='H'){state.zen=!state.zen;$('studio').classList.toggle('zen',state.zen);}
  if(e.key==='k'||e.key==='K')showQR(!$('qr-modal').classList.contains('visible'));
  if(e.key==='Escape')showQR(false);
});
$('stage')?.addEventListener('click',e=>{
  if(e.target.closest('.qr-modal,.btn,.stage-top,.sidebar,.right-panel'))return;
  state.zen=!state.zen;$('studio').classList.toggle('zen',state.zen);
});
document.addEventListener('visibilitychange',async()=>{
  if(document.visibilityState==='visible'&&state.mode==='camera'&&'wakeLock' in navigator){
    try{state.wakeLock=await navigator.wakeLock.request('screen');}catch(e){}
  }
});
function snap(){
  const v=$$('#v-grid video')[0];
  if(!v||!v.videoWidth){toast('Нет видео','warn');return;}
  const c=document.createElement('canvas');c.width=v.videoWidth;c.height=v.videoHeight;
  c.getContext('2d').drawImage(v,0,0);
  const a=document.createElement('a');
  a.download='glazok-'+Date.now()+'.png';a.href=c.toDataURL('image/png');a.click();
  toast('Снимок сохранён');
}
log('Glazok Studio загружен');