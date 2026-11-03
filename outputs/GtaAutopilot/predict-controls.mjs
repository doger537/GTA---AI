// Saved-frame inspection only. No GTA bridge or key injection.
import * as tf from '@tensorflow/tfjs';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {controlVision} from './control-vision.mjs';
import {loadModel} from './bc-model.mjs';
import {decodeControls,CONTROL_HEADS} from './control-model.mjs';
import {initializeBackend} from './bc-runtime.mjs';
const root=path.resolve(process.argv[2]??''),data=path.resolve(process.argv[3]??'');
const index=Number(process.argv.find(a=>a.startsWith('--index='))?.split('=')[1]??0);
const config=JSON.parse(await readFile(path.join(root,'config.json'),'utf8'));
const {input:INPUT,cache:imageCache,pack:packHistory}=controlVision(config.vision??'rgb-v1');
if(config.architecture!=='categorical-controls-v1'||JSON.stringify(config.input)!==JSON.stringify(INPUT))throw Error('Unsupported control model');
const rows=(await readFile(path.join(data,'examples.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
if(!Number.isInteger(index)||index<0||index>=rows.length)throw Error('Invalid example index');
const e=rows[index],cache=await imageCache(data,[e]);await initializeBackend();const model=await loadModel(root);
const x=tf.tensor4d(packHistory(e.frames.map(f=>cache.get(f))),[1,INPUT.height,INPUT.width,INPUT.channels]);
try{
  const outputs=model.predict(x),groups=await Promise.all(outputs.map(async t=>Array.from(await t.data())));outputs.forEach(t=>t.dispose());
  const bits=decodeControls(groups),heads=Object.entries(CONTROL_HEADS);
  console.log(JSON.stringify({mode:'offline_only',example:index,truth:e.keys,keys:config.target_keys.filter((_,i)=>bits[i]),choices:Object.fromEntries(heads.map(([name,classes],i)=>[name,classes[groups[i].indexOf(Math.max(...groups[i]))]])),scores:Object.fromEntries(heads.map(([name,classes],i)=>[name,Object.fromEntries(classes.map((c,j)=>[c,groups[i][j]]))])),driving_enabled:false},null,2));
}finally{x.dispose();model.dispose();}
