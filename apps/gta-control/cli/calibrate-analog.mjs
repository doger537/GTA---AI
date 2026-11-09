// User prepares stationary car on a clear straight. Saves all observations; no neural driving.
import {GamepadWorker} from '../../../packages/actuation/analog-actuator.mjs';import {connect,frameAge} from '../../../packages/protocols/bridge-client.mjs';import {VehicleStateReader} from '../../../packages/perception/vehicle-state.mjs';import {calibrationCommand} from '../../../packages/control/calibration-policy.mjs';import {writeFile,mkdir} from 'node:fs/promises';
import {hudProfile} from '../../../packages/perception/hud-profile.mjs';
import {calibrationReadiness} from '../../../packages/control/calibration-readiness.mjs';
import {DriveSafetyGate,inspectDrivePermit} from '../../../packages/control/drive-safety-gate.mjs';
import {ObservationStream} from '../../../packages/protocols/observation-stream.mjs';
import {observationContext} from '../../../packages/perception/observation-analysis.mjs';
const pid=Number(process.argv.find(a=>a.startsWith('--pid='))?.split('=')[1]);if(!Number.isInteger(pid)||pid<=0)throw Error('Explicit GTA pid required');
const dose=process.argv.find(a=>a.startsWith('--dose='))?.split('=')[1]??'low',levels={low:{throttle:.35,gas_ms:900,steer:0},medium:{throttle:.45,gas_ms:1200,steer:0},left:{throttle:.3,gas_ms:900,steer:-.3},right:{throttle:.3,gas_ms:900,steer:.3}};
if(!levels[dose])throw Error('Dose low, medium, left or right');
const stationaryGear=process.argv.find(a=>a.startsWith('--stationary-gear='))?.split('=')[1]??null;
const nativeHud=true; // --native-hud is retained as a harmless legacy spelling.
const vehicle_id=process.argv.find(a=>a.startsWith('--vehicle-profile='))?.split('=')[1],camera_profile=process.argv.find(a=>a.startsWith('--camera='))?.split('=')[1];
if(!vehicle_id||!['rear','hood'].includes(camera_profile))throw Error('Explicit --vehicle-profile=NAME and --camera=rear|hood required');
if(stationaryGear&&!/^[R1-8]$/.test(stationaryGear))throw Error('Manual initial gear must be a visually reviewed R or 1..8');
function observedState(state){if(stationaryGear&&state.speed.valid&&state.speed.kmh<=1&&!state.gear.valid)return {...state,gear:{valid:true,value:stationaryGear,source:'operator_visual_stationary_only'}};return state;}
const client=await connect(),initial=await client.status();if(!initial.foreground||initial.busy){client.close();throw Error('Focus GTA and disable other actuators');}
const stream=new ObservationStream(client,{ownerKind:'gamepad'}),gate=new DriveSafetyGate({mode:'calibration',kind:'gamepad',leaseMs:200});
const firstObservation=await stream.read();if(firstObservation.generation!==initial.generation)throw Error('Observation generation changed');
const firstHud=firstObservation.hud,hudGeometry=JSON.stringify(firstHud.hud);
const reader=await VehicleStateReader.create(hudProfile(firstHud.hud)),root=new URL(`../../../experiments/runs/calibration/${new Date().toISOString().replaceAll(':','-')}/`,import.meta.url);await mkdir(root,{recursive:true});
let worker=null,latest=null,observing=true,observer=null,observerError=null,reason=null,error=null,startReadiness=null,armReadiness=null;const observations=[],commands=[];
async function check(){const s=await client.status();if(!s.foreground||s.busy||s.generation!==initial.generation)throw Error('User stop or focus change');return s;}
async function observe(){let seq=-1;while(observing){await check();const o=await stream.read();if(o.generation!==initial.generation)throw Error('Observation generation changed');const f=o.hud;if(nativeHud&&JSON.stringify(f.hud)!==hudGeometry)throw Error('HUD geometry changed');if(f.sequence<=seq)throw Error('Non-increasing observation');seq=f.sequence;
  let state;
  if(stationaryGear){const speed=await reader.speed.read(f.bytes,f.capture_start_ms);state=speed.valid&&speed.kmh<=1?{time_ms:f.capture_start_ms,speed,gear:{valid:false,value:null,reason:'operator_stationary_gear_mode'}}:await reader.read(f.bytes,f.capture_start_ms,{speedResult:speed});}
  else state=await reader.read(f.bytes,f.capture_start_ms);
  const base=String(observations.length).padStart(4,'0'),name=base+'.png';latest={frame:f,state,generation:o.generation,o};gate.observe(observationContext(o,observedState(state),stream.status,{vehicle_id,camera_profile}));observations.push({file:name,hud_file:name,road_file:base+'.jpg',minimap_file:base+'-map.png',hud_geometry:o.hud.hud,minimap_region:o.minimap.region,sequence:f.sequence,generation:o.generation,start_ms:f.capture_start_ms,end_ms:f.capture_end_ms,state,age_ms:frameAge(f)});await Promise.all([writeFile(new URL(name,root),f.bytes),writeFile(new URL(base+'.jpg',root),o.road.bytes),writeFile(new URL(base+'-map.png',root),o.minimap.bytes)]);}}
