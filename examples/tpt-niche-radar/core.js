/* Pure data engine: shared by the dashboard, capture flow and regression tests. */
(function (root) {
'use strict';
const clamp=(n,a=0,b=1)=>Math.max(a,Math.min(b,n));
const normalize=s=>String(s??'').normalize('NFKC').replace(/[‘’]/g,"'").replace(/[–—−]/g,'-').trim().replace(/\s+/g,' ').toLocaleLowerCase('en-US');
const keyOf=s=>'kw:'+normalize(s);
const labelOf=s=>{const v=normalize(s);return ({strong:'Strong',high:'Strong',promising:'Promising',moderate:'Moderate',challenging:'Challenging',low:'Challenging','very difficult':'Very Difficult'})[v]||'Unknown';};
function number(s){
 const v=String(s??'').trim().replace(/[,\s\u00a0]/g,'');
 const m=v.match(/^(\d+(?:\.\d+)?)\s*([kmb])?$/i);
 if(!m)return null;
 const n=Number(m[1])*({k:1e3,m:1e6,b:1e9}[m[2]?.toLowerCase()]||1);
 return Number.isFinite(n)&&n<=1e12?n:null;
}
function resources(s){
 const text=String(s??'').trim(),v=text.replace(/[–—−]/g,'-').replace(/,/g,'').replace(/resources?|results?/gi,'').trim();
 let m=v.match(/^(<|<=|≤|>|>=|≥)\s*(.+)$/),low,high,open=false;
 if(m){const n=number(m[2]);if(n===null)return null;if(['<','<=','≤'].includes(m[1])){low=0;high=n;}else{low=n;high=null;open=true;}}
 else if(v.endsWith('+')){low=number(v.slice(0,-1));high=null;open=true;}
 else if(v.includes('-')){const parts=v.split('-');if(parts.length!==2)return null;low=number(parts[0]);high=number(parts[1]);}
 else{low=number(v);high=low;}
 if(low===null||(!open&&high===null)||(!open&&high<low))return null;
 return {low,high,open,proxy:open?Math.max(low,1):Math.max(high,1),text};
}
function isoDate(s){if(!s)return '';const v=String(s).trim();if(!/^\d{4}-\d{2}-\d{2}$/.test(v))return '';const d=new Date(v+'T12:00:00Z');return Number.isFinite(d.valueOf())&&d.toISOString().slice(0,10)===v?v:'';}
function parseDelimited(text,delimiter){
 text=String(text).replace(/^\uFEFF/,'');
 if(!delimiter){const first=text.split(/\r?\n/)[0];delimiter=[',',';','\t'].sort((a,b)=>first.split(b).length-first.split(a).length)[0];}
 const rows=[];let row=[],field='',quoted=false,after=false;
 for(let i=0;i<text.length;i++){
  const c=text[i];
  if(quoted){if(c==='"'){if(text[i+1]==='"'){field+='"';i++;}else{quoted=false;after=true;}}else field+=c;}
  else if(c==='"'&&!field.trim()&&!after){field='';quoted=true;}
  else if(c===delimiter){row.push(field);field='';after=false;}
  else if(c==='\n'||c==='\r'){if(c==='\r'&&text[i+1]==='\n')i++;row.push(field);if(row.some(x=>x.trim()))rows.push(row);row=[];field='';after=false;}
  else{if(after&&!/\s/.test(c))throw new Error('Unexpected text after a closing quote. Check the CSV formatting.');field+=c;}
 }
 if(quoted)throw new Error('A quoted field is not closed. Re-export this CSV and try again.');
 row.push(field);if(row.some(x=>x.trim()))rows.push(row);
 return {headers:rows.shift()||[],data:rows,delimiter};
}
const aliases={keyword:['keywords','keyword','search term','search terms','term','query','keyword phrase'],searches:['searches','search volume','volume','search count','searches text','searchestext'],resources:['resources','resource count','competition','results','resources available','resourcestext'],opportunity:['opportunity','opportunitytext','tpt opportunity','source opportunity'],date:['date','snapshot date','captured at','observed date'],period:['period','search window','window','reporting period']};
function guessMapping(headers){return Object.fromEntries(Object.entries(aliases).map(([k,names])=>[k,headers.findIndex(h=>names.includes(normalize(h)))]));}
function convertRows(parsed,mapping=guessMapping(parsed.headers)){
 const rows=[],errors=[],seen=new Set();let duplicateRows=0;
 if(['keyword','searches','resources'].some(k=>mapping[k]<0||mapping[k]==null)||new Set(['keyword','searches','resources'].map(k=>mapping[k])).size!==3)return {rows,errors:[{line:1,message:'Map Keyword, Searches and Resources before importing.'}],duplicateRows,mapping,incomplete:true};
 parsed.data.forEach((r,index)=>{
  if(r.length!==parsed.headers.length){errors.push({line:index+2,message:'Column count does not match the header.'});return;}
  const keyword=String(r[mapping.keyword]??'').trim().replace(/\s+/g,' '),searches=number(r[mapping.searches]),resourceText=String(r[mapping.resources]??'').trim();
  const rawDate=mapping.date>=0?r[mapping.date]:'';
  if(!keyword||keyword.length>300||searches===null||!resourceText||resourceText.length>100||rawDate&&!isoDate(rawDate)){errors.push({line:index+2,message:!keyword?'Empty keyword.':searches===null?'Searches must be a non-negative number (not a range).':rawDate&&!isoDate(rawDate)?'Use YYYY-MM-DD for dates.':'Missing or invalid keyword/resources.'});return;}
  const item={keyword,key:keyOf(keyword),searches,resourcesText:resourceText,opportunity:labelOf(mapping.opportunity>=0?r[mapping.opportunity]:''),date:isoDate(rawDate),period:mapping.period>=0?String(r[mapping.period]??'').trim().slice(0,120):''};
  const sig=rowSignature(item);if(seen.has(sig)){duplicateRows++;return;}seen.add(sig);rows.push(item);
 });
 return {rows,errors,duplicateRows,mapping,incomplete:false};
}
function rowSignature(r,date='',period=''){const res=resources(r.resourcesText);return JSON.stringify([r.key||keyOf(r.keyword),r.searches,res?[res.low,res.high]:normalize(r.resourcesText),labelOf(r.opportunity),r.date||date,normalize(r.period||period)]);}
function batchSignature(b){return JSON.stringify(b.rows.map(r=>rowSignature(r,b.date,b.period)).sort());}
function emptyState(){return {schema:3,batches:[],meta:{},settings:{preset:'balanced'},migrated:false};}
function mergeBatches(state,incoming){let added=0,skipped=0;const signatures=new Set(state.batches.map(batchSignature));for(const b of incoming){const sig=batchSignature(b);if(!b.rows.length||signatures.has(sig)){skipped++;continue;}signatures.add(sig);state.batches.push(b);added++;}return {added,skipped};}
const presets={balanced:{demand:.35,competition:.35,efficiency:.20,label:.10},lowCompetition:{demand:.20,competition:.50,efficiency:.20,label:.10},demand:{demand:.55,competition:.20,efficiency:.15,label:.10}};
function score(row,preset='balanced'){
 const r=resources(row.resourcesText);if(!r||row.searches==null)return {score:null,parts:[],resource:r,ratio:null};
 const w=presets[preset]||presets.balanced;
 const values={demand:clamp(Math.log10(1+row.searches)/5),competition:r.open?0:1-clamp(Math.log10(Math.max(100,r.proxy)/100)/Math.log10(500000/100)),efficiency:r.open?0:clamp(Math.log10(1+row.searches/r.proxy*100)/Math.log10(101)),label:({Strong:1,Promising:.75,Moderate:.5,Challenging:.25,'Very Difficult':0,Unknown:.5})[labelOf(row.opportunity)]};
 const parts=Object.entries(w).map(([name,weight])=>({name,weight,value:values[name],points:values[name]*weight*100}));
 return {score:Math.round(parts.reduce((s,p)=>s+p.points,0)),parts,resource:r,ratio:row.searches/r.proxy*1000};
}
const brandHints=['my nerdy teacher','teacher resource cabin','morpheme magic','teaching with a mountain view','jennifer findley','literacy loft','what i have learned','ufli','mystery science','miss redacted','missredacted'];
function intentOf(keyword,override){if(['general','brand','free'].includes(override))return override;const k=normalize(keyword);if(/\bfree(?:bie|bies)?\b/.test(k))return 'free';return brandHints.some(name=>k===name||k.includes(name+' ')||k.endsWith(' '+name))?'brand':'general';}
function aggregate(state){
 const map=new Map();let overlaps=0;
 for(const b of state.batches)for(const row of b.rows){const key=keyOf(row.keyword);let g=map.get(key);if(!g){g={key,keyword:row.keyword,history:[],_seen:new Map()};map.set(key,g);}
 const sig=rowSignature(row,b.date,b.period),existing=g._seen.get(sig);
 if(existing){existing.sources.push({id:b.id,name:b.name});if((b.importedAt||'')>(existing.importedAt||'')){existing.importedAt=b.importedAt;existing.batchId=b.id;}overlaps++;continue;}
 const ob={...row,key,date:row.date||b.date||'',period:row.period||b.period||'',importedAt:b.importedAt,batchId:b.id,sources:[{id:b.id,name:b.name}]};g.history.push(ob);g._seen.set(sig,ob);
 }
 const result=[...map.values()].map(g=>{
  g.history.sort((a,b)=>(b.date||'').localeCompare(a.date||'')||(b.importedAt||'').localeCompare(a.importedAt||'')||b.batchId.localeCompare(a.batchId));
  const current=g.history[0];const sameDate=g.history.filter(h=>h.date===current.date&&normalize(h.period)===normalize(current.period));
  const conflict=new Set(sameDate.map(h=>JSON.stringify([h.searches,normalize(h.resourcesText),h.opportunity]))).size>1;
  const prev=current.date&&current.period?g.history.find(h=>h.date&&h.date<current.date&&normalize(h.period)===normalize(current.period)):null;
  const delta=prev&&prev.searches>0?(current.searches-prev.searches)/prev.searches*100:null;
  const meta=Object.hasOwn(state.meta,g.key)?state.meta[g.key]:{};
  return {...g,...current,...score(current,state.settings.preset),meta,intent:intentOf(current.keyword,meta.intent),previous:prev,delta,conflict,undatedCount:g.history.filter(h=>!h.date).length,seasonal:/halloween|christmas|thanksgiving|valentine|easter|heritage month|back to school|end of year|fall\b|autumn|winter|spring|summer|st patrick|new year/i.test(current.keyword),_seen:undefined};
 });
 return {rows:result,overlaps,observations:result.reduce((n,r)=>n+r.history.length,0)};
}
function tier(n){return n===null?'Unscored':n>=70?'Priority':n>=55?'Worth exploring':n>=40?'Selective':'Harder entry';}
const stop=new Set('a an the and or of for in to with on by is at grade grades activity activities worksheet worksheets printable printables resource resources'.split(' '));
function clusters(rows){const groups=new Map();for(const r of rows){const words=[...new Set(normalize(r.keyword).split(/[^a-z0-9'-]+/).filter(x=>x.length>2&&!stop.has(x)))];for(const word of words){if(!groups.has(word))groups.set(word,[]);groups.get(word).push(r);}}return [...groups].filter(([,rs])=>rs.length>=2).map(([term,rs])=>({term,count:rs.length,best:[...rs].sort((a,b)=>(b.score??-1)-(a.score??-1))[0],rows:rs,avg:Math.round(rs.reduce((a,r)=>a+(r.score||0),0)/rs.length)})).sort((a,b)=>b.best.score-a.best.score||b.count-a.count);}
function safeCell(value){let s=String(value??'');if(/^[\s]*[=+\-@]/.test(s))s="'"+s;return '"'+s.replace(/"/g,'""')+'"';}
function csv(headers,rows){return '\uFEFF'+[headers,...rows].map(r=>r.map(safeCell).join(',')).join('\r\n');}
function validateBackup(obj){
 if(!obj||obj.schema!==3||!Array.isArray(obj.batches)||obj.batches.length>5000)throw new Error('This is not a supported Niche Radar v3 backup.');
 let count=0;const ids=new Set();
 const batches=obj.batches.map(b=>{
  if(!b||typeof b.id!=='string'||ids.has(b.id)||!Array.isArray(b.rows)||!b.rows.length||b.rows.length>100000||b.date&&!isoDate(b.date))throw new Error('Invalid batch in backup.');ids.add(b.id);
  const rows=b.rows.map(r=>{if(!r||typeof r.keyword!=='string'||!r.keyword.trim()||r.keyword.length>300||typeof r.searches!=='number'||number(r.searches)===null||typeof r.resourcesText!=='string'||r.resourcesText.length>100||!r.resourcesText.trim()||r.date&&!isoDate(r.date))throw new Error('Invalid observation in backup.');return {keyword:r.keyword,key:keyOf(r.keyword),searches:r.searches,resourcesText:r.resourcesText,opportunity:labelOf(r.opportunity),date:isoDate(r.date),period:String(r.period||'').slice(0,120)};});
  count+=rows.length;if(count>500000)throw new Error('Backup exceeds 500,000 rows. Split the archive first.');
  return {id:b.id.slice(0,160),name:String(b.name||'Restored import').slice(0,250),date:isoDate(b.date),period:String(b.period||'').slice(0,120),importedAt:typeof b.importedAt==='string'&&Number.isFinite(Date.parse(b.importedAt))?b.importedAt:new Date().toISOString(),rows,duplicateRows:Number(b.duplicateRows)||0,invalidRows:Number(b.invalidRows)||0};
 });
 const meta={};for(const [k,m] of Object.entries(obj.meta||{})){if(!k.startsWith('kw:')||!m||typeof m!=='object')continue;meta[k]={intent:['auto','general','brand','free'].includes(m.intent)?m.intent:'auto',starred:!!m.starred,status:['inbox','researching','building','published','passed'].includes(m.status)?m.status:'inbox',notes:String(m.notes||'').slice(0,20000),tags:String(m.tags||'').slice(0,500),updatedAt:String(m.updatedAt||'')};}
 return {schema:3,batches,meta,settings:{preset:Object.hasOwn(presets,obj.settings?.preset)?obj.settings.preset:'balanced'},migrated:!!obj.migrated};
}
const api={normalize,keyOf,labelOf,number,resources,isoDate,parseDelimited,guessMapping,convertRows,rowSignature,batchSignature,emptyState,mergeBatches,score,aggregate,tier,clusters,csv,validateBackup,presets,intentOf,brandHints};
if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.Radar=api;
})(globalThis);
