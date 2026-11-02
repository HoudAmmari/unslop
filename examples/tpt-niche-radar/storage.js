/* IndexedDB transactions serialize edits across dashboard tabs. */
(function(root){
let dbPromise;
const db=()=>dbPromise||(dbPromise=new Promise((resolve,reject)=>{const r=indexedDB.open('tpt-niche-radar-v3',1);r.onupgradeneeded=()=>r.result.createObjectStore('workspace');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);r.onblocked=()=>reject(new Error('Close other Radar tabs and reload to update storage.'));}));
const channel=typeof BroadcastChannel!=='undefined'?new BroadcastChannel('niche-radar-updates'):null;
async function read(){const d=await db();return new Promise((resolve,reject)=>{const r=d.transaction('workspace').objectStore('workspace').get('state');r.onsuccess=()=>resolve(r.result||Radar.emptyState());r.onerror=()=>reject(r.error);});}
async function update(fn){const d=await db();return new Promise((resolve,reject)=>{const tx=d.transaction('workspace','readwrite'),store=tx.objectStore('workspace'),get=store.get('state');let state,result;get.onsuccess=()=>{try{state=get.result||Radar.emptyState();result=fn(state);store.put(state,'state');}catch(e){reject(e);tx.abort();}};tx.oncomplete=()=>{channel?.postMessage('changed');resolve({state,result});};tx.onerror=()=>reject(tx.error||new Error('Could not save. Export a backup and check available browser storage.'));tx.onabort=()=>reject(tx.error||new Error('Save was cancelled.'));});}
root.RadarStore={read,update,onChange:fn=>{if(channel)channel.onmessage=fn;}};
})(globalThis);
