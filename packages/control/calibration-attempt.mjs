// Offline measurement of saved calibration attempts (report.json from
// calibrate-analog.mjs). Produces numbers and a *draft* coefficient set; it never
// writes a verified calibration bundle and never sends input.
import {StopConfirmation} from '../perception/stop-confirmation.mjs';

const num=x=>Number.isFinite(x);
const median=values=>{
  if(!values.length)return null;
  const s=[...values].sort((a,b)=>a-b),m=Math.floor(s.length/2);
  return s.length%2?s[m]:(s[m-1]+s[m])/2;
};
const quantile=(values,q)=>{
  if(!values.length)return null;
  const s=[...values].sort((a,b)=>a-b);
  return s[Math.max(0,Math.ceil(q*s.length)-1)];
};
// Least-squares slope of speed against time; used only as a summary slope.
function slope(points){
  if(points.length<3)return null;
  const n=points.length,meanT=points.reduce((a,p)=>a+p.t,0)/n,meanV=points.reduce((a,p)=>a+p.v,0)/n;
  let sxy=0,sxx=0,sst=0;
  for(const p of points){sxy+=(p.t-meanT)*(p.v-meanV);sxx+=(p.t-meanT)**2;sst+=(p.v-meanV)**2;}
  if(sxx===0)return null;
  const b=sxy/sxx,pred=points.map(p=>meanV+b*(p.t-meanT)),sse=points.reduce((a,p,i)=>a+(p.v-pred[i])**2,0);
  return {perSecond:b,r2:sst===0?null:1-sse/sst,samples:n};
}

// Receipt timestamps and broker age headers bound the offset between clocks.
// A decision source timestamp only identifies an older input frame and must
// never stand in for the timestamp of command dispatch.
export function captureClockAnchor(attempt){
  const origin=attempt.command_clock_origin_ms;
  const pairs=[];
  if(!num(origin))return {ok:false,reason:'command_clock_mapping_required'};
  for(const o of attempt.observations??[]){
    if(![o.start_ms,o.frame_age_ms,o.received_at_ms,o.roundtrip_ms].every(num)||o.frame_age_ms<0||o.roundtrip_ms<0)continue;
    pairs.push({offset:o.start_ms+o.frame_age_ms-(o.received_at_ms-origin),uncertainty:o.roundtrip_ms+1});
  }
  if(!pairs.length)return {ok:false,reason:'command_clock_mapping_required'};
  const offset=pairs[0].offset;
  return {ok:true,offset,uncertainty_ms:Math.max(...pairs.map(p=>Math.abs(p.offset-offset)+p.uncertainty)),
    pairs:pairs.length,basis:'receipt_clock_estimate',note:'Clock estimate uses capture-age headers and Node receipt times with roundtrip uncertainty. Source frame time is not command dispatch time.'};
}

