// Paired offline ablation: native digit model off/on, legacy baseline optional.
import {readFile,writeFile,mkdir,access} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {SpeedReader} from '../../packages/perception/speed-reader.mjs';
import {hudProfile} from '../../packages/perception/hud-profile.mjs';
import {percentiles} from '../../packages/protocols/latency-trace.mjs';
const root=path.resolve(process.argv[2]??''),session=JSON.parse(await readFile(path.join(root,'session.json'),'utf8'));
const report=path.resolve(process.argv.find(a=>a.startsWith('--output='))?.slice(9)??`runs/moving-perception/${session.id}-digits-${new Date().toISOString().replaceAll(':','-')}.json`);
try{await access(report);throw Error('Report exists; choose a new output path: '+report);}catch(e){if(e.code!=='ENOENT')throw e;}
const modelHash=createHash('sha256').update(await readFile(new URL('../../configs/hud-digit-prototypes.json',import.meta.url))).digest('hex');
const samples=(await readFile(path.join(root,'samples.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
const n=Number(process.argv.find(a=>a.startsWith('--frames='))?.split('=')[1]??samples.length);
if(session.source!=='single_capture'||!samples.length||!Number.isInteger(n)||n<1)throw Error('A recorded single-capture session and positive frame count are required');
const count=Math.min(n,samples.length),selected=Array.from({length:count},(_,i)=>samples[count===1?0:Math.floor(i*(samples.length-1)/(count-1))]);
const baseline=process.argv.find(a=>a.startsWith('--baseline='))?.slice(11)??'segmented';
if(!['legacy','segmented'].includes(baseline))throw Error('baseline must be legacy or segmented');
let annotations={rows:[]};try{annotations=JSON.parse(await readFile(path.join(root,'annotations.json'),'utf8'));if(annotations.session!==session.id)throw Error('Annotation mismatch');}catch(e){if(e.code!=='ENOENT')throw e;}
const truth=new Map(annotations.rows.map(r=>[r.file,r.speed])),profile=hudProfile(samples[0].hud_geometry).speed;
let before,after;const rows=[];
try{
  before=await SpeedReader.create({...profile,segmented_seven_confirmation:baseline!=='legacy',native_digit_confirmation:false});after=await SpeedReader.create({...profile,native_digit_confirmation:true});
  const warmup=await readFile(path.join(root,samples[0].hud_file));
  for(const reader of [before,after]){await reader.read(warmup,samples[0].capture_start_ms);reader.previous=null;}
  for(const [i,r]of selected.entries()){
    if(!/^\d{6}-hud\.png$/.test(r.hud_file)||JSON.stringify(r.hud_geometry)!==JSON.stringify(samples[0].hud_geometry))throw Error('Invalid or changing HUD geometry');
    const bytes=await readFile(path.join(root,r.hud_file)),result={};
    for(const [name,reader]of i%2?[['after',after],['before',before]]:[['before',before],['after',after]]){
      const start=performance.now();result[name]={...await reader.read(bytes,r.capture_start_ms),analysis_ms:performance.now()-start};
    }
    rows.push({file:r.file,label:Number.isFinite(truth.get(r.file))?truth.get(r.file):null,...result});
    if((i+1)%100===0)console.log(JSON.stringify({completed:i+1,total:count}));
  }
}finally{if(before)await before.close();if(after)await after.close();}
const summary={};
for(const key of ['before','after']){
 const labelled=rows.filter(r=>Number.isFinite(r.label)),accepted=labelled.filter(r=>r[key].valid);
 summary[key]={accepted_all:rows.filter(r=>r[key].valid).length,labelled:labelled.length,accepted_labelled:accepted.length,correct:accepted.filter(r=>r[key].kmh===r.label).length,wrong:accepted.filter(r=>r[key].kmh!==r.label).length,false_zero:accepted.filter(r=>r[key].kmh===0&&r.label>0).length,analysis_ms:percentiles(rows.map(r=>r[key].analysis_ms))};
}
summary.changed=rows.filter(r=>r.before.valid!==r.after.valid||r.before.kmh!==r.after.kmh).length;
await mkdir(path.dirname(report),{recursive:true});await writeFile(report,JSON.stringify({session:session.id,baseline,digit_model_sha256:modelHash,scope:'Development ablation only, digit model off/on; alternating order after one warmup per reader. Unlabelled outputs are not accuracy evidence. No game input.',frames:rows.length,summary,rows},null,2),{flag:'wx'});console.log(JSON.stringify({report,summary},null,2));
