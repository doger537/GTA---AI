import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {connect} from '../GtaControl/bridge-client.mjs';
import {Perception} from './perception.mjs';
import {SpeedReader} from './speed-reader.mjs';
import {Controller} from './controller.mjs';

// End-to-end sensor integration, deliberately read-only until camera and braking
// calibration are available. There are no game-input calls in this program.
const seconds=Number(process.argv[2]??10);
if(!Number.isFinite(seconds)||seconds<1||seconds>120)throw Error('Duration: 1..120 seconds');
const config=JSON.parse(await readFile(new URL('./screen-config.json',import.meta.url),'utf8'));
const client=await connect(),vision=await Perception.load({cameraProfile:config.camera_profile??'unknown'}),speedReader=await SpeedReader.create(config.speed_roi),controller=new Controller();
const root=new URL('./runs/',import.meta.url);await mkdir(root,{recursive:true});
const records=[],start=performance.now();let lastSequence=-1;
try{
  while(performance.now()-start<seconds*1000){
    const loopStart=performance.now(),frame=await client.frame();
    if(frame.sequence===lastSequence){await new Promise(r=>setTimeout(r,20));continue;}
    lastSequence=frame.sequence;
    const [p,speed]=await Promise.all([vision.analyze(frame.bytes),speedReader.read(frame.bytes,performance.now())]);
    const age=frame.frame_age_ms+(performance.now()-loopStart);
    const sensors={time_ms:performance.now(),frame_age_ms:age,camera_calibrated:false,speed_valid:speed.valid,speed_mps:speed.speed_mps,road_confidence:p.confidence,paths:[],obstacles:[]};
    const command=controller.update(sensors);
    records.push({sequence:frame.sequence,cycle_ms:Math.round(performance.now()-loopStart),frame_age_ms:Math.round(age),speed,road_confidence:p.confidence,road_fraction:p.road_fraction,vehicles:p.vehicles,command});
    if(records.length%5===1)await writeFile(new URL('screen-latest.jpg',root),await vision.overlay(frame.bytes,p));
    await new Promise(r=>setTimeout(r,10));
  }
}finally{
  client.close();await speedReader.close();
  await writeFile(new URL('screen-latest.json',root),JSON.stringify({mode:'read_only',actuation:false,calibration_complete:false,samples:records},null,2));
}
console.log(JSON.stringify({samples:records.length,valid_speed_samples:records.filter(r=>r.speed.valid).length,mean_cycle_ms:Math.round(records.reduce((s,r)=>s+r.cycle_ms,0)/Math.max(records.length,1)),all_commands_stopped:records.every(r=>r.command.state==='STOP'),actuation:false}));