// The caller states, per attempt, whether its sessions were kept out of the fit.
// Nothing is inferred from filenames or timestamps.
export function measureAttempt(attempt){
  if(!attempt||typeof attempt!=='object')throw Error('An attempt report object is required');
  const observations=(attempt.observations??[]).filter(o=>o&&o.state&&num(o.start_ms));
  const commands=(attempt.commands??[]).filter(c=>c&&c.command&&num(c.elapsed_ms));
  const blockers=[];
  if(!observations.length)blockers.push('no_observations');
  if(!commands.length)blockers.push('no_commands');
  const anchor=captureClockAnchor(attempt);
  if(!anchor.ok)blockers.push(anchor.reason);
  if(attempt.observer_error)blockers.push('observer_error');
  if(attempt.error)blockers.push('attempt_error');
  if(attempt.start_readiness&&attempt.start_readiness.ready!==true)blockers.push('startup_not_ready');
  if(attempt.arm_readiness&&attempt.arm_readiness.ready!==true)blockers.push('arm_not_ready');

  let previous=null;
  for(const o of observations){
    if(o.state.gear?.value==='R'||o.state.gear?.value==='N'||o.state.speed?.kmh>1&&(o.state.gear?.valid!==true||!/^[1-8]$/.test(o.state.gear.value??'')))blockers.push('forward_gear_not_verified');
    if(!Number.isSafeInteger(o.sequence)||!Number.isSafeInteger(o.generation)||!num(o.end_ms)||o.end_ms<o.start_ms||!num(o.age_ms)||o.age_ms<0||o.age_ms>450||o.state.speed?.time_ms!==o.start_ms||previous&&(o.sequence<=previous.sequence||o.start_ms<=previous.start_ms||o.generation!==previous.generation))blockers.push('invalid_observation_timeline');
    previous=o;
  }
  let previousElapsed=-Infinity;
  for(const c of commands){
    if(c.elapsed_ms<previousElapsed||['steer','throttle','brake'].some(k=>!num(c.command[k]))||Math.abs(c.command.steer)>1||c.command.throttle<0||c.command.throttle>1||c.command.brake<0||c.command.brake>1||c.command.throttle>0&&c.command.brake>0)blockers.push('invalid_command_timeline');
    previousElapsed=c.elapsed_ms;
  }
  if(observations.length!==(attempt.observations??[]).length)blockers.push('invalid_observation_timeline');
  if(commands.length!==(attempt.commands??[]).length)blockers.push('invalid_command_timeline');
  if(blockers.some(r=>r.startsWith('invalid_')||r==='forward_gear_not_verified'))anchor.ok=false;
  const toCapture=anchor.ok?t=>t+anchor.offset:()=>null;
  const timeline=observations.map(o=>({file:o.file??null,sequence:o.sequence,generation:o.generation,speed_time_ms:o.state.speed?.time_ms,start_ms:o.start_ms,end_ms:num(o.end_ms)?o.end_ms:o.start_ms,
    age_ms:num(o.age_ms)?o.age_ms:null,kmh:o.state?.speed?.valid===true&&num(o.state.speed.kmh)?o.state.speed.kmh:null,
    gear:o.state?.gear?.valid===true?o.state.gear.value:null}));
  const readable=timeline.filter(t=>t.kmh!==null);
  if(!readable.length)blockers.push('speed_never_readable');

  // Command episodes: consecutive commands with the same mode of actuation.
  const stamped=commands.map(c=>({elapsed:c.elapsed_ms,capture:toCapture(c.elapsed_ms),reason:c.reason,command:c.command,
    expires:num(c.source?.decision_expires_ms)?c.source.decision_expires_ms:Infinity,
    duration_ms:num(c.duration_ms)?c.duration_ms:num(c.command.duration_ms)?c.command.duration_ms:null}));
  const firstGas=stamped.find(c=>c.command.throttle>0);
  const firstBrake=stamped.find(c=>c.command.brake>0);
  const gasEnd=(()=>{if(!firstGas)return null;const after=stamped.filter(c=>c.elapsed>=firstGas.elapsed&&c.command.throttle<=0);return after.length?after[0].capture:null;})();

  // Onset of motion: first readable speed above 1 km/h at or after the first gas.
  const onset=firstGas?readable.find(t=>t.kmh>1&&t.start_ms>=firstGas.capture):null;
  // Without a clock anchor the capture time of the command is unknown, so no
  // reaction latency is reported at all.
  const reaction_ms=firstGas&&onset&&anchor.ok?Math.round(onset.start_ms-firstGas.capture):null;
  const peak=readable.length?readable.reduce((a,b)=>b.kmh>a.kmh?b:a):null;
  const peakIndex=peak?readable.indexOf(peak):-1;

  // Acceleration is fitted from the first gas to the peak speed; a fit that needs
  // fewer than three readable frames is reported as null rather than as 0.
  const acceleration=firstGas&&peak&&anchor.ok?(()=>{
    // Fit the observed rise up to the peak, whether the gas was still on or not.
    const points=readable.filter(t=>t.start_ms>=firstGas.capture&&t.start_ms<=peak.start_ms).map(t=>({t:(t.start_ms-firstGas.capture)/1000,v:t.kmh}));
    const s=slope(points);
    return s?{...s,from_ms:Math.round(points[0].t*1000),to_ms:Math.round(points.at(-1).t*1000),points:points.length}:null;
  })():null;

  // Coasting: throttle and brake both zero, speed decreasing between frames.
  const coastSegments=[];
  const brakeSegments=[];
  for(let i=1;i<readable.length;i++){
    const a=readable[i-1],b=readable[i],dt=(b.start_ms-a.start_ms)/1000;
    if(dt<=0||dt>1.5||a.kmh===null||b.kmh===null)continue;
    const rate=(b.kmh-a.kmh)/dt;
    const at=stamped.filter(c=>c.capture!==null&&c.capture<=a.start_ms).at(-1);
    if(!at||!num(at.duration_ms)||b.start_ms>Math.min(at.capture+at.duration_ms,at.expires)||stamped.some(c=>c.capture>a.start_ms&&c.capture<b.start_ms&&['steer','throttle','brake'].some(k=>c.command[k]!==at.command[k])))continue;
    if(!at)continue;
    if(!anchor.ok)continue;
    if(at.command.throttle<=0&&at.command.brake<=0&&rate<0)coastSegments.push({kmh_per_s:rate,dt_s:dt});
    if(at.command.brake>0&&rate<0)brakeSegments.push({kmh_per_s:rate,dt_s:dt,brake:at.command.brake});
  }
  const meanRate=segs=>segs.length?segs.reduce((a,s)=>a+s.kmh_per_s*s.dt_s,0)/segs.reduce((a,s)=>a+s.dt_s,0):null;
  const coast=meanRate(coastSegments),braking=meanRate(brakeSegments);

  // Stop evidence only from the same sequential reader rules used elsewhere.
  const confirm=new StopConfirmation({});
  let zeroFrames=0,creep=0,unreadable=0;
  // Runs of confirmed stops, so the stop *after* the measured motion is the one used.
  const stopRuns=[];
  let inStop=false;
  for(const [i,t] of timeline.entries()){
    const verdict=confirm.update({generation:t.generation,sequence:t.sequence,
      capture_start_ms:t.start_ms,capture_end_ms:t.end_ms,age_ms:t.age_ms,
      speed:t.kmh===null?{valid:false,kmh:null}:{valid:true,kmh:t.kmh,time_ms:t.speed_time_ms},
      gear:t.gear===null?{valid:false,value:null}:{valid:true,value:t.gear}});
    if(verdict.state==='unknown')unreadable++;
    if(verdict.state==='stopped'&&verdict.pedal_release_allowed){zeroFrames++;if(!inStop){inStop=true;stopRuns.push(t.start_ms);}}
    else inStop=false;
    if(verdict.creep_detected)creep++;
  }
  const peak_kmh=peak?peak.kmh:null;
  // The stop that matters follows the measured motion: a car that starts parked
  // already shows three zeros and must not be reported as "stopped in 0 ms".
  const moved=(peak?.kmh??0)>1;
  const stopAt=moved?stopRuns.find(start=>start>peak.start_ms)??null:null;
  const stoppedAfterMotion=stopAt!==null;
  const brakingBeforeStop=stoppedAfterMotion?stamped.find(c=>c.capture!==null&&c.capture>=(firstGas?.capture??-Infinity)&&c.capture<=stopAt&&c.command.brake>0):null;
  const stop_time_ms=brakingBeforeStop&&anchor.ok?Math.round(stopAt-brakingBeforeStop.capture):null;

  if(!moved||reaction_ms===null)blockers.push('motion_not_measured');
  if(braking===null||!stoppedAfterMotion)blockers.push('braking_not_measured');
  const envelope={
    max_throttle:stamped.length?Math.max(...stamped.map(c=>c.command.throttle)):null,
    max_brake:stamped.length?Math.max(...stamped.map(c=>c.command.brake)):null,
    max_abs_steer:stamped.length?Math.max(...stamped.map(c=>Math.abs(c.command.steer))):null};

  return {
    session_id:attempt.session_id??null,profile:attempt.profile??null,
    dose:attempt.dose??null,parameters:attempt.parameters??null,
    independent_validation:attempt.independent_validation===true,
    measurable:blockers.length===0,
    blockers,
    timing:{anchor:anchor.ok?{offset:anchor.offset,uncertainty_ms:anchor.uncertainty_ms,pairs:anchor.pairs,basis:anchor.basis}:null,
      note:anchor.ok?anchor.note:'Reaction latency and deceleration need source-stamped commands; missing here.'},
    frames:{observations:observations.length,speed_readable:readable.length,stop_unknown:unreadable,recorded_span_ms:timeline.length?timeline.at(-1).start_ms-timeline[0].start_ms:null},
    motion:{peak_kmh,reaction_ms,acceleration_kmh_per_s:acceleration,
      coast_deceleration_kmh_per_s:coast,brake_deceleration_kmh_per_s:braking,
      brake_deceleration_mps2:braking===null?null:Math.abs(braking)/3.6,
      time_to_stop_ms:stop_time_ms,confirmed_stop_frames:zeroFrames,creep_frames:creep,
      stopped:stopAt!==null,stopped_after_motion:stoppedAfterMotion},
    command_reasons:[...new Set(stamped.map(c=>c.reason))].filter(Boolean),
    envelope,
    scope:'Offline measurement of one saved attempt. Times between command and observation are a receipt-clock estimate on two different clocks. OCR availability limits every value; nothing here is a GTA driving result.'
  };
}