try{
  observer=observe().catch(e=>{gate.revoke(e.message);observerError=e;observing=false;});
  const readiness=()=>calibrationReadiness(observations.slice(-3).map(o=>({...o,state:observedState(o.state)})),{latestAgeMs:latest?frameAge(latest.frame):Infinity});
  const wait=performance.now();while(!readiness().ready&&performance.now()-wait<4000&&!observerError)await new Promise(r=>setTimeout(r,30));
  if(observerError)throw observerError;
  startReadiness=readiness();if(!startReadiness.ready)throw Error('Calibration startup rejected: '+startReadiness.reason+'; no driving started');
  worker=new GamepadWorker({device:'vgamepad',targetPid:pid,authorization:gate.arm()});await worker.ready;const armStatus=await check();gate.observe(observationContext(latest.o,observedState(latest.state),armStatus,{vehicle_id,camera_profile}));
  // Recheck after real device creation; archive timestamps continue to advance.
  armReadiness=readiness();if(!armReadiness.ready)throw Error('Calibration arm rejected: '+armReadiness.reason);
  await worker.call('arm',undefined,undefined,gate.arm());const start=performance.now();let brakeStart=null,braking=false;
  while(performance.now()-start<levels[dose].gas_ms+1100){
    const controlStatus=await check();if(observerError)throw observerError;
    const state=observedState(latest.state),policy=calibrationCommand({elapsed_ms:performance.now()-start,observation:state,age_ms:frameAge(latest.frame),...levels[dose],braking});reason=policy.reason;
    if(policy.done)break;
    if(policy.command.brake>0)braking=true;
    gate.observe(observationContext(latest.o,state,controlStatus,{vehicle_id,camera_profile}));const command={...policy.command,duration_ms:200},authorization=gate.authorize(command),source=inspectDrivePermit(authorization).source;
    const status=await worker.call('command',command,source,authorization);commands.push({elapsed_ms:performance.now()-start,reason:policy.reason,gear_source:state.gear.source??'ocr',source,command:policy.command,status});
    if(policy.stop_after_ms){brakeStart??=performance.now();if(performance.now()-brakeStart>=policy.stop_after_ms)break;}
    await new Promise(r=>setTimeout(r,40));
  }
  commands.push({event:'stop',status:await worker.call('stop')});
  await new Promise(r=>setTimeout(r,350));
}catch(e){error=e.message;process.exitCode=1;}
finally{
  if(worker)await worker.close();observing=false;if(observer)await observer;await reader.close();client.close();
  const speeds=observations.filter(o=>o.state.speed.valid).map(o=>o.state.speed.kmh),report={schema_version:2,session_id:new Date().toISOString().replaceAll(':','-'),dose,parameters:levels[dose],operator_stationary_gear:stationaryGear,reason,error,scope:'Bounded manually selected calibration; no route or neural driving. OCR availability limits measurement. Optional initial gear is visual operator input, never an OCR confidence claim.',summary:{frames:observations.length,valid_speed:speeds.length,peak_kmh:speeds.length?Math.max(...speeds):null,final_speed:observations.at(-1)?.state.speed??null},observations,commands};
  report.capture_mode=nativeHud?'native_hud_png':'compact_jpeg';report.hud_geometry=firstHud?.hud??null;report.observer_error=observerError?.message??null;
  report.start_readiness=startReadiness;report.arm_readiness=armReadiness;
  await writeFile(new URL('report.json',root),JSON.stringify(report,null,2));console.log(JSON.stringify({report:root.pathname,error,reason,summary:report.summary},null,2));
}
