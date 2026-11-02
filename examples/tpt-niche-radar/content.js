(function(){
 if(globalThis.__radarCaptureInstalled)return;globalThis.__radarCaptureInstalled=true;
 let running=false,stopped=false,job=null,host=null,ui=null;
 const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
 const localDate=()=>{const p=new Intl.DateTimeFormat('en-CA',{year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());const get=k=>p.find(x=>x.type===k).value;return `${get('year')}-${get('month')}-${get('day')}`;};
 function panel(){host?.remove();host=document.createElement('div');host.id='niche-radar-capture-status';host.style.cssText='position:fixed;right:20px;bottom:20px;z-index:2147483647';const shadow=host.attachShadow({mode:'closed'});shadow.innerHTML='<style>:host{all:initial}.box{font:13px/1.6 system-ui;background:#12392f;color:#d9f2cd;width:300px;padding:20px;border:1px solid #799b62;border-radius:12px;box-shadow:0 14px 60px #0004}.title{font-weight:750;letter-spacing:.3px}.status{color:#b4c8a8;font-size:12px;margin:10px 0}.count{font-size:11px;color:#93b881}button{border:1px solid #769462;background:#315b43;color:#e4f6d9;border-radius:6px;padding:8px 10px;font:12px system-ui;cursor:pointer;margin:12px 5px 0 0}</style><div class="box"><div class="title">◉ Niche Radar capture</div><div class="status" role="status">Starting…</div><div class="count"></div><button class="stop">Stop & keep rows</button><button class="open">Open workspace</button><button class="close" hidden>Close</button></div>';ui={message:shadow.querySelector('.status'),count:shadow.querySelector('.count'),stop:shadow.querySelector('.stop'),close:shadow.querySelector('.close')};ui.stop.onclick=()=>{stopped=true;ui.message.textContent='Stopping safely…';};shadow.querySelector('.open').onclick=()=>chrome.runtime.sendMessage({action:'openDashboard'});ui.close.onclick=()=>host.remove();document.documentElement.append(host);}
 async function save(message,status='running'){job.updatedAt=new Date().toISOString();job.message=message;job.status=status;if(ui){ui.message.textContent=message;ui.count.textContent=`${job.pages} pages · ${job.rows.length} collected rows`;}await chrome.storage.local.set({['radarCapture:'+job.id]:job});}
 async function run(options){running=true;stopped=false;panel();job={kind:'radarCapture',id:crypto.randomUUID(),name:'TPT capture '+localDate(),tabHint:location.href,date:localDate(),period:String(options.period||'').slice(0,120),rows:[],pages:0,status:'running',updatedAt:new Date().toISOString()};const id=job.id;
 (async()=>{let finish='Visible page captured.';const seenPages=new Set(),seenRows=new Set(),limit=options.allPages?Math.max(1,Math.min(50,options.maxPages||20)):1;try{
  await save('Reading the visible analytics table…');
  while(!stopped&&job.pages<limit){
   const parsed=RadarCaptureReader.read(),sig=RadarCaptureReader.signature(parsed.rows);
   if(seenPages.has(sig)){finish='Stopped: this page was already collected.';break;}seenPages.add(sig);
   for(const row of parsed.rows){const s=RadarCaptureReader.signature([row]);if(!seenRows.has(s)){seenRows.add(s);job.rows.push(row);}}
   job.pages++;await save(`Saved page ${job.pages}.${parsed.invalid?' Some malformed rows were not captured.':''}`);
   if(!options.allPages)break;
   const next=RadarCaptureReader.next();if(!next){finish='Reached the last detectable page.';break;}if(job.pages>=limit){finish=`Stopped at the ${limit}-page limit. Continue from the next page if needed.`;break;}
   next.click();let changed=false,lastSig='',stable=0;const start=Date.now();
   while(!stopped&&Date.now()-start<15000){await pause(400);try{const nextRows=RadarCaptureReader.read(),nextSig=RadarCaptureReader.signature(nextRows.rows);if(nextSig!==sig){stable=nextSig===lastSig?stable+1:0;lastSig=nextSig;if(stable>=2){changed=true;break;}}}catch{} }
   if(stopped)break;if(!changed){finish='Stopped: next page did not load different rows within 15 seconds. Collected rows are safe.';break;}
  }
  if(stopped)finish='Stopped by you. Collected rows are ready to review.';
  await save(finish,'complete');
 }catch(e){try{await save('Capture stopped: '+e.message,'error');}catch(storageError){ui.message.textContent='Could not save capture: '+storageError.message;}}finally{running=false;ui.stop.hidden=true;ui.close.hidden=false;}
 })();return id;
 }
 chrome.runtime.onMessage.addListener((message,sender,respond)=>{if(sender.id!==chrome.runtime.id)return;if(message.action==='radarStart'){if(running){respond({ok:false,error:'A capture is already running in this tab. Use Stop before restarting.'});return;}run(message.options||{}).then(id=>respond({ok:true,id})).catch(e=>respond({ok:false,error:e.message}));return true;}if(message.action==='radarStop'){stopped=true;respond({ok:true});}if(message.action==='radarStatus')respond({running,job});});
})();
