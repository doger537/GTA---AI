import {fileURLToPath} from 'node:url';
import {test} from 'node:test';import {strict as assert} from 'node:assert';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';import path from 'node:path';
import {auditLabels} from '../../experiments/tools/audit-false-free.mjs';
import {emptyLabelFile} from '../../packages/perception/label-template.mjs';

// Synthetic masks and a fake analyzer: the real models are not available here.
const W=40,H=20;
const sceneOf=points=>{
  const road=new Uint8Array(W*H);
  for(const [x,y] of points)road[Math.floor(y*H)*W+Math.floor(x*W)]=1;
  return {gridWidth:W,gridHeight:H,road,corridorRoad:road,corridorObstacle:new Uint8Array(W*H),
    sidewalk:new Uint8Array(W*H),obstacle:new Uint8Array(W*H),labels:new Uint8Array(W*H),probability:new Float32Array(W*H),width:1280,height:668,inference_ms:5};
};
// A vertical corridor on the fake mask so connectedRoadGeometry accepts it.
const corridorFrame=(()=>{
  const frame=sceneOf([]);
  for(let y=0;y<H;y++)for(let x=14;x<26;x++){const t=y/H;if(t>=0.25&&t<=0.62)frame.road[y*W+x]=1;}
  frame.corridorRoad=frame.road;
  return frame;
})();

async function labelfile(entries){
  const dir=await mkdtemp(path.join(tmpdir(),'ff-'));
  const label=emptyLabelFile({session:'synthetic',files:entries.map(e=>e.file)});
  label.frames.forEach((f,i)=>{f.points=entries[i].points;f.scene={kind:'straight',camera_yaw:null,ego_visible:null};});
  const file=path.join(dir,'labels.json');
  await writeFile(file,JSON.stringify(label));
  return {dir,file};
}

test('the tool refuses empty labels and never guesses a missing point',async()=>{
 const {dir,file}=await labelfile([{file:'000000.jpg',points:[]}]);
 try{
  await assert.rejects(auditLabels({labelFile:file,resolveImage:()=>Buffer.from('x'),analyze:async()=>corridorFrame}),/no points/);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('a labelled hazard on the mask is reported per kind with the path flag',async()=>{
 const {dir,file}=await labelfile([
  {file:'000000.jpg',points:[{x:.5,y:.5,expected:'hazard',kind:'pole'},{x:.5,y:.45,expected:'road'}]},
  {file:'000001.jpg',points:[{x:.5,y:.55,expected:'hazard',kind:'curb'},{x:.5,y:.5,expected:'road'}]}]);
 try{
  const report=await auditLabels({labelFile:file,resolveImage:async f=>Buffer.from(f),analyze:async()=>corridorFrame});
  assert.equal(report.summary.scored,2);
  assert.equal(report.summary.hazard_points,2);
  // The curb point at x=.5 y=.55 is inside the corridor band, so it is also free.
  assert.equal(report.summary.false_free_total,2);
  assert.equal(report.summary.by_kind.pole.false_free,1);
  assert.equal(report.summary.by_kind.curb.false_free,1);
  assert.equal(report.frames.length,2);
  assert.equal(report.frames[0].corridor.valid,true);
  assert.match(report.scope,/not a driving result/);
  assert.equal(report.drift_summary.units,'image fractions');
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('a broken label file stops the audit instead of scoring part of it',async()=>{
 const {dir,file}=await labelfile([{file:'000000.jpg',points:[{x:.5,y:.5,expected:'hazard'}]}]);
 try{
  await assert.rejects(auditLabels({labelFile:file,resolveImage:()=>Buffer.from('x'),analyze:async()=>corridorFrame}),/Invalid label file/);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('the template tool writes once and refuses to overwrite real labels',async()=>{
 const {execFileSync}=await import('node:child_process');
 const dir=await mkdtemp(path.join(tmpdir(),'tmp-'));
 try{
  await writeFile(path.join(dir,'000000.jpg'),'x');await writeFile(path.join(dir,'000010.jpg'),'x');
  const out=path.join(dir,'labels.json');
  execFileSync(process.execPath,['experiments/tools/make-label-template.mjs',dir,'--out='+out],{cwd:fileURLToPath(new URL('../..',import.meta.url))});
  const written=JSON.parse(await readFile(out,'utf8'));
  assert.equal(written.frames.length,2);
  assert.equal(written.frames.every(f=>f.points.length===0),true);
  assert.throws(()=>execFileSync(process.execPath,['experiments/tools/make-label-template.mjs',dir,'--out='+out],{cwd:fileURLToPath(new URL('../..',import.meta.url)),stdio:'pipe'}),/Refusing to overwrite/);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('Windows-compatible CLI main detection executes usage checks before model loading',async()=>{
 const {spawnSync}=await import('node:child_process');
 for(const name of ['analyze-calibration','analyze-stop-observations','audit-false-free','make-label-template']){
  const result=spawnSync(process.execPath,[fileURLToPath(new URL('../../experiments/tools/'+name+'.mjs',import.meta.url))],{encoding:'utf8'});
  assert.notEqual(result.status,0,name);assert.match(result.stderr,/Usage:/,name);
 }
});

// The audit must show inter-frame motion next to the corridor shape. Without
// neighbours the shift is refused, and without a recorded minimap the source is
// never claimed as separated.
test('the audit reports motion separately from corridor drift and states the gap',async()=>{
 const {dir,file}=await labelfile([
  {file:'000000.jpg',points:[{x:.5,y:.5,expected:'hazard',kind:'pole'}]},
  {file:'000004.jpg',points:[{x:.5,y:.5,expected:'hazard',kind:'pole'}]}]);
 try{
  const report=await auditLabels({labelFile:file,resolveImage:async f=>Buffer.from(f),analyze:async()=>corridorFrame,gapFrames:4});
  assert.equal(report.summary.scored,2);
  // Corridor shape stays a per-frame feature; a short corridor refuses it and is
  // reported as null, never as zero drift.
  assert.ok(report.drift_summary===null||report.drift_summary.units==='image fractions');
  // ...while motion is a sequence measurement with its own gap.
  assert.equal(report.motion_summary.frames,2);
  assert.equal(report.motion_summary.gap_frames,4);
  // Two identical masks give a confident zero shift, and that zero is reported
  // without a minimap: the source stays unseparated instead of "car moved".
  assert.equal(report.motion_summary.shift_pixels.count,1);
  assert.equal(report.motion_summary.sources.stationary_without_minimap,1);
  assert.match(report.motion_summary.note,/not a yaw/);
  // Three clocks: offline analysis exists, a live loop cannot exist offline.
  assert.equal(report.latency.offline_analysis_ms.count,2);
  assert.equal(report.latency.live_loop_ms,null);
  // percentiles() uses n, so the legacy field keeps its own shape.
  assert.equal(report.latency_ms.n,2);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('one labelled frame has no neighbour, so no shift is invented',async()=>{
 const {dir,file}=await labelfile([{file:'000000.jpg',points:[{x:.5,y:.5,expected:'hazard',kind:'pole'}]}]);
 try{
  const report=await auditLabels({labelFile:file,resolveImage:async f=>Buffer.from(f),analyze:async()=>corridorFrame});
  assert.equal(report.motion_summary,null);
  assert.equal(report.summary.scored,1);
 }finally{await rm(dir,{recursive:true,force:true});}
});
