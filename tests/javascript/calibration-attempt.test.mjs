import {test} from 'node:test';import {strict as assert} from 'node:assert';
import {mkdtemp,writeFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';import path from 'node:path';
import {measureAttempt,compareAttempts,draftCoefficients,captureClockAnchor} from '../../packages/control/calibration-attempt.mjs';
import {analyzeCalibrationFolder} from '../../experiments/tools/analyze-calibration.mjs';
import {loadCalibrationEvidence} from '../../packages/control/calibration-evidence.mjs';

// Synthetic attempts only: no GTA frame, no measured braking, no calibration.
const speeds=[0,0,0,1,3,5,7,7,6,4,2,0,0,0,0,0,0,0,1,3];
function attempt({scale=1,kmh=speeds,withSource=true,hold=0,extra={}}={}){
  // hold adds slow coasting frames so the stop time genuinely differs.
  if(hold)kmh=[...kmh.slice(0,8),...Array(hold).fill(6),...kmh.slice(8)];
  const observations=kmh.map((v,i)=>({file:String(i).padStart(4,'0')+'.png',start_ms:1000+i*100,end_ms:1010+i*100,
    age_ms:60,generation:1,received_at_ms:5350+i*100,frame_age_ms:50,roundtrip_ms:5,sequence:i+1,state:{speed:{valid:true,kmh:v,time_ms:1000+i*100},gear:{valid:true,value:'2'}}}));
  const commands=[];
  for(let i=0;i<20;i++)commands.push({elapsed_ms:200+i*40,reason:'bounded_gas',command:{steer:0,throttle:.35,brake:0,duration_ms:200},...(withSource?{source:{capture_start_ms:900+i*40}}:{})});
  for(let i=0;i<=10+hold*2.5;i++)commands.push({elapsed_ms:1000+i*40,reason:'brake_while_forward_moving',command:{steer:0,throttle:.35*0,brake:.35*scale,duration_ms:200},...(withSource?{source:{capture_start_ms:1200+i*40}}:{})});
  return {command_clock_origin_ms:withSource?5000:undefined,schema_version:2,session_id:'synthetic-'+scale,dose:'low',parameters:{throttle:.35,gas_ms:900,steer:0},observations,commands,...extra};
}

test('one saved attempt yields reaction, acceleration, deceleration and stop time',()=>{
 const m=measureAttempt(attempt());
 assert.equal(m.measurable,true);assert.deepEqual(m.blockers,[]);
 assert.equal(m.motion.peak_kmh,7);
 assert.equal(m.motion.reaction_ms,500);
 assert.ok(m.motion.acceleration_kmh_per_s.perSecond>0);
 assert.ok(m.motion.brake_deceleration_mps2>0);
 assert.equal(m.motion.stopped_after_motion,true);
 assert.ok(m.motion.time_to_stop_ms>=600);
 assert.equal(m.motion.creep_frames,0);
 assert.equal(m.timing.anchor.basis,'receipt_clock_estimate');
 assert.match(m.scope,/nothing here is a GTA driving result/);
});

test('an attempt without source-stamped commands refuses to report latency',()=>{
 const m=measureAttempt(attempt({withSource:false}));
 assert.equal(m.measurable,false);
 assert.ok(m.blockers.includes('command_clock_mapping_required'));
 assert.equal(m.motion.reaction_ms,null);assert.equal(m.motion.brake_deceleration_mps2,null);
 assert.equal(m.timing.anchor,null);
});

test('a car that never moves is not reported as a braking measurement',()=>{
 const m=measureAttempt(attempt({kmh:Array(12).fill(0)}));
 assert.equal(m.motion.peak_kmh,0);assert.equal(m.motion.reaction_ms,null);
 assert.equal(m.motion.brake_deceleration_mps2,null);assert.equal(m.motion.stopped_after_motion,false);
});

test('unreadable speeds are counted, never filled from the previous frame',()=>{
 const kmh=speeds.map((v,i)=>i>12?null:v);
 const observations=kmh.map((v,i)=>({file:String(i).padStart(4,'0')+'.png',start_ms:1000+i*100,end_ms:1010+i*100,age_ms:60,
   state:{speed:{valid:v!==null,kmh:v,time_ms:1000+i*100,rejection_reason:v===null?'ocr_unconfirmed':null},gear:{valid:true,value:'2'}}}));
 const m=measureAttempt({...attempt(),observations});
 assert.equal(m.frames.speed_readable,13);
 assert.ok(m.frames.stop_unknown>0);
});

test('repetitions are compared by spread; a single luck run is not enough',()=>{
 const one=compareAttempts([measureAttempt(attempt())]);
 assert.equal(one.status,'insufficient_evidence');
 assert.ok(one.blockers.includes('fewer_than_5_measurable_attempts_per_dose'));
 const many=compareAttempts(Array.from({length:5},(_,i)=>measureAttempt(attempt({scale:1+i*0.01}))));
 assert.equal(many.status,'draft_pending_independent_validation');
 assert.ok(many.blockers.includes('independent_validation_sessions_missing'));
 // Stop time 1020 vs 1620 ms: the repetitions do not agree on deceleration.
 const scattered=compareAttempts([0,16,0,16,0].map(hold=>measureAttempt(attempt({hold}))));
 assert.equal(scattered.status,'insufficient_evidence');
 assert.ok(scattered.blockers.includes('repetitions_disagree'));
 assert.match(many.scope,/verified evidence bundle are still required/);
});

test('a caller-declared independent validation session changes only the blockers, not the status',()=>{
 const independent=Array.from({length:5},(_,i)=>measureAttempt(attempt({extra:{independent_validation:true,session_id:'independent-'+i}})));
 const c=compareAttempts(independent);
 assert.equal(c.status,'draft_pending_independent_validation');
 assert.equal(c.blockers.includes('independent_validation_sessions_missing'),false);
 const draft=draftCoefficients(c,{sessions:['val-1']});
 assert.equal(draft.ready_for_gate,false);
});

test('draft coefficients are explicitly not a bundle and are rejected by the gate loader',async()=>{
 const comparison=compareAttempts(Array.from({length:5},(_,i)=>measureAttempt(attempt({extra:{session_id:'repeat-'+i}}))));
 const draft=draftCoefficients(comparison,{sessions:['synthetic'],vehicleId:'synthetic-car'});
 assert.equal(draft.status,'draft');
 assert.ok(draft.blockers.includes('requires_independent_validation_sessions'));
 assert.equal(Object.keys(draft).includes('model_manifest_sha256'),false);
 const root=await mkdtemp(path.join(tmpdir(),'calib-'));
 try{
  await writeFile(path.join(root,'bundle.json'),JSON.stringify(draft));
  await assert.rejects(loadCalibrationEvidence(path.join(root,'bundle.json'),{modelManifest:new URL('../../models-manifest.json',import.meta.url)}),/Verified vehicle\/camera\/input calibration bundle required/);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('the folder tool finds attempts, reviews them and writes a review file',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'calib-runs-'));
 try{
  for(let i=0;i<5;i++){const dir=path.join(root,'low-'+i);await mkdir(dir,{recursive:true});await writeFile(path.join(dir,'report.json'),JSON.stringify(attempt({scale:1+i*0.01,extra:{session_id:'s'+i}})));}
  const report=await analyzeCalibrationFolder(root,{minRepetitions:5});
  assert.equal(report.files.length,5);
  assert.equal(report.comparison.groups.length,1);
  assert.equal(report.comparison.groups[0].attempts,5);
  assert.equal(report.draft.status,'draft');
  assert.equal(report.draft.generated_for.vehicle_id,null);
  await assert.rejects(analyzeCalibrationFolder(path.join(root,'missing')),/No report\.json/);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('clock mapping uses receipt telemetry and refuses source-only timestamps',()=>{
 const o=(start,received)=>({start_ms:start,frame_age_ms:20,received_at_ms:received,roundtrip_ms:4});
 const stable=captureClockAnchor({command_clock_origin_ms:5000,observations:[o(1000,5120),o(1100,5220)]});
 assert.equal(stable.ok,true);assert.equal(stable.offset,900);assert.equal(stable.uncertainty_ms,5);
 const jittery=captureClockAnchor({command_clock_origin_ms:5000,observations:[o(1000,5120),o(1130,5220)]});assert.equal(jittery.uncertainty_ms,35);
 assert.equal(captureClockAnchor({commands:[{elapsed_ms:100,source:{capture_start_ms:1000}}]}).ok,false);
});

test('expired commands, invalid sources and duplicate sessions cannot produce coefficients',()=>{
 const expired=attempt();for(const c of expired.commands)c.command.duration_ms=1;
 assert.equal(measureAttempt(expired).motion.brake_deceleration_mps2,null);assert.equal(measureAttempt(expired).measurable,false);
 const bad=attempt();bad.observations[4].state.speed.time_ms--;const broken=measureAttempt(bad);assert.equal(broken.measurable,false);assert.equal(broken.motion.reaction_ms,null);
 const repeated=compareAttempts(Array(5).fill(measureAttempt(attempt())));assert.equal(repeated.status,'insufficient_evidence');assert.equal(draftCoefficients(repeated).braking_mps2,null);
 const parked=compareAttempts(Array.from({length:5},(_,i)=>measureAttempt(attempt({kmh:Array(15).fill(0),extra:{session_id:'parked-'+i}}))));assert.equal(parked.status,'insufficient_evidence');
 assert.throws(()=>compareAttempts([measureAttempt(attempt())],{minRepetitions:NaN}));
});
test('braking time starts at first brake, not its final heartbeat',()=>{
 const m=measureAttempt(attempt());assert.equal(m.motion.time_to_stop_ms,600);assert.equal(m.motion.reaction_ms,500);
 const mixed=compareAttempts(Array.from({length:10},(_,i)=>measureAttempt(attempt({extra:{session_id:'p-'+i,profile:{vehicle_id:i<5?'a':'b'}}}))));assert.equal(mixed.status,'insufficient_evidence');assert.ok(mixed.blockers.includes('mixed_calibration_profiles'));
});

test('reverse motion cannot be treated as forward braking evidence',()=>{
 const a=attempt();for(const o of a.observations)o.state.gear.value='R';const m=measureAttempt(a);assert.equal(m.measurable,false);assert.equal(m.motion.brake_deceleration_mps2,null);assert.ok(m.blockers.includes('forward_gear_not_verified'));
});
