import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {SpeedReader} from '../../packages/perception/speed-reader.mjs';
import {GAUGE_PROFILE} from '../../packages/perception/vehicle-state.mjs';
const labels=JSON.parse(await readFile(new URL('../../fixtures/hud-labels.json',import.meta.url))),reports=[];
for(const padded_consensus of [false,true]){
  const reader=await SpeedReader.create({...GAUGE_PROFILE.speed,padded_consensus}),rows=[];
  try{for(const x of labels.rows){reader.previous=null;const bytes=await readFile(new URL(`../recordings/${x.session}/${x.file}`,import.meta.url)),t=performance.now();const result=await reader.read(bytes,0);rows.push({...x,result,ms:performance.now()-t});}}
  finally{await reader.close();}
  reports.push({padded_consensus,groups:['dev','pilot','holdout'].map(split=>{const r=rows.filter(x=>x.split===split);return {split,total:r.length,accepted:r.filter(x=>x.result.valid).length,correct:r.filter(x=>x.result.valid&&x.result.kmh===x.speed).length,wrong:r.filter(x=>x.result.valid&&x.result.kmh!==x.speed).length,mean_ms:r.reduce((s,x)=>s+x.ms,0)/r.length};}),rows});
}
const dir=new URL('../runs/hud/',import.meta.url);await mkdir(dir,{recursive:true});
const file=new URL(`${new Date().toISOString().replaceAll(':','-')}.json`,dir);
await writeFile(file,JSON.stringify({scope:labels.scope,temporal_filter:'disabled: independent frames',reports},null,2));console.log(JSON.stringify({file:file.pathname,summary:reports.map(({rows,...r})=>r)},null,2));
