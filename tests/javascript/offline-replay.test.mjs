import {test} from 'node:test';import {strict as assert} from 'node:assert';
import {mkdtemp,writeFile,readFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';import path from 'node:path';
import {loadSessionFiles,sampleUniform,replayObservations,renderPathOverlay} from '../../packages/protocols/offline-replay.mjs';
import {StraightStopSkill} from '../../packages/control/straight-stop.mjs';

const geometry={full_width:1280,full_height:668,left:1049,top:507,width:167,height:94};
const sample=(i,overrides={})=>({file:String(i).padStart(6,'0')+'.jpg',hud_file:String(i).padStart(6,'0')+'-hud.png',
  minimap_file:String(i).padStart(6,'0')+'-map.png',generation:1,sequence:i+1,capture_start_ms:1000+i*125,capture_end_ms:1010+i*125,
  age_ms:60,capture_skew_ms:0,hud_geometry:{...geometry},...overrides});
const rows=[{y:.48,left:.3,right:.7,center:.5},{y:.54,left:.3,right:.7,center:.5},{y:.60,left:.3,right:.7,center:.5}];

async function recording(count=8){
  const root=await mkdtemp(path.join(tmpdir(),'replay-'));
  const samples=Array.from({length:count},(_,i)=>sample(i));
  for(const s of samples){
    await writeFile(path.join(root,s.file),'road');
    await writeFile(path.join(root,s.hud_file),'hud');
  }
  await writeFile(path.join(root,'samples.jsonl'),samples.map(r=>JSON.stringify(r)).join('\n')+'\n');
  await writeFile(path.join(root,'session.json'),JSON.stringify({id:'synthetic',role:'development',source:'single_capture',camera_declared:'rear',camera_verified:false,game_input_sent:false}));
  return {root,samples};
}

test('the manifest refuses mixed, repeated and separately captured components',()=>{
 const base=Array.from({length:4},(_,i)=>sample(i));
 assert.equal(loadSessionFiles({samples:base,session:{source:'single_capture'}}).length,4);
 for(const mutate of [
  rows=>{rows[1].sequence=rows[0].sequence;},
  rows=>{rows[1].capture_start_ms=rows[0].capture_start_ms;},
  rows=>{rows[1].capture_skew_ms=3;},
  rows=>{rows[1].hud_file='../secret.png';},
  rows=>{rows[1].file='000001.jpg.exe';}]){
  const copy=structuredClone(base);mutate(copy);
  assert.throws(()=>loadSessionFiles({samples:copy,session:{source:'single_capture'}}));
 }
 assert.throws(()=>loadSessionFiles({samples:base,session:{source:'separate_captures'}}),/single-capture/);
 assert.throws(()=>loadSessionFiles({samples:[],session:{source:'single_capture'}}),/nonempty/);
});

test('uniform sampling covers the recording without duplicating the end',()=>{
 const samples=Array.from({length:100},(_,i)=>sample(i));
 const picked=sampleUniform(samples,10);
 assert.equal(picked.length,10);assert.equal(picked[0].sequence,1);assert.equal(picked.at(-1).sequence,100);
 assert.equal(new Set(picked.map(p=>p.sequence)).size,10);
 assert.deepEqual(sampleUniform(samples,1).map(p=>p.sequence),[1]);
 assert.throws(()=>sampleUniform(samples,101),/1\.\./);
});

test('OCR reads the stored HUD at the recorded capture time and vision the matching JPEG',async()=>{
 const {root}=await recording(6);
 try{
  const seen={hud:[],road:[]};
  const report=await replayObservations(root,{
    sampling:6,hudProfile:meta=>meta,
    readerFactory:async()=>({read:async(bytes,time_ms)=>{seen.hud.push(time_ms);return {time_ms,speed:{valid:true,kmh:4,time_ms},gear:{valid:true,value:'2'}};},close:async()=>{}}),
    visionFactory:async()=>({analyze:async bytes=>{seen.road.push(bytes.toString());return {road_fraction:.4,rows,vehicles:[],semantic:null,inference_ms:1};},session:{release:async()=>{}}}),
    skill:{runner:new StraightStopSkill({targetKmh:8})}});
  assert.deepEqual(seen.hud,[1000,1125,1250,1375,1500,1625]);
  assert.deepEqual(seen.road,Array(6).fill('road'));
  assert.equal(report.summary.ocr_used,true);assert.equal(report.summary.vision_used,true);
  assert.equal(report.summary.decision_states.FAULT,6);assert.equal(report.summary.frames_processed,6);
  assert.equal(report.summary.driving_verified,false);
  assert.equal(report.game_input_sent,false);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('human labels stay authoritative and are never copied from predictions',async()=>{
 const {root}=await recording(6);
 try{
  const report=await replayObservations(root,{sampling:6,hudProfile:meta=>meta,
    readerFactory:async()=>({read:async(bytes,time_ms)=>({time_ms,speed:{valid:true,kmh:9,time_ms},gear:{valid:true,value:'2'}}),close:async()=>{}}),
    annotations:{rows:[{file:'000001.jpg',speed:3,gear:'2'},{file:'000003.jpg',speed:null,gear:null}]}});
  const labelled=report.rows.filter(r=>r.label);
  assert.equal(labelled.length,2);
  assert.equal(report.summary.correct_labelled_speed,0);
  assert.equal(report.summary.wrong_labelled_speed,1);
  assert.equal(labelled[1].label.partial,true);
  assert.equal(labelled[0].label.speed,3);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('a stale or missing HUD does not become a fresh reading',async()=>{
 const {root}=await recording(4);
 try{
  await writeFile(path.join(root,'000002-hud.png'),'changed');
  const report=await replayObservations(root,{sampling:4,hudProfile:meta=>meta,
    readerFactory:async()=>({read:async(bytes,time_ms)=>({time_ms,speed:{valid:false,kmh:null,time_ms,rejection_reason:'ocr_unconfirmed'},gear:{valid:false,value:null}}),close:async()=>{}})});
  assert.equal(report.summary.valid_speed,0);
  assert.equal(report.rows.every(r=>r.state.speed.valid===false),true);
  assert.equal(report.summary.path_overlay_errors,null);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('path overlay export drops out with an error instead of failing the run',async()=>{
 const result=await renderPathOverlay({roadBytes:Buffer.from('not an image'),semantic:{road:new Uint8Array(4),gridWidth:2,gridHeight:2,width:2,height:2},corridor:{valid:true,points:[{x:.5,y:.5}]},file:null});
 assert.equal(typeof result.error,'string');
 const nothing=await renderPathOverlay({roadBytes:Buffer.from('x'),semantic:null,corridor:{valid:false},file:null});
 assert.equal(nothing.reason,'nothing_to_draw');
});

test('sampling only limits report rows, not temporal processing or manifest integrity',async()=>{
 const {root,samples}=await recording(6);try{let calls=0;
 const r=await replayObservations(root,{sampling:2,hudProfile:x=>x,readerFactory:async()=>({read:async(b,t)=>{calls++;return {speed:{valid:true,kmh:0,time_ms:t},gear:{valid:true,value:'1'}};}})});
 assert.equal(calls,6);assert.equal(r.rows.length,2);assert.equal(r.summary.frames_processed,6);
 for(const kind of ['geometry','generation']){const copy=structuredClone(samples);if(kind==='geometry')copy[2].hud_geometry.width--;else copy[2].generation++;
 await writeFile(path.join(root,'samples.jsonl'),copy.map(JSON.stringify).join('\n'));
 await assert.rejects(replayObservations(root,{sampling:2}),/changed/);}
 }finally{await rm(root,{recursive:true,force:true});}
});
test('replay --skill really runs decisions through the CLI without loading real models',async()=>{
 const {execFileSync}=await import('node:child_process'),{fileURLToPath,pathToFileURL}=await import('node:url'),{root,samples}=await recording(6);
 try{const loader=path.join(root,'preload.mjs'),out=path.join(root,'report.json');
 const {default:sharp}=await import('sharp');
 const data=Buffer.alloc(40*20,20);for(let y=6;y<11;y++)for(let x=12;x<18;x++)data[y*40+x]=200;
 const png=await sharp(data,{raw:{width:40,height:20,channels:1}}).png().toBuffer();
 for(const s of samples)await writeFile(path.join(root,s.minimap_file),png);
 const perception=new URL('../../packages/perception/perception.mjs',import.meta.url).href,reader=new URL('../../packages/perception/vehicle-state.mjs',import.meta.url).href;
 await writeFile(loader,'import {Perception} from '+JSON.stringify(perception)+';import {VehicleStateReader} from '+JSON.stringify(reader)+';Perception.load=async()=>({analyze:async()=>({road_fraction:.4,rows:[],semantic:null}),session:{release:async()=>{}}});VehicleStateReader.create=async()=>({read:async(b,t)=>({speed:{valid:true,kmh:3,time_ms:t},gear:{valid:true,value:"1"}}),close:async()=>{}});');
 execFileSync(process.execPath,['--import',pathToFileURL(loader).href,fileURLToPath(new URL('../../experiments/tools/replay-observations.mjs',import.meta.url)),root,'--frames=2','--skill','--no-overlay','--out='+out],{stdio:'pipe'});
 const result=JSON.parse(await readFile(out,'utf8'));assert.ok(Object.keys(result.summary.decision_states).length>0);assert.equal(result.summary.frames_processed,6);assert.equal(result.rows[0].decision.command.throttle,0);
 assert.equal(result.summary.minimap_used,true);assert.equal(result.summary.motion.rows[1].minimap_motion.axes_complete,true);
 assert.equal(result.summary.motion.gap_frames,1);assert.equal(result.summary.scale_readiness.physical_units_allowed,false);
 }finally{await rm(root,{recursive:true,force:true});}
});

// Stored minimap pixels supply additional image evidence, never physical proof.
test('motion is measured between recording neighbours and the gap is reported',async()=>{
 const {root,samples}=await recording(6);
 try{
  // The stored minimap is part of the recording; a missing file must never be
  // replaced by an assumed zero movement.
  for(const s of samples)await writeFile(path.join(root,s.minimap_file),'map');
  const map=(shift)=>{const w=40,h=20,data=new Uint8Array(w*h);
    for(let y=0;y<h;y++)for(let x=0;x<w;x++){const xx=((x-shift)%w+w)%w;data[y*w+x]=xx>=12&&xx<18?200:20;}
    return {width:w,height:h,data};};
  const semantic=shift=>{const gw=40,gh=20,road=new Uint8Array(gw*gh);
    for(let y=0;y<gh;y++)for(let x=0;x<gw;x++){const xx=((x-shift)%gw+gw)%gw;if(xx>=14&&xx<26)road[y*gw+x]=1;}
    return {gridWidth:gw,gridHeight:gh,road,width:1280,height:668};};
  const seen=[];
  const report=await replayObservations(root,{sampling:3,hudProfile:meta=>meta,
    readerFactory:async()=>({read:async(bytes,time_ms)=>({time_ms,speed:{valid:true,kmh:3,time_ms},gear:{valid:true,value:'1'}}),close:async()=>{}}),
    visionFactory:async()=>({analyze:async bytes=>{const i=seen.length;seen.push(i);return {road_fraction:.4,rows,vehicles:[],semantic:semantic(i),inference_ms:2};},session:{release:async()=>{}}}),
    // The reader turns a stored minimap into the grayscale profile motion needs.
    minimapReader:async()=>map(seen.length)});
  // All six frames feed motion; the three selected report rows cannot change
  // the actual gap between the analysed recording neighbours.
  assert.equal(report.summary.frames_processed,6);
  assert.equal(report.summary.frames_replayed,3);
  assert.equal(report.summary.motion.gap_frames,1);
  assert.equal(report.summary.motion.frames,6);
  assert.equal(report.summary.motion.rows[0].source.reason,'no_neighbour');
  assert.equal(report.summary.minimap_used,true);
  // Offline analysis time and recorded age are reported separately.
  assert.equal(report.summary.latency.offline_analysis_ms.count,6);
  assert.equal(report.summary.latency.recorded_age_ms.count,6);
  assert.equal(report.summary.latency.live_loop_ms,null);
  assert.match(report.scope,/live capture-to-decision loop cannot be measured offline/);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('without a minimap the motion source is never claimed as separated',async()=>{
 const {root}=await recording(3);
 try{
  const semantic={gridWidth:40,gridHeight:20,road:new Uint8Array(800).fill(1),width:1280,height:668};
  const report=await replayObservations(root,{sampling:3,hudProfile:meta=>meta,
    readerFactory:async()=>({read:async(bytes,time_ms)=>({time_ms,speed:{valid:true,kmh:3,time_ms},gear:{valid:true,value:'1'}}),close:async()=>{}}),
    visionFactory:async()=>({analyze:async()=>({road_fraction:.5,rows,vehicles:[],semantic,inference_ms:1}),session:{release:async()=>{}}})});
  assert.equal(report.summary.minimap_used,false);
  const sources=report.summary.motion.sources;
  assert.equal(sources.camera_only_rotation??0,0);
  assert.equal(sources.vehicle_motion??0,0);
  assert.equal(sources.camera_motion_candidate??0,0);
  assert.equal(sources.vehicle_motion_candidate??0,0);
  assert.equal(report.summary.driving_verified,false);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('offline wall time includes decoding and missing semantic frames stay in the motion sequence',async()=>{
 const {root,samples}=await recording(4);
 try{
  for(const s of samples)await writeFile(path.join(root,s.minimap_file),'map');
  let now=0,index=0;
  const r=await replayObservations(root,{sampling:2,clock:()=>now,
   minimapReader:async()=>{now+=7;return null;},
   visionFactory:async()=>({analyze:async()=>{now+=3;index++;return index===2?null:{semantic:null};}})});
  assert.equal(r.summary.latency.offline_analysis_ms.p50,10);
  assert.equal(r.summary.motion.frames,4);assert.equal(r.summary.minimap_used,false);
  assert.equal(r.rows[0].minimap,false);
  const sparse=[samples[0],samples[3]];
  await writeFile(path.join(root,'samples.jsonl'),sparse.map(JSON.stringify).join('\n'));
  const sparseReport=await replayObservations(root,{sampling:2});
  assert.equal(sparseReport.summary.motion.gap_frames,3);
  assert.equal(sparseReport.summary.motion.rows[1].sequence_gap,3);
 }finally{await rm(root,{recursive:true,force:true});}
});
