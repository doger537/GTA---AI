// Human drives; this script only records synchronized observations, never input.
import {mkdir,writeFile,open} from 'node:fs/promises';import{fileURLToPath}from'node:url';
import {connect,frameAge} from '../../../packages/protocols/bridge-client.mjs';import {playRecordingSound} from '../../../packages/protocols/recording-sounds.mjs';
import {waitRecordingFocus,recordingReadiness} from '../../../packages/protocols/recording-readiness.mjs';
import {validateObservation,observationGeometry} from '../../../packages/protocols/observation-stream.mjs';
const arg=(key,fallback)=>process.argv.find(a=>a.startsWith('--'+key+'='))?.split('=')[1]??fallback;
const seconds=Number(arg('seconds',120)),fps=Number(arg('fps',8)),camera=arg('camera','rear'),role=arg('role','development'),waitSeconds=Number(arg('wait',60));
if(!Number.isFinite(seconds)||seconds<1||seconds>600||!Number.isFinite(fps)||fps<1||fps>15||!Number.isFinite(waitSeconds)||waitSeconds<1||waitSeconds>900||!['rear','hood'].includes(camera)||!['development','validation'].includes(role))throw Error('Use seconds=1..600, wait=1..900, fps=1..15, camera=rear|hood, role=development|validation');
const id=new Date().toISOString().replaceAll(':','-'),root=new URL(`../../../experiments/observation-recordings/${id}/`,import.meta.url),client=await connect();
let log,count=0,error=null,cancelled=false,geometry=null,generation=null,previous=null,focusPauses=0,captureFocusSkips=0,paused=false,stableSince=null;
process.on('SIGINT',()=>{cancelled=true;});
await mkdir(root,{recursive:true});
const session={id,version:1,role,camera_declared:camera,camera_verified:false,seconds,fps,game_input_sent:false,status:'waiting',source:'single_capture',annotations:'Unlabelled. Validation sessions are reserved for evaluation, never threshold/model selection.'};
await writeFile(new URL('session.json',root),JSON.stringify(session,null,2));
console.log(`Ожидаю активную GTA до ${waitSeconds} секунд. Води сам после сигнала; программа только записывает.`);
try{
  const wait=performance.now();let status,waitingGeneration=null;
  while(!cancelled){status=await client.status();waitingGeneration??=status.generation;if(recordingReadiness(status,waitingGeneration))break;if(performance.now()-wait>waitSeconds*1000)throw Error('GTA not focused/found');await new Promise(r=>setTimeout(r,200));}
  if(cancelled)throw Error('Cancelled');generation=status.generation;log=await open(new URL('samples.jsonl',root),'wx');await playRecordingSound('start');
  await waitRecordingFocus(client,generation,{cancelled:()=>cancelled,timeoutMs:waitSeconds*1000});console.log('GTA focus stable; recording started.');const start=performance.now();
  while(!cancelled&&performance.now()-start<seconds*1000){
    const tick=performance.now(),s=await client.status();
    if(!recordingReadiness(s,generation)){if(!paused){focusPauses++;paused=true;}stableSince=null;await new Promise(r=>setTimeout(r,100));continue;}
    if(paused){stableSince??=performance.now();if(performance.now()-stableSince<400){await new Promise(r=>setTimeout(r,100));continue;}paused=false;}
    let observation;
    try{observation=await client.observation();}catch(e){
      // A focus change can race the status check. Recheck stop generation before
      // pausing; malformed packets and other errors are never silently ignored.
      if(/HTTP 409:.*GTA must be in foreground/.test(e.message)){const after=await client.status();if(!recordingReadiness(after,generation)){captureFocusSkips++;if(!paused)focusPauses++;paused=true;stableSince=null;continue;}}
      throw e;
    }
    validateObservation(observation,{generation});const shape=observationGeometry(observation);
    if(observation.generation!==generation)throw Error('Capture generation changed');if(geometry&&geometry!==shape)throw Error('Window/HUD geometry changed');geometry=shape;
    if(previous&&(observation.sequence<=previous.sequence||observation.capture_start_ms<=previous.time))throw Error('Non-increasing capture timeline');
    if(frameAge(observation)>450)throw Error('Observation already stale at recording');
    const base=String(count).padStart(6,'0');await Promise.all([writeFile(new URL(base+'.jpg',root),observation.road.bytes),writeFile(new URL(base+'-hud.png',root),observation.hud.bytes),writeFile(new URL(base+'-map.png',root),observation.minimap.bytes)]);
    await log.write(JSON.stringify({file:base+'.jpg',hud_file:base+'-hud.png',minimap_file:base+'-map.png',sequence:observation.sequence,capture_start_ms:observation.capture_start_ms,capture_end_ms:observation.capture_end_ms,age_ms:frameAge(observation),capture_skew_ms:0,generation,hud_geometry:observation.hud.hud,minimap_region:observation.minimap.region})+'\n');count++;previous={sequence:observation.sequence,time:observation.capture_start_ms};
    if(count%80===0)console.log(JSON.stringify({elapsed_s:Math.round((performance.now()-start)/1000),frames:count,focus_pauses:focusPauses}));
    await new Promise(r=>setTimeout(r,Math.max(1,1000/fps-(performance.now()-tick))));
  }
}catch(e){error=e.message;process.exitCode=1;}
finally{client.close();if(log)await log.close();await playRecordingSound(error||cancelled?'interrupted':'complete');await writeFile(new URL('session.json',root),JSON.stringify({...session,status:error?'error':cancelled?'cancelled':'complete',frames:count,error,focus_pauses:focusPauses,capture_focus_skips:captureFocusSkips,focus_policy:'Pause passive capture while unfocused; stop generation always aborts. Never capture other apps.',observation_geometry:geometry?JSON.parse(geometry):null,hud_geometry:geometry?JSON.parse(geometry).hud:null},null,2));}
console.log(JSON.stringify({folder:fileURLToPath(root),frames:count,error,role,game_input_sent:false}));
