import {test} from 'node:test';import {strict as assert} from 'node:assert';
import {mkdtemp,writeFile,readFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';import path from 'node:path';
import {loadSessionFiles,sampleUniform,replayObservations,renderPathOverlay} from '../../packages/protocols/offline-replay.mjs';
import {StraightStopSkill} from '../../packages/control/straight-stop.mjs';

const geometry={full_width:1280,full_height:668,left:1049,top:507,width:167,height:94};
const sample=(i,overrides={})=>({file:String(i).padStart(6,'0')+'.jpg',hud_file:String(i).padStart(6,'0')+'-hud.png',
  minimap_file:String(i).padStart(6,'0')+'-map.png',sequence:i+1,capture_start_ms:1000+i*125,capture_end_ms:1010+i*125,
  age_ms:60,capture_skew_ms:0,hud_geometry:geometry,...overrides});
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
  assert.equal(report.summary.decision_states.ACCELERATE,6);
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
