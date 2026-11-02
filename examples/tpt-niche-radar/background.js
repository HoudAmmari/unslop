// Chrome reuses the options dashboard tab; no broad tabs permission is needed.
chrome.runtime.onMessage.addListener((request,sender,respond)=>{
 if(sender.id!==chrome.runtime.id)return;
 if(request.action==='openDashboard'){
  chrome.runtime.openOptionsPage().then(()=>respond({ok:true})).catch(e=>respond({error:e.message}));
  return true;
 }
});
