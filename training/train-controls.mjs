// Offline behavioral cloning with mutually exclusive steering/pedal classes.
import * as tf from '@tensorflow/tfjs';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {separateSessionSplit,metrics} from './bc-data.mjs';
import {controlVision} from '../packages/perception/control-vision.mjs';
import {createControlModel,encodeControls,decodeControls,classBalance,CONTROL_HEADS} from '../packages/control/control-model.mjs';
import {saveModel,loadModel} from './bc-model.mjs';
import {initializeBackend} from '../packages/control/bc-runtime.mjs';
import {TARGET_KEYS} from './dataset.mjs';
const trainingRoot=path.resolve(process.argv[2]??''),validationRoot=path.resolve(process.argv[3]??'');
const epochs=Number(process.argv.find(a=>a.startsWith('--epochs='))?.split('=')[1]??2);
const visionName=process.argv.find(a=>a.startsWith('--vision='))?.slice('--vision='.length)??'rgb-v1';
const {input:INPUT,cache:imageCache,pack:packHistory}=controlVision(visionName);
if(!Number.isInteger(epochs)||epochs<1||epochs>100)throw Error('epochs must be 1..100');
async function dataset(root){
  const meta=JSON.parse(await readFile(path.join(root,'dataset.json'),'utf8'));
  if(meta.history!==4||JSON.stringify(meta.target_keys)!==JSON.stringify(TARGET_KEYS))throw Error('Incompatible dataset');
  const rows=(await readFile(path.join(root,'examples.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
  rows.forEach(r=>encodeControls(r.targets));return {meta,rows};
}
const training=await dataset(trainingRoot),validation=await dataset(validationRoot);
const split=separateSessionSplit(training.rows,validation.rows,training.meta.source_session,validation.meta.source_session);
let rng=42;for(let i=split.train.length-1;i>0;i--){rng=(Math.imul(rng,1664525)+1013904223)>>>0;const j=Math.floor(rng/4294967296*(i+1));[split.train[i],split.train[j]]=[split.train[j],split.train[i]];}
const run=new Date().toISOString().replace(/[:.]/g,'-'),out=fileURLToPath(new URL(`./trained/${run}/`,import.meta.url));await mkdir(out,{recursive:true});
const config={version:2,architecture:'categorical-controls-v1',vision:visionName,input:INPUT,normalization:visionName==='rgb-v1'?'RGB / 127.5 - 1':'masked grayscale CLAHE; newest frame and three clipped differences',source_dataset:trainingRoot,source_session:training.meta.source_session,validation_dataset:validationRoot,validation_session:validation.meta.source_session,heads:CONTROL_HEADS,target_keys:TARGET_KEYS,decoder:'argmax_per_head; shift_disabled',driving_enabled:false};
await writeFile(path.join(out,'config.json'),JSON.stringify(config,null,2));await initializeBackend();
console.log(JSON.stringify({run,train:split.train.length,validation:split.validation.length,backend:tf.getBackend()}));
async function tensors(root,rows){
  const cache=await imageCache(root,rows),stride=INPUT.width*INPUT.height*INPUT.channels,values=new Float32Array(rows.length*stride);
  rows.forEach((r,i)=>values.set(packHistory(r.frames.map(f=>cache.get(f))),i*stride));cache.clear();
  const labels=rows.map(r=>encodeControls(r.targets));
  return {x:tf.tensor4d(values,[rows.length,INPUT.height,INPUT.width,INPUT.channels]),y:[3,3,2].map((n,k)=>tf.tensor2d(labels.map(a=>Array.from({length:n},(_,j)=>Number(j===a[k])))))};
}
const train=await tensors(trainingRoot,split.train),valid=await tensors(validationRoot,split.validation);
const labels=split.train.map(r=>encodeControls(r.targets)),balance=[3,3,2].map((n,k)=>classBalance(labels.map(y=>y[k]),n));
const weightTensors=balance.map(b=>tf.tensor1d(b.weights));
const losses=weightTensors.map(w=>(y,p)=>tf.tidy(()=>y.mul(p.clipByValue(1e-7,1).log()).mul(w).sum(-1).neg()));
const model=createControlModel(42,INPUT);model.compile({optimizer:tf.train.adam(.001),loss:losses});
const history=[],start=performance.now();
try{
  await model.fit(train.x,train.y,{epochs,batchSize:16,shuffle:false,validationData:[valid.x,valid.y],callbacks:{onBatchEnd:async(batch,logs)=>{if(batch%10===0)console.log(JSON.stringify({batch,loss:logs.loss,elapsed_s:(performance.now()-start)/1000}));},onEpochEnd:async(epoch,logs)=>{
    if(!Number.isFinite(logs.loss)||!Number.isFinite(logs.val_loss))throw Error('Non-finite loss');
    const row={epoch:epoch+1,loss:logs.loss,val_loss:logs.val_loss,elapsed_s:(performance.now()-start)/1000};history.push(row);console.log(JSON.stringify(row));
    await saveModel(model,out);await writeFile(path.join(out,'progress.json'),JSON.stringify(history,null,2));
  }}});
  const outputs=model.predict(valid.x),arrays=await Promise.all(outputs.map(p=>p.array()));outputs.forEach(p=>p.dispose());
  const predictions=split.validation.map((_,i)=>decodeControls(arrays.map(a=>a[i])));
  const counts=TARGET_KEYS.map((_,k)=>split.train.reduce((s,r)=>s+r.targets[k],0)),majority=counts.map(n=>Number(n>split.train.length/2));
  const loaded=await loadModel(out),probe=valid.x.slice([0,0,0,0],[1,INPUT.height,INPUT.width,INPUT.channels]);
  const a=model.predict(probe),b=loaded.predict(probe);let reloadError=0;
  for(let i=0;i<a.length;i++){const aa=await a[i].data(),bb=await b[i].data();reloadError=Math.max(reloadError,...aa.map((v,j)=>Math.abs(v-bb[j])));}a.forEach(p=>p.dispose());b.forEach(p=>p.dispose());loaded.dispose();
  if(reloadError>1e-6)throw Error('Checkpoint roundtrip mismatch');
  const timing=[];for(let i=0;i<12;i++){const t=performance.now(),p=model.predict(probe);await Promise.all(p.map(o=>o.data()));p.forEach(o=>o.dispose());if(i>1)timing.push(performance.now()-t);}probe.dispose();
  const report={...config,epochs,parameters:model.countParams(),training_s:(performance.now()-start)/1000,train_samples:split.train.length,validation_samples:split.validation.length,training_label_quality:training.meta.label_quality,validation_label_quality:validation.meta.label_quality,split:'separate recording sessions; development evaluation, not blind final test',class_balance:balance,history,validation:metrics(split.validation.map(r=>r.targets),predictions,TARGET_KEYS),majority_baseline:metrics(split.validation.map(r=>r.targets),split.validation.map(()=>majority),TARGET_KEYS),contradictory_predictions:predictions.filter(p=>(p[0]&&p[2])||(p[1]&&p[3])).length,reload_max_error:reloadError,inference_ms:{mean:timing.reduce((s,n)=>s+n,0)/timing.length,max:Math.max(...timing),scope:'model only'},limitations:['Validation session already inspected in previous experiments','S includes both braking and reverse','No route intent or calibrated speed','Offline matching does not establish closed-loop driving quality']};
  await writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));
  await writeFile(path.join(out,'validation-predictions.jsonl'),split.validation.map((r,i)=>JSON.stringify({time_ms:r.time_ms,truth:r.targets,predicted:predictions[i],groups:arrays.map(a=>a[i])})).join('\n')+'\n');
  console.log(JSON.stringify({phase:'done',out,metrics:report.validation,baseline:report.majority_baseline,contradictions:report.contradictory_predictions,inference:report.inference_ms}));
}finally{[train.x,...train.y,valid.x,...valid.y,...weightTensors].forEach(t=>t.dispose());model.dispose();}
