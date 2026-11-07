// Re-evaluate an exported checkpoint without training or controlling GTA.
import * as tf from '@tensorflow/tfjs';
import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {INPUT,temporalSplit,imageCache,packHistory,metrics} from './bc-data.mjs';
import {loadModel} from './bc-model.mjs';
import {initializeBackend} from '../packages/control/bc-runtime.mjs';
import {TARGET_KEYS} from './dataset.mjs';
const root=path.resolve(process.argv[2]??''),config=JSON.parse(await readFile(path.join(root,'config.json'),'utf8'));
if(config.architecture==='categorical-controls-v1')throw Error('Use evaluate-controls.mjs for the categorical control model');
if(JSON.stringify(config.input)!==JSON.stringify(INPUT)||JSON.stringify(config.target_keys)!==JSON.stringify(TARGET_KEYS))throw Error('Incompatible checkpoint');
const override=process.argv.find(x=>x.startsWith('--dataset='))?.slice('--dataset='.length);
const dataset=override?path.resolve(override):(config.validation_dataset??config.source_dataset),meta=JSON.parse(await readFile(path.join(dataset,'dataset.json'),'utf8'));
if(JSON.stringify(meta.target_keys)!==JSON.stringify(TARGET_KEYS)||meta.history!==4)throw Error('Incompatible evaluation dataset');
const rows=(await readFile(path.join(dataset,'examples.jsonl'),'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
if(!rows.length||rows.some(e=>e.source_session!==meta.source_session))throw Error('Empty or mixed evaluation session');
const independent=meta.source_session!==config.source_session;
const sourceRows=independent?(await readFile(path.join(config.source_dataset,'examples.jsonl'),'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse):rows;
const originalSplit=config.split_method==='separate_recordings'?{train:sourceRows,validation:sourceRows,cutoff_ms:null,gap_ms:null,omitted:0}:temporalSplit(sourceRows);
const split=independent?{train:originalSplit.train,validation:rows,gap_ms:null,cutoff_ms:null,omitted:0}:originalSplit;
const history=JSON.parse(await readFile(path.join(root,'progress.json'),'utf8'));
await initializeBackend();const model=await loadModel(root),cache=await imageCache(dataset,split.validation);
const probabilities=[],timings=[];
try{
  for(let i=0;i<split.validation.length;i++){
    const e=split.validation[i],data=packHistory(e.frames.map(f=>cache.get(f))),x=tf.tensor4d(data,[1,INPUT.height,INPUT.width,INPUT.channels]);
    const t=performance.now(),p=model.predict(x);probabilities.push(Array.from(await p.data()));if(i>=2)timings.push(performance.now()-t);p.dispose();x.dispose();
  }
  const counts=TARGET_KEYS.map((_,k)=>split.train.reduce((s,e)=>s+e.targets[k],0)),baseline=counts.map(n=>Number(n>split.train.length/2));
  const report={source_session:meta.source_session,label_quality:meta.label_quality,epochs_completed:history.length,parameters:model.countParams(),input:INPUT,target_keys:TARGET_KEYS,backend:tf.getBackend(),history,train_samples:split.train.length,validation_samples:split.validation.length,split:{kind:'same-session chronological diagnostic holdout',cutoff_ms:split.cutoff_ms,gap_ms:split.gap_ms,omitted:split.omitted,shared_images:0},validation:metrics(split.validation.map(e=>e.targets),probabilities,TARGET_KEYS),majority_baseline:metrics(split.validation.map(e=>e.targets),split.validation.map(()=>baseline),TARGET_KEYS),inference_ms:{mean:timings.reduce((s,x)=>s+x,0)/timings.length,max:Math.max(...timings),scope:'single loaded checkpoint, model only; no image capture or preprocessing'},contradictory_predictions:probabilities.filter(p=>(p[0]>=.5&&p[2]>=.5)||(p[1]>=.5&&p[3]>=.5)).length,driving_enabled:false,limitations:['Same-session holdout is not independent driving evaluation','Legacy labels can miss short presses','Rare or absent actions cannot be validated','No GPS or validated obstacle avoidance']};
  report.training_source_session=config.source_session;report.evaluation_source_session=meta.source_session;
  if(independent){report.split.kind='separate recording session; entire prepared session evaluated';report.limitations[0]='Separate recorded session; offline button matching still does not validate closed-loop driving';}
  else if(config.split_method==='separate_recordings'){report.split.kind='training-set evaluation; all these examples were used for fitting';report.limitations[0]='This is training data, not a holdout';}
  const suffix=independent?`external-${meta.source_session.replace(/[^0-9TZ-]/g,'_')}`:'checkpoint-evaluation';
  await writeFile(path.join(root,`${suffix}.json`),JSON.stringify(report,null,2));
  await writeFile(path.join(root,independent?`${suffix}-predictions.jsonl`:'validation-predictions.jsonl'),split.validation.map((e,i)=>JSON.stringify({time_ms:e.time_ms,truth:e.targets,probabilities:probabilities[i]})).join('\n')+'\n');
  console.log(JSON.stringify(report,null,2));
}finally{model.dispose();}
