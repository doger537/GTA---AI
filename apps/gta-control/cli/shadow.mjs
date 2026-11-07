import {mkdir,writeFile} from 'node:fs/promises';
import {connect,frameAge} from '../../../packages/protocols/bridge-client.mjs';
import {ObservationStream} from '../../../packages/protocols/observation-stream.mjs';
import {ObservationAnalyzer,observationContext} from '../../../packages/perception/observation-analysis.mjs';
import {DriveSafetyGate} from '../../../packages/control/drive-safety-gate.mjs';
import {Perception} from '../../../packages/perception/perception.mjs';
import {Controller} from '../../../packages/control/controller.mjs';
const seconds=Number(process.argv[2]??10);
if(!Number.isFinite(seconds)||seconds<1||seconds>120)throw Error('Duration must be 1..120 seconds');
const client=await connect(),stream=new ObservationStream(client),analyzer=new ObservationAnalyzer(),gate=new DriveSafetyGate(),model=await Perception.load(),controller=new Controller();
const destination=new URL('../../../experiments/runs/',import.meta.url);await mkdir(destination,{recursive:true});
const records=[],started=performance.now();
// This process intentionally has NO calls to action(), step(), or input endpoints.
try{
  while(performance.now()-started<seconds*1000){
    const o=await stream.read(),frame=o.road,{vision:p,state}=await analyzer.analyze(o,model),age=frameAge(frame);
    const safety=gate.observe(observationContext(o,state,stream.status)),command=controller.update({time_ms:o.capture_start_ms,frame_age_ms:age,camera_calibrated:false,speed_valid:state.speed.valid,speed_mps:state.speed.kmh/3.6,road_confidence:p.confidence,paths:[],obstacles:[]});
    records.push({sequence:o.sequence,generation:o.generation,capture_start_ms:o.capture_start_ms,capture_end_ms:o.capture_end_ms,source:'single_capture',state,frame_age_ms:age,inference_ms:p.inference_ms,road_confidence:p.confidence,road_fraction:p.road_fraction,vehicles:p.vehicles.length,command,safety});
    await writeFile(new URL('latest.jpg',destination),await model.overlay(frame.bytes,p));
    await new Promise(r=>setTimeout(r,20));
  }
}finally{client.close();await analyzer.close();await Promise.all([model.session.release(),model.semantic?.session.release()]);await writeFile(new URL('latest.json',destination),JSON.stringify({mode:'shadow_only',actuation:false,samples:records},null,2));}
console.log(JSON.stringify({frames:records.length,mean_inference_ms:Math.round(records.reduce((a,r)=>a+r.inference_ms,0)/Math.max(1,records.length)),actuation:false}));
