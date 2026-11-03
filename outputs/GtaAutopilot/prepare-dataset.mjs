import {readFile,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import sharp from 'sharp';
import {prepareExamples,TARGET_KEYS} from './dataset.mjs';
import {annotationAtFrame} from './navigation-context.mjs';
import {recordingCrop} from './recording-camera.mjs';
const dir=path.resolve(process.argv[2]??'');
const session=JSON.parse(await readFile(path.join(dir,'session.json'),'utf8'));
if(session.purpose==='diagnostic_smoke_test'||session.training_eligible===false)throw Error('Diagnostic session excluded');
const rows=(await readFile(path.join(dir,'samples.jsonl'),'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
let input=null,events=[],endMs=Infinity;
if(session.version>=2){
  input=JSON.parse(await readFile(path.join(dir,'input-session.json'),'utf8'));
  events=(await readFile(path.join(dir,'events.jsonl'),'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
  const end=JSON.parse(await readFile(path.join(dir,'input-state.json'),'utf8'));
  if(end.session!==input.session||end.active||end.last_sequence!==events.length||!Number.isFinite(end.ended_ms)||end.ended_ms<input.started_ms||events.some(e=>e.time_ms>end.ended_ms)||String(session.reason).includes('event_flush_failed'))throw Error('Incomplete or mismatched event journal');
  endMs=end.ended_ms;
}
const result=prepareExamples(rows,{input,events,endMs});
let annotation=null;try{annotation=JSON.parse(await readFile(path.join(dir,'navigation-annotations.json'),'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
if(annotation){const byFile=new Map(rows.map(r=>[r.file,r])),origin=rows[0].capture_start_ms;for(const e of result.examples){const r=byFile.get(e.frames.at(-1)),review=annotationAtFrame(annotation,session.id,r.capture_start_ms-origin,r.capture_end_ms-origin);if(review.valid){e.navigation=e.navigation.valid&&e.navigation.intent!==review.intent?{valid:false,intent:'unknown',reason:'live_annotation_conflict'}:{...review,time_domain:'recording_relative'};}}}
const camera=session.camera_profile??'unknown';
const root=new URL(`./datasets/${path.basename(dir)}${camera==='hood'?'-hood':''}/`,import.meta.url);await mkdir(new URL('frames/',root),{recursive:true});
const used=[...new Set(result.examples.flatMap(e=>e.frames))];
for(const file of used){
  const image=sharp(path.join(dir,file)),m=await image.metadata();
  // Fixed rear-view road crop; minimap and speedometer are deliberately not
  // interpreted by this first local road-following dataset.
  await image.extract(recordingCrop(camera,m.width,m.height)).resize(320,180).jpeg({quality:90}).toFile(fileURLToPath(new URL(`frames/${file}`,root)));
}
await writeFile(new URL('examples.jsonl',root),result.examples.map(e=>JSON.stringify({...e,frames:e.frames.map(f=>'frames/'+f),source_session:session.id})).join('\n')+'\n');
const combos={};for(const e of result.examples){const key=e.keys.join('+')||'none';combos[key]=(combos[key]??0)+1;}
const report={version:1,source_session:session.id,samples:result.examples.length,images:used.length,history:4,input_size:[320,180],target_keys:TARGET_KEYS,action_meaning:{w:'accelerate',s:'brake_or_reverse',a:'left',d:'right',space:'handbrake',shift:'recorded_shift'},rejected:result.rejected,combinations:combos,label_quality:input?'events_with_snapshot_crosscheck':'provisional_legacy_snapshots',validation:'Separate driving sessions required; no random adjacent-frame split',scope:'Experimental local road-following only. No GPS route conditioning. No trained model or driving quality claim.'};
report.navigation_labels={known:result.examples.filter(e=>e.navigation.valid).length,unknown:result.examples.filter(e=>!e.navigation.valid).length,source:'explicit captured command or reviewed sidecar; never driving keys'};
report.camera_profile=camera;report.camera_verification=session.camera_verification??'legacy_unknown';
await writeFile(new URL('dataset.json',root),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
