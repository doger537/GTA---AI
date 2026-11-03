import * as tf from '@tensorflow/tfjs';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {INPUT,temporalSplit,separateSessionSplit,imageCache,packHistory,metrics} from './bc-data.mjs';
import {createModel,saveModel,loadModel} from './bc-model.mjs';
import {TARGET_KEYS} from './dataset.mjs';
import {initializeBackend} from './bc-runtime.mjs';
const dataset=path.resolve(process.argv[2]??''),epochs=Number(process.argv.find(x=>x.startsWith('--epochs='))?.split('=')[1]??3);
if(!Number.isInteger(epochs)||epochs<1||epochs>100)throw Error('epochs must be 1..100');
const meta=JSON.parse(await readFile(path.join(dataset,'dataset.json'),'utf8'));
if(JSON.stringify(meta.target_keys)!==JSON.stringify(TARGET_KEYS)||meta.history!==4)throw Error('Incompatible dataset schema');
let examples=(await readFile(path.join(dataset,'examples.jsonl'),'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
const smoke=process.argv.includes('--smoke');
if(smoke&&examples.length>80)examples=Array.from({length:80},(_,i)=>examples[Math.floor((examples.length-1)*i/79)]);
if(examples.some(e=>e.source_session!==meta.source_session||e.frames.length!==4||e.targets.length!==6||e.targets.some(y=>y!==0&&y!==1)))throw Error('Invalid training samples');
const validationArgument=process.argv.find(x=>x.startsWith('--validation-dataset='))?.slice('--validation-dataset='.length);
const validationDataset=validationArgument?path.resolve(validationArgument):dataset;
const validationMeta=validationArgument?JSON.parse(await readFile(path.join(validationDataset,'dataset.json'),'utf8')):meta;
let validationExamples=validationArgument?(await readFile(path.join(validationDataset,'examples.jsonl'),'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse):null;
if(validationExamples&&(JSON.stringify(validationMeta.target_keys)!==JSON.stringify(TARGET_KEYS)||validationMeta.history!==4||validationExamples.some(e=>e.frames.length!==4||e.targets.length!==6||e.targets.some(y=>y!==0&&y!==1))))throw Error('Incompatible validation examples');
if(smoke&&validationExamples?.length>80)validationExamples=Array.from({length:80},(_,i)=>validationExamples[Math.floor((validationExamples.length-1)*i/79)]);
const split=validationArgument?separateSessionSplit(examples,validationExamples,meta.source_session,validationMeta.source_session):temporalSplit(examples);
const splitMethod=validationArgument?'separate recording sessions; development evaluation':'same-session chronological diagnostic holdout';
// Shuffle only the training side, deterministically; validation remains a
// chronological holdout and never shares source images with training.
let rng=42;for(let i=split.train.length-1;i>0;i--){rng=(Math.imul(rng,1664525)+1013904223)>>>0;const j=Math.floor(rng/4294967296*(i+1));[split.train[i],split.train[j]]=[split.train[j],split.train[i]];}
const run=new Date().toISOString().replace(/[:.]/g,'-'),out=fileURLToPath(new URL(`./trained/${run}/`,import.meta.url));await mkdir(out,{recursive:true});
await writeFile(path.join(out,'config.json'),JSON.stringify({version:1,input:INPUT,normalization:'RGB / 127.5 - 1',channel_order:'oldest RGB to newest RGB',target_keys:TARGET_KEYS,source_dataset:dataset,source_session:meta.source_session,validation_dataset:validationArgument?validationDataset:null,validation_session:validationMeta.source_session,split_method:validationArgument?'separate_recordings':'temporal',seed:42,smoke_test_only:smoke,driving_enabled:false},null,2));
await initializeBackend();
console.log(JSON.stringify({phase:'loading',run,train:split.train.length,validation:split.validation.length,backend:tf.getBackend()}));
function tensors(rows,cache){
  const values=new Float32Array(rows.length*INPUT.height*INPUT.width*INPUT.channels),stride=INPUT.height*INPUT.width*INPUT.channels;
  rows.forEach((e,i)=>values.set(packHistory(e.frames.map(f=>cache.get(f))),i*stride));
  return {x:tf.tensor4d(values,[rows.length,INPUT.height,INPUT.width,INPUT.channels]),y:tf.tensor2d(rows.map(e=>e.targets))};
}
const trainCache=await imageCache(dataset,split.train),validationCache=await imageCache(validationDataset,split.validation);
const train=tensors(split.train,trainCache),validation=tensors(split.validation,validationCache);trainCache.clear();validationCache.clear();
const positives=TARGET_KEYS.map((_,k)=>split.train.reduce((s,e)=>s+e.targets[k],0));
const positiveWeights=positives.map(n=>n?Math.max(1,Math.min(40,(split.train.length-n)/n)):1),weights=tf.tensor1d(positiveWeights);
const model=createModel();
model.compile({optimizer:tf.train.adam(.001),loss:(y,p)=>tf.tidy(()=>{
  const q=p.clipByValue(1e-6,1-1e-6),one=tf.scalar(1);
  return y.mul(q.log()).mul(weights).add(one.sub(y).mul(one.sub(q).log())).neg().mean(-1);
})});
const history=[],start=performance.now();
try{
  await model.fit(train.x,train.y,{epochs,batchSize:16,shuffle:false,validationData:[validation.x,validation.y],callbacks:{onBatchEnd:async(batch,logs)=>{if(batch%10===0)console.log(JSON.stringify({phase:'batch',batch,loss:logs.loss,elapsed_s:(performance.now()-start)/1000}));},onEpochEnd:async(epoch,logs)=>{
    const record={epoch:epoch+1,loss:logs.loss,val_loss:logs.val_loss,elapsed_s:(performance.now()-start)/1000};history.push(record);
    if(!Number.isFinite(logs.loss)||!Number.isFinite(logs.val_loss))throw Error('Non-finite training loss');
    console.log(JSON.stringify(record));await saveModel(model,out);
    await writeFile(path.join(out,'progress.json'),JSON.stringify(history,null,2));
  }}});
  const prediction=model.predict(validation.x),probabilities=await prediction.array();prediction.dispose();
  const majority=positives.map(n=>Number(n>split.train.length/2));
  const report={run,source_dataset:dataset,source_session:meta.source_session,label_quality:meta.label_quality,model:'small temporal CNN, four RGB frames stacked in channels',parameters:model.countParams(),input:INPUT,target_keys:TARGET_KEYS,backend:tf.getBackend(),epochs,train_samples:split.train.length,validation_samples:split.validation.length,split:{method:'same-session chronological diagnostic holdout',cutoff_ms:split.cutoff_ms,gap_ms:split.gap_ms,omitted:split.omitted,shared_images:0},positive_train_counts:positives,positive_weights:positiveWeights,history,training_s:(performance.now()-start)/1000,validation:metrics(split.validation.map(e=>e.targets),probabilities,TARGET_KEYS),majority_baseline:metrics(split.validation.map(e=>e.targets),split.validation.map(()=>majority),TARGET_KEYS),driving_enabled:false,limitations:['Same-session validation is not independent driving evaluation','Legacy snapshot labels can miss short key presses','Downsampled image loses small obstacles','No GPS, calibrated speed, stopping distance, or validated collision avoidance','S means brake or reverse depending on game state']};
  const loaded=await loadModel(out),probe=validation.x.slice([0,0,0,0],[1,INPUT.height,INPUT.width,INPUT.channels]);
  const a=model.predict(probe),b=loaded.predict(probe),aa=await a.data(),bb=await b.data();
  report.reload_max_error=Math.max(...aa.map((v,i)=>Math.abs(v-bb[i])));if(report.reload_max_error>1e-6)throw Error('Reloaded predictions differ');
  a.dispose();b.dispose();probe.dispose();loaded.dispose();
  const timings=[];const warm=validation.x.slice([0,0,0,0],[1,INPUT.height,INPUT.width,INPUT.channels]);
  for(let i=0;i<12;i++){const t=performance.now(),p=model.predict(warm);await p.data();p.dispose();if(i>1)timings.push(performance.now()-t);}warm.dispose();
  report.inference_ms={mean:timings.reduce((s,x)=>s+x,0)/timings.length,max:Math.max(...timings),scope:'Model only; excludes capture and preprocessing'};
  report.split.method=splitMethod;report.validation_source_session=validationMeta.source_session;report.validation_label_quality=validationMeta.label_quality;report.smoke_test_only=smoke;
  if(validationArgument)report.limitations[0]='Separate-session development check; old session was already inspected in previous experiments. A fresh third session is required for final evaluation.';
  await writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));
  await writeFile(path.join(out,'validation-predictions.jsonl'),split.validation.map((e,i)=>JSON.stringify({time_ms:e.time_ms,truth:e.targets,probabilities:probabilities[i]})).join('\n')+'\n');
  console.log(JSON.stringify({phase:'done',output:out,validation:report.validation,baseline:report.majority_baseline,inference_ms:report.inference_ms}));
}finally{train.x.dispose();train.y.dispose();validation.x.dispose();validation.y.dispose();weights.dispose();model.dispose();}