// Several attempts of the same dose: spread and disagreement, never a single
// lucky run promoted to a coefficient.
export function compareAttempts(attempts,{minRepetitions=5,disagreementRatio=2}={}){
  if(!Number.isInteger(minRepetitions)||minRepetitions<5||!num(disagreementRatio)||disagreementRatio<1)throw Error('At least five repetitions and a finite spread ratio required');
  if(!Array.isArray(attempts)||!attempts.length)throw Error('A nonempty list of attempts is required');
  const normAttempts=attempts.map(a=>a&&a.motion&&Array.isArray(a.blockers)?a:measureAttempt(a));
  const measured=normAttempts;
  const groups=new Map();
  for(const m of measured){
    const key=JSON.stringify({profile:m.profile,parameters:m.parameters??{dose:m.dose}});
    if(!groups.has(key))groups.set(key,[]);
    groups.get(key).push(m);
  }
  const summarize=values=>{
    const clean=values.filter(num);
    return {n:values.length,measured:clean.length,median:median(clean),min:clean.length?Math.min(...clean):null,max:clean.length?Math.max(...clean):null,p95:quantile(clean,.95)};
  };
  const rows=[...groups].map(([key,list])=>({
    key,dose:list[0].dose,parameters:list[0].parameters,attempts:list.length,
    measurable:new Set(list.filter(m=>m.measurable&&typeof m.session_id==='string'&&m.session_id).map(m=>m.session_id)).size,
    blockers:[...new Set(list.flatMap(m=>m.blockers))],
    reaction_ms:summarize(list.filter(m=>m.measurable).map(m=>m.motion.reaction_ms)),
    brake_deceleration_mps2:summarize(list.filter(m=>m.measurable).map(m=>m.motion.brake_deceleration_mps2)),
    time_to_stop_ms:summarize(list.filter(m=>m.measurable).map(m=>m.motion.time_to_stop_ms)),
    peak_kmh:summarize(list.filter(m=>m.measurable).map(m=>m.motion.peak_kmh)),
    max_throttle:summarize(list.filter(m=>m.measurable).map(m=>m.envelope.max_throttle)),
    max_brake:summarize(list.filter(m=>m.measurable).map(m=>m.envelope.max_brake)),
    max_abs_steer:summarize(list.filter(m=>m.measurable).map(m=>m.envelope.max_abs_steer))
  }));
  const sparse=rows.some(r=>r.measurable<minRepetitions);
  const mixedProfiles=new Set(normAttempts.map(m=>JSON.stringify(m.profile))).size>1;
  // Measurable attempts are necessary, not sufficient: the coefficient still has
  // to be checked on sessions that were not used to derive it.
  const independent=rows.every(r=>r.measurable>=minRepetitions);
  const independentValidation=normAttempts.every(a=>a.independent_validation===true);
  // Repetitions disagree when a slower/faster spread exceeds the ratio; zero or
  // missing values are not treated as infinitely disagreeing.
  const spread=(s)=>num(s.min)&&num(s.max)&&s.min>0?s.max/s.min:1;
  const disagreeing=rows.filter(r=>spread(r.brake_deceleration_mps2)>disagreementRatio||spread(r.time_to_stop_ms)>disagreementRatio);
  return {groups:rows,
    status:sparse||disagreeing.length||mixedProfiles?'insufficient_evidence':'draft_pending_independent_validation',
    blockers:[...(mixedProfiles?['mixed_calibration_profiles']:[]),...(sparse?['fewer_than_'+minRepetitions+'_measurable_attempts_per_dose']:[]),...(disagreeing.length?['repetitions_disagree']:[]),
      ...(independent&&!disagreeing.length&&!independentValidation?['independent_validation_sessions_missing']:[])],
    scope:'Spread across repetitions only. Independent development/validation sessions and a verified evidence bundle are still required before any coefficient reaches DriveSafetyGate.'};
}

