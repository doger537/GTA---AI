// Offline predictions only. This module has no GTA connection or actuator.
import * as tf from '@tensorflow/tfjs';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {INPUT,imageCache,packHistory} from './bc-data.mjs';
import {loadModel} from './bc-model.mjs';
import {initializeBackend} from './bc-runtime.mjs';
const root=path.resolve(process.argv[2]??''),dataset=path.resolve(process.argv[3]??'');
const index=Number(process.argv.find(x=>x.startsWith('--index='))?.split('=')[1]??0);
const config=JSON.parse(await readFile(path.join(root,'config.json'),'utf8'));
if(config.architecture==='categorical-controls-v1')throw Error('Use predict-controls.mjs for the categorical control model');
if(JSON.stringify(config.input)!==JSON.stringify(INPUT))throw Error('Unsupported model input');
const rows=(await readFile(path.join(dataset,'examples.jsonl'),'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
if(!Number.isInteger(index)||index<0||index>=rows.length)throw Error('Invalid example index');
const e=rows[index],cache=await imageCache(dataset,[e]);await initializeBackend();
const model=await loadModel(root),x=tf.tensor4d(packHistory(e.frames.map(f=>cache.get(f))),[1,INPUT.height,INPUT.width,INPUT.channels]);
const p=model.predict(x),values=Array.from(await p.data());
let calibration=null;
if(process.argv.includes('--calibrated')){
  calibration=JSON.parse(await readFile(path.join(root,'calibration.json'),'utf8'));
  if(calibration.training_source_session!==config.source_session||config.target_keys.some(k=>!Number.isFinite(calibration.thresholds[k])))throw Error('Incompatible calibration');
}
console.log(JSON.stringify({mode:'offline_only',example:index,time_ms:e.time_ms,truth:e.keys,probabilities:Object.fromEntries(config.target_keys.map((k,i)=>[k,Number(values[i].toFixed(4))])),above_half:config.target_keys.filter((_,i)=>values[i]>=.5),...(calibration?{thresholds:calibration.thresholds,calibrated_keys:config.target_keys.filter((k,i)=>values[i]>=calibration.thresholds[k])}:{})},null,2));
p.dispose();x.dispose();model.dispose();
