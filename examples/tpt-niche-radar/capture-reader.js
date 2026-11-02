/* Reads semantic analytics tables only; deliberately refuses positional guesses. */
(function(root){
 const text=el=>(el?.innerText??el?.textContent??'').trim().replace(/\s+/g,' ');
 const norm=s=>s.toLowerCase().replace(/[^a-z0-9 ]/g,'').trim();
 function mapHeaders(cells){const names=cells.map(c=>norm(text(c)));return {keyword:names.findIndex(s=>/^(keyword|keywords|search term|search terms)(\s|$)/.test(s)),searches:names.findIndex(s=>/^(searches|search volume|search count)(\s|$)/.test(s)),resources:names.findIndex(s=>/^(resources|resource count|resources available|results)(\s|$)/.test(s)),opportunity:names.findIndex(s=>/^(opportunity|tpt opportunity)(\s|$)/.test(s))};}
 function read(doc=document){let candidates=[...doc.querySelectorAll('table,[role="table"],[role="grid"]')],best=null;
 if(!candidates.length&&doc.querySelector('[role="row"]'))candidates=[doc];
 for(const container of candidates){if(container!==doc&&!container.getClientRects().length)continue;
  const rows=[...container.querySelectorAll('tr,[role="row"]')].filter(el=>!el.closest('[hidden],[aria-hidden="true"]'));
  let header=null,mapping=null;
  for(const row of rows.slice(0,8)){const cells=[...row.querySelectorAll('th,td,[role="columnheader"],[role="cell"]')];const m=mapHeaders(cells);if(m.keyword>=0&&m.searches>=0&&m.resources>=0){header=row;mapping=m;break;}}
  if(!header)continue;
  const records=[];let invalid=0;
  for(const row of rows){if(row===header)continue;const cells=[...row.querySelectorAll('td,th[scope="row"],[role="cell"],[role="rowheader"],[role="gridcell"]')];if(cells.length<=Math.max(mapping.keyword,mapping.searches,mapping.resources))continue;const keyword=text(cells[mapping.keyword]),searchesText=text(cells[mapping.searches]),resourcesText=text(cells[mapping.resources]),opportunityText=mapping.opportunity>=0?text(cells[mapping.opportunity]):'Unknown';if(!keyword||!/^[\d,\s.]+[kmb]?$/i.test(searchesText)||!resourcesText){invalid++;continue;}records.push({keyword,searchesText,resourcesText,opportunityText});}
  if(!best||records.length>best.rows.length)best={rows:records,container,invalid};
 }
 if(!best)throw new Error('No recognizable analytics table. Open a TPT table with Keyword, Searches, and Resources headers, or export a CSV and import it.');
 if(!best.rows.length)throw new Error('The analytics headers were found, but there are no readable data rows. Wait for loading to finish and try again.');
 return best;
 }
 function signature(rows){return JSON.stringify(rows.map(r=>[r.keyword.toLowerCase(),r.searchesText,r.resourcesText,r.opportunityText]));}
 function next(doc=document){const scopes=[...doc.querySelectorAll('[aria-label*="pagination" i],nav,[data-testid*="pagination" i]')];const nodes=[...new Set([...scopes.flatMap(s=>[...s.querySelectorAll('button,a,[role="button"]')]),...doc.querySelectorAll('button[aria-label*="next" i],a[aria-label*="next" i],button[title*="next page" i]')])];return nodes.find(el=>{const label=(el.getAttribute('aria-label')||el.getAttribute('title')||text(el)).trim();return /^(go to )?next( page)?$|^next page\b|^›$|^»$|^>$/i.test(label)&&!el.disabled&&el.getAttribute('aria-disabled')!=='true'&&!/disabled/i.test(el.className||'')&&!el.closest('[hidden],[aria-hidden="true"]')&&el.getClientRects().length>0;})||null;}
 const api={read,signature,next};if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.RadarCaptureReader=api;
})(globalThis);