// Draft coefficients for review. Deliberately not a bundle: status draft and no
// hashes, so loadCalibrationEvidence() rejects it.
export function draftCoefficients(comparison,{sessions=[],vehicleId=null,actuatorKind='gamepad',cameraProfile='rear'}={}){
  if(!comparison||!Array.isArray(comparison.groups))throw Error('comparison is required');
  const usable=comparison.status==='draft_pending_independent_validation'?comparison.groups.filter(g=>g.measurable>=5):[];
  const pick=(list,key)=>median(list.map(g=>g[key].median).filter(num));
  const lowest=(list,key)=>{const values=list.map(g=>g[key].median).filter(num);return values.length?Math.min(...values):null;};
  const coefficients={
    schema_version:1,status:'draft',
    generated_for:{vehicle_id:vehicleId,actuator_kind:actuatorKind,camera_profile:cameraProfile},
    sessions,
    braking_mps2:pick(usable,'brake_deceleration_mps2'),
    reaction_ms:pick(usable,'reaction_ms'),
    time_to_stop_ms:pick(usable,'time_to_stop_ms'),
    max_throttle:null,
    per_dose:usable.map(g=>({dose:g.dose,parameters:g.parameters,attempts:g.attempts,braking_mps2:g.brake_deceleration_mps2.median,reaction_ms:g.reaction_ms.median,time_to_stop_ms:g.time_to_stop_ms.median})),
    based_on:comparison.status,
    // Never presented as validation-ready: repetition fit alone is not evidence.
    ready_for_gate:false,
    blockers:[...comparison.blockers,'requires_independent_validation_sessions','requires_measured_distance_scale'],
    note:'Draft numbers for review only. Not a verified bundle; latency uses a single-anchor estimate across two clocks. Independent validation sessions and a measured distance scale are still missing.'
  };
  // Command envelope: the lowest measured limit, never an extrapolated one.
  coefficients.max_throttle=lowest(usable,'max_throttle');
  coefficients.max_brake=lowest(usable,'max_brake');
  coefficients.max_steer=lowest(usable,'max_abs_steer');
  return coefficients;
}
