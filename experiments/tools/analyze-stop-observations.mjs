// Offline analysis of a passive observation recording. Timeline/latency part needs
// no models; the optional --ocr pass needs the local HUD reader and is the only
// place where a stop can be asserted. No input, no actuator, no labels invented.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {percentiles} from '../../packages/protocols/latency-trace.mjs';
import {StopConfirmation} from '../../packages/perception/stop-confirmation.mjs';

export const TIMELINE_SCOPE='Recorded passive observation timeline only. Latency here is capture-to-receipt at recording time, not a driving result and not a decision delay.';

// Refuses a recording whose manifest is internally inconsistent instead of
// quietly summarising a broken timeline as a low latency.
export function analyzeTimeline(samples,{targetAgeMs=350,maxAgeMs=450,maxGapMs=250}={}){
  if(!Array.isArray(samples)||!samples.length)throw Error('A nonempty samples.jsonl is required');
  const ages=[],intervals=[],problems=[];
  let previous=null;
  for(const [i,r] of samples.entries()){
    if(!Number.isSafeInteger(r.sequence)||r.sequence<1)problems.push({index:i,reason:'invalid_sequence'});
    if(!Number.isFinite(r.capture_start_ms)||!Number.isFinite(r.capture_end_ms)||r.capture_start_ms<0||r.capture_end_ms<r.capture_start_ms)problems.push({index:i,reason:'invalid_capture_interval'});
    if(r.capture_skew_ms!==0)problems.push({index:i,reason:'nonzero_capture_skew'});
    if(!Number.isFinite(r.age_ms)||r.age_ms<0)problems.push({index:i,reason:'invalid_age'});
    else ages.push(r.age_ms);
    if(previous&&(r.sequence<=previous.sequence||r.capture_start_ms<=previous.capture_start_ms))problems.push({index:i,reason:'non_increasing_timeline'});
    if(previous)intervals.push(r.capture_start_ms-previous.capture_start_ms);
    previous=r;
  }
  const over=(list,limit)=>list.filter(v=>v>limit).length;
  const ageStats=percentiles(ages),gapStats=percentiles(intervals);
  return {
    frames:samples.length,
    recorded_span_ms:samples.at(-1).capture_start_ms-samples[0].capture_start_ms,
    mean_fps:intervals.length?1000/(intervals.reduce((a,b)=>a+b,0)/intervals.length):null,
    capture_interval_ms:gapStats,
    observation_age_ms:ageStats,
    frames_over_target_age:over(ages,targetAgeMs),
    frames_rejected_by_age_limit:over(ages,maxAgeMs),
    gaps_over_max_ms:over(intervals,maxGapMs),
    timeline_problems:problems,
    // Explicit verdicts instead of an encouraging average.
    age_target_met:ages.length>0&&over(ages,targetAgeMs)===0,
    age_limit_respected:ages.length>0&&over(ages,maxAgeMs)===0,
    continuous_timeline:problems.length===0&&over(intervals,maxGapMs)===0,
    scope:TIMELINE_SCOPE
  };
}

export async function analyzeStops(root,{readerFactory=null,maxSpeedKmh=1}={}){
  const samples=(await readFile(path.join(root,'samples.jsonl'),'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
  const session=JSON.parse(await readFile(path.join(root,'session.json'),'utf8'));
  if(session.source!=='single_capture')throw Error('A single-capture observation recording is required');
  const timeline=analyzeTimeline(samples);
  const base={session:session.id,role:session.role,camera_declared:session.camera_declared,camera_verified:session.camera_verified,game_input_sent:false,timeline};
  if(!readerFactory)return {...base,stops:null,stops_scope:'OCR pass not requested (--ocr). Latency/timeline only; no stop is asserted.'};
  const {VehicleStateReader}=await import('../../packages/perception/vehicle-state.mjs');
  const {hudProfile}=await import('../../packages/perception/hud-profile.mjs');
  const reader=await readerFactory(hudProfile(samples[0].hud_geometry));
  const confirm=new StopConfirmation({maxSpeedKmh});
  const states=[],readTimes=[];let stops=0,creep=0,unreadable=0,released=0,wasStopped=false;
  try{
    for(const s of samples){
      if(JSON.stringify(s.hud_geometry)!==JSON.stringify(samples[0].hud_geometry))throw Error('HUD geometry changed within the recording');
      const start=performance.now();
      const state=await reader.read(await readFile(path.join(root,s.hud_file)),s.capture_start_ms);
      readTimes.push(performance.now()-start);
      const verdict=confirm.update({sequence:s.sequence,capture_start_ms:s.capture_start_ms,capture_end_ms:s.capture_end_ms,age_ms:s.age_ms,speed:state.speed,gear:state.gear});
      if(verdict.state==='unknown')unreadable++;
      // One event per confirmed transition, not one per confirmatory frame.
      if(verdict.state==='stopped'&&!wasStopped)stops++;
      wasStopped=verdict.state==='stopped';
      if(verdict.creep_detected)creep++;
      if(verdict.pedal_release_allowed)released++;
      states.push({file:s.file,sequence:s.sequence,capture_start_ms:s.capture_start_ms,state,verdict});
    }
  }finally{await reader.close?.();}
  const readable=states.filter(r=>r.state.speed.valid).length;
  return {...base,stops:{frames:samples.length,readable_speed:readable,unreadable_speed:unreadable,
    confirmed_stop_events:stops,creep_events:creep,pedal_release_frames:released,
    read_ms:percentiles(readTimes),
    stop_confirmation_scope:'Sequential OCR over the whole recording. A confirmed stop needs '+confirm.minZeroFrames+' consecutive fresh forward-gear readings at or below '+maxSpeedKmh+' km/h. This is screen evidence, not a measurement of braking distance.',
    states}};
}

const isMain=process.argv[1]&&path.resolve(process.argv[1])===path.resolve(new URL(import.meta.url).pathname);
if(isMain){
  const root=path.resolve(process.argv[2]??'');
  if(!process.argv[2])throw Error('Usage: node experiments/tools/analyze-stop-observations.mjs <recording-folder> [--ocr] [--speed=1] [--out=report.json]');
  const ocr=process.argv.includes('--ocr'),maxSpeedKmh=Number(process.argv.find(a=>a.startsWith('--speed='))?.split('=')[1]??1);
  const output=process.argv.find(a=>a.startsWith('--out='))?.slice(6)??path.join(root,'stop-analysis.json');
  let readerFactory=null;
  if(ocr){
    const {VehicleStateReader}=await import('../../packages/perception/vehicle-state.mjs');
    // The raw HUD reader takes the crop geometry only, exactly like other tools.
    readerFactory=profile=>VehicleStateReader.create({...profile,speed:{...profile.speed,padded_consensus:true},gear:{...profile.gear,shape_confirmation:true}});
  }
  const report=await analyzeStops(root,{maxSpeedKmh,readerFactory});
  await mkdir(path.dirname(output),{recursive:true});
  await writeFile(output,JSON.stringify(report,null,2));
  console.log(JSON.stringify({report:output,frames:report.timeline.frames,mean_fps:report.timeline.mean_fps,
    age_p50:report.timeline.observation_age_ms?.p50,age_p95:report.timeline.observation_age_ms?.p95,
    frames_over_350:report.timeline.frames_over_target_age,frames_over_450:report.timeline.frames_rejected_by_age_limit,
    gaps_over_250:report.timeline.gaps_over_max_ms,continuous:report.timeline.continuous_timeline,
    confirmed_stops:report.stops?.confirmed_stop_events??null},null,2));
}
