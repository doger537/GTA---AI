// Threshold fitting uses training labels only. Evaluation labels are read only
// after all thresholds have been fixed. No game inputs are sent.
import * as tf from '@tensorflow/tfjs';
import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {INPUT,imageCache,packHistory,metrics} from './bc-data.mjs';
import {loadModel} from './bc-model.mjs';
import {initializeBackend} from './bc-runtime.mjs';
const root=path.resolve(process.argv[2]??''),config=JSON.parse(await readFile(path.join(root,'config.json'),'utf8'));
if(config.split_method!=='separate_recordings')throw Error('This calibration requires separate-session training');
const train=(await readFile(path.join(config.source_dataset,'examples.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
const cache=await imageCache(config.source_dataset,train);await initializeBackend();const model=await loadModel(root),probs=[];
try{
  for(const e of train){const x=tf.tensor4d(packHistory(e.frames.map(f=>cache.get(f))),[1,INPUT.height,INPUT.width,INPUT.channels]),p=model.predict(x);probs.push(Array.from(await p.data()));x.dispose();p.dispose();}
}finally{model.dispose();cache.clear();}
const thresholds=config.target_keys.map((key,k)=>{
  if(!train.some(e=>e.targets[k]))return 1.001;
  let best=-1,chosen=.5;
  for(let n=1;n<=100;n++){
    const t=n/100;let tp=0,fp=0,fn=0;
    train.forEach((e,i)=>{const yes=probs[i][k]>=t;if(yes&&e.targets[k])tp++;else if(yes)fp++;else if(e.targets[k])fn++;});
    const score=2*tp/(2*tp+fp+fn);
    if(score>=best){best=score;chosen=t;}
  }
  return chosen;
});
const classify=rows=>rows.map(p=>p.map((v,k)=>Number(v>=thresholds[k])));
const trainingMetrics=metrics(train.map(e=>e.targets),classify(probs),config.target_keys);
// Threshold selection above never reads these validation labels.
const original=JSON.parse(await readFile(path.join(root,'report.json'),'utf8'));
const validation=(await readFile(path.join(root,'validation-predictions.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
if(validation.length!==original.validation_samples)throw Error('Incomplete saved validation predictions');
const bits=classify(validation.map(e=>e.probabilities));
const result={method:'per-key training F1, fixed grid 0.01..1.00; ties use highest threshold',training_source_session:config.source_session,validation_source_session:config.validation_session,thresholds:Object.fromEntries(config.target_keys.map((k,i)=>[k,thresholds[i]])),unsupported_training_keys:config.target_keys.filter((_,i)=>thresholds[i]>1),training:trainingMetrics,validation:metrics(validation.map(e=>e.truth),bits,config.target_keys),uncalibrated_validation:original.validation,majority_baseline:original.majority_baseline,contradictory_predictions:bits.filter(p=>(p[0]&&p[2])||(p[1]&&p[3])).length,driving_enabled:false,limitations:['Thresholds can overfit training data','Validation session already used during development','F1 optimisation does not directly optimise exact button-set match or driving quality']};
await writeFile(path.join(root,'calibration.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
