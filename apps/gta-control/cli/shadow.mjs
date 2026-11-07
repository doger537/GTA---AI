import {mkdir,writeFile} from 'node:fs/promises';
import {connect} from '../../../packages/protocols/bridge-client.mjs';
import {Perception} from '../../../packages/perception/perception.mjs';
import {Controller,shadowSensors} from '../../../packages/control/controller.mjs';
const seconds=Number(process.argv[2]??10);
if(!Number.isFinite(seconds)||seconds<1||seconds>120)throw Error('Duration must be 1..120 seconds');
const client=await connect(),model=await Perception.load(),controller=new Controller();
const destination=new URL('../../../experiments/runs/',import.meta.url);await mkdir(destination,{recursive:true});
const records=[],started=performance.now();
// This process intentionally has NO calls to action(), step(), or input endpoints.
try{
  while(performance.now()-started<seconds*1000){
    const frame=await client.frame(),p=await model.analyze(frame.bytes);
    const command=controller.update(shadowSensors(p,frame));
    records.push({sequence:frame.sequence,frame_age_ms:frame.frame_age_ms,inference_ms:p.inference_ms,road_confidence:p.confidence,road_fraction:p.road_fraction,vehicles:p.vehicles.length,command});
    await writeFile(new URL('latest.jpg',destination),await model.overlay(frame.bytes,p));
    await new Promise(r=>setTimeout(r,20));
  }
}finally{client.close();await writeFile(new URL('latest.json',destination),JSON.stringify({mode:'shadow_only',actuation:false,samples:records},null,2));}
console.log(JSON.stringify({frames:records.length,mean_inference_ms:Math.round(records.reduce((a,r)=>a+r.inference_ms,0)/Math.max(1,records.length)),actuation:false}));
