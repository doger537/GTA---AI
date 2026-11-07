import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {connect,frameAge} from '../../../packages/protocols/bridge-client.mjs';
import {ObservationStream} from '../../../packages/protocols/observation-stream.mjs';
import {ObservationAnalyzer,observationContext} from '../../../packages/perception/observation-analysis.mjs';
import {DriveSafetyGate} from '../../../packages/control/drive-safety-gate.mjs';
import {Perception} from '../../../packages/perception/perception.mjs';
import {Controller} from '../../../packages/control/controller.mjs';

// End-to-end sensor integration, deliberately read-only until camera and braking
// calibration are available. There are no game-input calls in this program.
const seconds=Number(process.argv[2]??10);
if(!Number.isFinite(seconds)||seconds<1||seconds>120)throw Error('Duration: 1..120 seconds');
const config=JSON.parse(await readFile(new URL('../../../configs/screen-config.json',import.meta.url),'utf8'));
const client=await connect(),stream=new ObservationStream(client),analyzer=new ObservationAnalyzer(),gate=new DriveSafetyGate(),vision=await Perception.load({cameraProfile:config.camera_profile??'unknown'}),controller=new Controller();
const root=new URL('../../../experiments/runs/',import.meta.url);await mkdir(root,{recursive:true});
const records=[],start=performance.now();let lastSequence=-1;
try{
  while(performance.now()-start<seconds*1000){
    const loopStart=performance.now(),o=await stream.read(),frame=o.road;
    lastSequence=frame.sequence;
    const {vision:p,state}=await analyzer.analyze(o,vision),speed=state.speed;
    const age=frameAge(frame),safety=gate.observe(observationContext(o,state,stream.status,{vehicle_id:config.vehicle_id,camera_profile:config.camera_profile}));
    const sensors={time_ms:o.capture_start_ms,frame_age_ms:age,camera_calibrated:false,speed_valid:speed.valid,speed_mps:speed.kmh/3.6,road_confidence:p.confidence,paths:[],obstacles:[]};
    const command=controller.update(sensors);
    records.push({sequence:o.sequence,generation:o.generation,capture_start_ms:o.capture_start_ms,capture_end_ms:o.capture_end_ms,source:'single_capture',cycle_ms:Math.round(performance.now()-loopStart),frame_age_ms:Math.round(age),state,speed,road_confidence:p.confidence,road_fraction:p.road_fraction,vehicles:p.vehicles,command,safety});
    if(records.length%5===1)await writeFile(new URL('screen-latest.jpg',root),await vision.overlay(frame.bytes,p));
    await new Promise(r=>setTimeout(r,10));
  }
}finally{
  client.close();await analyzer.close();await Promise.all([vision.session.release(),vision.semantic?.session.release()]);
  await writeFile(new URL('screen-latest.json',root),JSON.stringify({mode:'read_only',actuation:false,calibration_complete:false,samples:records},null,2));
}
console.log(JSON.stringify({samples:records.length,valid_speed_samples:records.filter(r=>r.speed.valid).length,mean_cycle_ms:Math.round(records.reduce((s,r)=>s+r.cycle_ms,0)/Math.max(records.length,1)),all_commands_stopped:records.every(r=>r.command.state==='STOP'),actuation:false}));
