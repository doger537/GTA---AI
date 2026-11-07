import * as tf from '@tensorflow/tfjs';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {INPUT} from './bc-data.mjs';
export function createModel(seed=42){
  const model=tf.sequential();
  const init=n=>tf.initializers.glorotUniform({seed:seed+n});
  model.add(tf.layers.conv2d({inputShape:[INPUT.height,INPUT.width,INPUT.channels],filters:8,kernelSize:5,strides:4,padding:'same',activation:'relu',kernelInitializer:init(1)}));
  model.add(tf.layers.conv2d({filters:12,kernelSize:3,strides:2,padding:'same',activation:'relu',kernelInitializer:init(2)}));
  model.add(tf.layers.flatten());
  model.add(tf.layers.dense({units:32,activation:'relu',kernelInitializer:init(3)}));
  model.add(tf.layers.dense({units:6,activation:'sigmoid',kernelInitializer:init(4)}));
  return model;
}
export async function saveModel(model,root){
  await mkdir(root,{recursive:true});
  await model.save({save:async artifacts=>{
    const weightData=Array.isArray(artifacts.weightData)?Buffer.concat(artifacts.weightData.map(b=>Buffer.from(b))):Buffer.from(artifacts.weightData);
    await writeFile(path.join(root,'weights.bin'),weightData);
    await writeFile(path.join(root,'model.json'),JSON.stringify({format:'layers-model',generatedBy:'GTA behavioral-cloning experiment',modelTopology:artifacts.modelTopology,weightsManifest:[{paths:['weights.bin'],weights:artifacts.weightSpecs}]},null,2));
    return {modelArtifactsInfo:{dateSaved:new Date(),modelTopologyType:'JSON',weightDataBytes:weightData.length}};
  }},{includeOptimizer:false});
}
export async function loadModel(root){
  const json=JSON.parse(await readFile(path.join(root,'model.json'),'utf8'));
  const buffer=await readFile(path.join(root,'weights.bin'));
  return tf.loadLayersModel(tf.io.fromMemory({modelTopology:json.modelTopology,weightSpecs:json.weightsManifest[0].weights,weightData:buffer.buffer.slice(buffer.byteOffset,buffer.byteOffset+buffer.byteLength)}));
}
