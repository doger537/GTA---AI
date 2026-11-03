// User prepares stationary car on a clear straight. Saves all observations; no neural driving.
import {GamepadWorker} from './analog-actuator.mjs';import {connect,frameAge} from '../GtaControl/bridge-client.mjs';import {VehicleStateReader,GAUGE_PROFILE} from './vehicle-state.mjs';import {calibrationCommand} from './calibration-policy.mjs';import {writeFile,mkdir} from 'node:fs/promises';
import {hudProfile} from './hud-profile.mjs';
const pid=Number(process.argv.find(a=>a.startsWith('--pid='))?.split('=')[1]);if(!Number.isInteger(pid)||pid<=0)throw Error('Explicit GTA pid required');
const dose=process.argv.find(a=>a.startsWith('--dose='))?.split('=')[1]??'low',levels={low:{throttle:.35,gas_ms:900,steer:0},medium:{throttle:.45,gas_ms:1200,steer:0},left:{throttle:.3,gas_ms:900,steer:-.3},right:{throttle:.3,gas_ms:900,steer:.3}};
if(!levels[dose])throw Error('Dose low, medium, left or right');
const stationaryGear=process.argv.find(a=>a.startsWith('--stationary-gear='))?.split('=')[1]??null;
const nativeHud=process.argv.includes('--native-hud');
if(stationaryGear&&!/^[R1-8]$/.test(stationaryGear))throw Error('Manual initial gear must be a visually reviewed R or 1..8');
function observedState(state){if(stationaryGear&&state.speed.valid&&state.speed.kmh<=1&&!state.gear.valid)return {...state,gear:{valid:true,value:stationaryGear,source:'operator_visual_stationary_only'}};return state;}
const client=await connect(),initial=await client.status();if(!initial.foreground||initial.busy){client.close();throw Error('Focus GTA and disable other actuators');}
const firstHud=nativeHud?await client.hud():null,hudGeometry=firstHud?JSON.stringify(firstHud.hud):null;
const reader=await VehicleStateReader.create(firstHud?hudProfile(firstHud.hud):{...GAUGE_PROFILE,speed:{...GAUGE_PROFILE.speed,padded_consensus:true},gear:{...GAUGE_PROFILE.gear,shape_confirmation:true}}),root=new URL(`./runs/calibration/${new Date().toISOString().replaceAll(':','-')}/`,import.meta.url);await mkdir(root,{recursive:true});
let worker=null,latest=null,observing=true,observer=null,observerError=null,reason=null,error=null;const observations=[],commands=[];
async function check(){const s=await client.status();if(!s.foreground||s.busy||s.generation!==initial.generation)throw Error('User stop or focus change');}
async function observe(){let seq=-1;while(observing){await check();const f=nativeHud?await client.hud():await client.frame();if(nativeHud&&JSON.stringify(f.hud)!==hudGeometry)throw Error('HUD geometry changed');if(f.sequence===seq){await new Promise(r=>setTimeout(r,10));continue;}seq=f.sequence;
  let state;
  if(stationaryGear){const speed=await reader.speed.read(f.bytes,f.capture_start_ms);state=speed.valid&&speed.kmh<=1?{time_ms:f.capture_start_ms,speed,gear:{valid:false,value:null,reason:'operator_stationary_gear_mode'}}:await reader.read(f.bytes,f.capture_start_ms,{speedResult:speed});}
  else state=await reader.read(f.bytes,f.capture_start_ms);
  const name=`${String(observations.length).padStart(4,'0')}.${nativeHud?'png':'jpg'}`;latest={frame:f,state};observations.push({file:name,sequence:f.sequence,start_ms:f.capture_start_ms,end_ms:f.capture_end_ms,state,age_ms:frameAge(f)});await writeFile(new URL(name,root),f.bytes);}}
try{
  observer=observe().catch(e=>{observerError=e;observing=false;});
  const stationary=()=>observations.length>=3&&observations.slice(-3).every(o=>o.state.speed.valid&&o.state.speed.kmh<=1&&observedState(o.state).gear.valid);
  const wait=performance.now();while(!stationary()&&performance.now()-wait<4000&&!observerError)await new Promise(r=>setTimeout(r,30));
  if(observerError)throw observerError;
  const startFrames=observations.slice(-3);if(startFrames.length!==3||startFrames.some(o=>!o.state.speed.valid||o.state.speed.kmh>1||!observedState(o.state).gear.valid))throw Error('Three readable stationary observations required; no driving started');
  worker=new GamepadWorker({device:'vgamepad',targetPid:pid});await worker.ready;await check();
  // Recheck after real device creation; archive timestamps continue to advance.
  if(frameAge(latest.frame)>450||!latest.state.speed.valid||latest.state.speed.kmh>1)throw Error('Starting observation changed or became stale');
  await worker.call('arm');const start=performance.now();let brakeStart=null,braking=false;
  while(performance.now()-start<levels[dose].gas_ms+1100){
    await check();if(observerError)throw observerError;
    const state=observedState(latest.state),policy=calibrationCommand({elapsed_ms:performance.now()-start,observation:state,age_ms:frameAge(latest.frame),...levels[dose],braking});reason=policy.reason;
    if(policy.done)break;
    if(policy.command.brake>0)braking=true;
    const status=await worker.call('command',{...policy.command,duration_ms:200});commands.push({elapsed_ms:performance.now()-start,reason:policy.reason,gear_source:state.gear.source??'ocr',command:policy.command,status});
    if(policy.stop_after_ms){brakeStart??=performance.now();if(performance.now()-brakeStart>=policy.stop_after_ms)break;}
    await new Promise(r=>setTimeout(r,40));
  }
  commands.push({event:'stop',status:await worker.call('stop')});
  await new Promise(r=>setTimeout(r,350));
}catch(e){error=e.message;process.exitCode=1;}
finally{
  if(worker)await worker.close();observing=false;if(observer)await observer;await reader.close();client.close();
  const speeds=observations.filter(o=>o.state.speed.valid).map(o=>o.state.speed.kmh),report={dose,parameters:levels[dose],operator_stationary_gear:stationaryGear,reason,error,scope:'Bounded manually selected calibration; no route or neural driving. OCR availability limits measurement. Optional initial gear is visual operator input, never an OCR confidence claim.',summary:{frames:observations.length,valid_speed:speeds.length,peak_kmh:speeds.length?Math.max(...speeds):null,final_speed:observations.at(-1)?.state.speed??null},observations,commands};
  report.capture_mode=nativeHud?'native_hud_png':'compact_jpeg';report.hud_geometry=firstHud?.hud??null;report.observer_error=observerError?.message??null;
  await writeFile(new URL('report.json',root),JSON.stringify(report,null,2));console.log(JSON.stringify({report:root.pathname,error,reason,summary:report.summary},null,2));
}
