import * as tf from '@tensorflow/tfjs';
import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {metrics} from './bc-data.mjs';
import {controlVision} from './control-vision.mjs';
import {loadModel} from './bc-model.mjs';
import {decodeControls,encodeControls} from './control-model.mjs';
import {initializeBackend} from './bc-runtime.mjs';
const root=path.resolve(process.argv[2]??''),config=JSON.parse(await readFile(path.join(root,'config.json'),'utf8'));
const {input:INPUT,cache:imageCache,pack:packHistory}=controlVision(config.vision??'rgb-v1');
if(config.architecture!=='categorical-controls-v1'||JSON.stringify(config.input)!==JSON.stringify(INPUT))throw Error('Unsupported model');
const data=process.argv[3]?path.resolve(process.argv[3]):config.validation_dataset;
const meta=JSON.parse(await readFile(path.join(data,'dataset.json'),'utf8'));
if(JSON.stringify(meta.target_keys)!==JSON.stringify(config.target_keys)||meta.history!==4)throw Error('Incompatible dataset');
const rows=(await readFile(path.join(data,'examples.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
if(!rows.length||rows.some(r=>r.source_session!==meta.source_session))throw Error('Invalid evaluation session');rows.forEach(r=>encodeControls(r.targets));
const train=(await readFile(path.join(config.source_dataset,'examples.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
const majority=config.target_keys.map((_,k)=>Number(train.reduce((s,r)=>s+r.targets[k],0)>train.length/2));
const cache=await imageCache(data,rows);await initializeBackend();const model=await loadModel(root),predictions=[],times=[];
try{
  for(const e of rows){
    const x=tf.tensor4d(packHistory(e.frames.map(f=>cache.get(f))),[1,INPUT.height,INPUT.width,INPUT.channels]),t=performance.now(),outputs=model.predict(x);
    const groups=await Promise.all(outputs.map(async p=>Array.from(await p.data())));predictions.push(decodeControls(groups));times.push(performance.now()-t);outputs.forEach(p=>p.dispose());x.dispose();
  }
  const report={architecture:config.architecture,training_session:config.source_session,evaluation_session:meta.source_session,scope:meta.source_session===config.source_session?'training-set evaluation':'separate-session offline evaluation; not proof of closed-loop driving',metrics:metrics(rows.map(r=>r.targets),predictions,config.target_keys),majority_baseline:metrics(rows.map(r=>r.targets),rows.map(()=>majority),config.target_keys),conflicts:predictions.filter(p=>(p[0]&&p[2])||(p[1]&&p[3])).length,inference_ms:{mean:times.slice(2).reduce((s,t)=>s+t,0)/Math.max(1,times.length-2),scope:'model plus decoding only'},driving_enabled:false};
  await writeFile(path.join(root,`controls-evaluation-${meta.source_session.replace(/[^0-9TZ-]/g,'_')}.json`),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}finally{model.dispose();}
