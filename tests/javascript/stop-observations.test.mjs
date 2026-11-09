import {test} from 'node:test';import {strict as assert} from 'node:assert';
import {mkdtemp,writeFile,readFile,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';import path from 'node:path';
import {analyzeTimeline,analyzeStops} from '../../experiments/tools/analyze-stop-observations.mjs';

const sample=(i,{start=1000+i*125,span=20,age=60,gap=0,skew=0,sequence=i+1}={})=>({
  file:String(i).padStart(6,'0')+'.jpg',hud_file:String(i).padStart(6,'0')+'-hud.png',minimap_file:String(i).padStart(6,'0')+'-map.png',
  sequence,capture_start_ms:start,capture_end_ms:start+span,age_ms:age,capture_skew_ms:skew,
  hud_geometry:{full_width:1904,full_height:994,left:1561,top:755,width:248,height:139},minimap_region:{left:0,top:715,width:476,height:279}});

test('a clean recording reports latency and continuity without inventing a stop',()=>{
 const rows=Array.from({length:40},(_,i)=>sample(i));
 const t=analyzeTimeline(rows);
 assert.equal(t.frames,40);assert.equal(t.continuous_timeline,true);assert.equal(t.age_target_met,true);
 assert.equal(t.capture_interval_ms.p50,125);assert.equal(t.frames_over_target_age,0);assert.equal(t.gaps_over_max_ms,0);
 assert.match(t.scope,/not a driving result/);
});

test('old, gapped, skewed or reordered recordings are flagged instead of averaged away',()=>{
 const old=analyzeTimeline(Array.from({length:10},(_,i)=>sample(i,{age:420})));
 assert.equal(old.age_target_met,false);assert.equal(old.age_limit_respected,true);assert.equal(old.frames_over_target_age,10);
 const stale=analyzeTimeline(Array.from({length:10},(_,i)=>sample(i,{age:451})));
 assert.equal(stale.age_limit_respected,false);assert.equal(stale.frames_rejected_by_age_limit,10);
 const gapped=Array.from({length:10},(_,i)=>sample(i,{start:1000+i*300}));
 const g=analyzeTimeline(gapped);assert.equal(g.continuous_timeline,false);assert.equal(g.gaps_over_max_ms,9);
 const skewed=analyzeTimeline([sample(0,{skew:3}),sample(1)]);
 assert.deepEqual(skewed.timeline_problems.map(p=>p.reason),['nonzero_capture_skew']);assert.equal(skewed.continuous_timeline,false);
 const reordered=analyzeTimeline([sample(0),sample(1),sample(0)]);
 assert.equal(reordered.timeline_problems.at(-1).reason,'non_increasing_timeline');
 assert.throws(()=>analyzeTimeline([]),/nonempty/);
});

test('the offline tool refuses a non single-capture session and keeps OCR optional',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'stop-obs-'));
 try{
  const rows=Array.from({length:5},(_,i)=>sample(i));
  await writeFile(path.join(root,'samples.jsonl'),rows.map(r=>JSON.stringify(r)).join('\n')+'\n');
  await writeFile(path.join(root,'session.json'),JSON.stringify({id:'synthetic',role:'development',source:'separate_captures',game_input_sent:false}));
  await assert.rejects(analyzeStops(root),/single-capture/);
  await writeFile(path.join(root,'session.json'),JSON.stringify({id:'synthetic',role:'development',source:'single_capture',camera_declared:'rear',camera_verified:false,game_input_sent:false}));
  const report=await analyzeStops(root);
  assert.equal(report.stops,null);assert.equal(report.timeline.frames,5);assert.equal(report.game_input_sent,false);
  assert.match(report.stops_scope,/no stop is asserted/);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('with a supplied reader every frame is read in order and stops are only counted from evidence',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'stop-obs-'));
 try{
  const rows=Array.from({length:8},(_,i)=>sample(i));
  await mkdir(root,{recursive:true});
  await writeFile(path.join(root,'samples.jsonl'),rows.map(r=>JSON.stringify(r)).join('\n')+'\n');
  await writeFile(path.join(root,'session.json'),JSON.stringify({id:'synthetic',role:'development',source:'single_capture',camera_declared:'rear',camera_verified:false,game_input_sent:false}));
  for(const r of rows)await writeFile(path.join(root,r.hud_file),'synthetic hud');
  const kmhByFrame={0:14,1:8,2:3,3:0,4:0,5:0,6:0,7:2};
  const read=[];
  const report=await analyzeStops(root,{readerFactory:async()=>({read:async(bytes,time_ms)=>{read.push(time_ms);return {time_ms,speed:{valid:true,kmh:kmhByFrame[read.length-1],time_ms},gear:{valid:true,value:'2'}};},close:async()=>{}})});
  assert.deepEqual(read,rows.map(r=>r.capture_start_ms));
  assert.equal(report.stops.confirmed_stop_events,1);
  assert.equal(report.stops.pedal_release_frames,2);
  assert.equal(report.stops.creep_events,1);
  // The analysis must not rewrite the recording it inspects.
  assert.equal((await readFile(path.join(root,'samples.jsonl'),'utf8')).trim().split('\n').length,8);
 }finally{await rm(root,{recursive:true,force:true});}
});
