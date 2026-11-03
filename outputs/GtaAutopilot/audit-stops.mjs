import {readFile,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {VehicleStateReader,classifySAction} from './vehicle-state.mjs';
const root=path.resolve(process.argv[2]??'');
const rows=(await readFile(path.join(root,'samples.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
const session=JSON.parse(await readFile(path.join(root,'session.json'),'utf8'));
let events=[],eventSource='keyboard_events';
try{events=(await readFile(path.join(root,'events.jsonl'),'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);}catch(e){if(e.code!=='ENOENT')throw e;eventSource='legacy_frame_snapshots';let held=false;for(const r of rows){const active=[...r.keys_before,...r.keys_after].includes('s');if(active!==held){events.push({key:'s',down:active,time_ms:r.capture_start_ms});held=active;}}}
let down=null;const spans=[];
for(const e of events.filter(e=>e.key==='s')){if(e.down&&down===null)down=e.time_ms;else if(!e.down&&down!==null){spans.push({start:down,end:e.time_ms});down=null;}}
if(down!==null)spans.push({start:down,end:rows.at(-1).capture_end_ms});
const indices=new Set(),nearest=t=>{let best=0;rows.forEach((r,i)=>{if(Math.abs(r.capture_start_ms-t)<Math.abs(rows[best].capture_start_ms-t))best=i;});return best;};
for(const s of spans){s.indices=[nearest(s.start-400),nearest((s.start+s.end)/2),nearest(s.end+400)];s.indices.forEach(i=>indices.add(i));}
const reader=await VehicleStateReader.create(),states=new Map();
try{for(const i of [...indices].sort((a,b)=>a-b)){const r=rows[i];reader.speed.previous=null;const s=await reader.read(await readFile(path.join(root,r.file)),r.capture_start_ms);states.set(i,s);}}
finally{await reader.close();}
const result=spans.map(s=>({start_ms:s.start,end_ms:s.end,frames:s.indices.map(i=>rows[i].file),states:s.indices.map(i=>states.get(i)),classification:classifySAction(states.get(s.indices[1]),states.get(s.indices[0]),states.get(s.indices[2]))}));
const counts={};for(const r of result)counts[r.classification.label]=(counts[r.classification.label]??0)+1;
const report={session:session.id,event_source:eventSource,segments:result.length,sampled_frames:states.size,valid_speed:[...states.values()].filter(s=>s.speed.valid).length,valid_gear:[...states.values()].filter(s=>s.gear.valid).length,counts,scope:'Sparse independent OCR samples; no temporal speed rejection across skipped frames. Speed drop with S does not prove S caused deceleration. Unknown observations stay unknown.',results:result};
await writeFile(path.join(root,'stop-audit.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({session:session.id,segments:report.segments,sampled_frames:report.sampled_frames,valid_speed:report.valid_speed,valid_gear:report.valid_gear,counts}));
