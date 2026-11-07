// Offline ONNX inference and evaluation. Does not import GTA Control.
import * as ort from 'onnxruntime-node';
import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {controlVision} from '../perception/control-vision.mjs';
import {decodeControls,encodeControls} from './control-model.mjs';
import {metrics} from '../../training/bc-data.mjs';
const root=path.resolve(process.argv[2]??''),config=JSON.parse(await readFile(path.join(root,'config.json'),'utf8'));
if(!['torch-categorical-controls-v1','pilotnet-categorical-v1'].includes(config.architecture))throw Error('Unsupported ONNX model');
const vision=controlVision(config.vision),spec=vision.input;
if(JSON.stringify(spec)!==JSON.stringify(config.input))throw Error('Input schema mismatch');
const verify=process.argv.includes('--verify'),data=verify?config.validation_dataset:path.resolve(process.argv[3]??'');
const meta=JSON.parse(await readFile(path.join(data,'dataset.json'),'utf8'));
if(config.camera_profile&&config.camera_profile!==(meta.camera_profile??'legacy_rear_unverified'))throw Error('Model and dataset camera profiles differ');
if(JSON.stringify(meta.target_keys)!==JSON.stringify(config.target_keys))throw Error('Target schema mismatch');
const rows=(await readFile(path.join(data,'examples.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
if(!rows.length||rows.some(r=>r.source_session!==meta.source_session))throw Error('Invalid source session');rows.forEach(r=>encodeControls(r.targets));
const index=Number(process.argv.find(a=>a.startsWith('--index='))?.split('=')[1]??0),all=process.argv.includes('--evaluate');
if(!Number.isInteger(index)||index<0||index>=rows.length)throw Error('Invalid example index');
const used=all?rows:[rows[verify?0:index]],cache=await vision.cache(data,used);
const session=await ort.InferenceSession.create(path.join(root,'model.onnx'),{executionProviders:['cpu'],intraOpNumThreads:2});
const predictions=[],groupsAll=[],timings=[];
try{
  for(const r of used){
    const raw=vision.pack(r.frames.map(f=>cache.get(f))),nchw=new Float32Array(raw.length),pixels=spec.width*spec.height;
    for(let p=0;p<pixels;p++)for(let c=0;c<spec.channels;c++)nchw[c*pixels+p]=raw[p*spec.channels+c];
    const tensor=new ort.Tensor('float32',nchw,[1,spec.channels,spec.height,spec.width]),t=performance.now();
    const out=await session.run({frames:tensor});timings.push(performance.now()-t);
    const groups=['steering','pedals','handbrake'].map(n=>Array.from(out[n].data));groupsAll.push(groups);predictions.push(decodeControls(groups));
  }
  if(verify){
    const reference=JSON.parse(await readFile(path.join(root,'onnx-reference.json'),'utf8'));
    const maxError=Math.max(...reference.groups.flatMap((g,k)=>g.map((v,j)=>Math.abs(v-groupsAll[0][k][j]))));
    const result={onnx_cpu_verified:maxError<1e-4,max_error:maxError,profile:config.vision,example:0};
    await writeFile(path.join(root,'onnx-verification.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));if(!result.onnx_cpu_verified)throw Error('PyTorch / ONNX mismatch');
  }else if(all){
    const training=(await readFile(path.join(config.source_dataset,'examples.jsonl'),'utf8')).trim().split('\n').map(JSON.parse),majority=config.target_keys.map((_,k)=>Number(training.reduce((s,r)=>s+r.targets[k],0)>training.length/2));
    const warm=timings.length>2?timings.slice(2):timings;
    const report={architecture:config.architecture,vision:config.vision,exposure_augmentation:config.exposure_augmentation,training_session:config.source_session,evaluation_session:meta.source_session,scope:meta.source_session===config.source_session?'training-set evaluation':'separate-session offline evaluation; not closed-loop driving',metrics:metrics(used.map(r=>r.targets),predictions,config.target_keys),majority_baseline:metrics(used.map(r=>r.targets),used.map(()=>majority),config.target_keys),conflicts:predictions.filter(p=>(p[0]&&p[2])||(p[1]&&p[3])).length,inference_ms:{mean:warm.reduce((s,t)=>s+t,0)/warm.length,max:Math.max(...warm),scope:'ONNX model only; excludes capture and preprocessing'},driving_enabled:false};
    await writeFile(path.join(root,`onnx-evaluation-${meta.source_session.replace(/[^0-9TZ-]/g,'_')}.json`),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
  }else console.log(JSON.stringify({mode:'offline_only',index,truth:used[0].keys,predicted:config.target_keys.filter((_,k)=>predictions[0][k]),groups:groupsAll[0]},null,2));
}finally{await session.release();}
