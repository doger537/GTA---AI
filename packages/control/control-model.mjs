import * as tf from '@tensorflow/tfjs';
import {INPUT} from '../../training/bc-data.mjs';
export const CONTROL_HEADS={steering:['straight','left','right'],pedals:['coast','accelerate','brake_or_reverse'],handbrake:['released','held']};
export function encodeControls(y){
  if(y.length!==6||y.some(v=>v!==0&&v!==1)||(y[0]&&y[2])||(y[1]&&y[3])||y[5])throw Error('Unsupported or conflicting control label');
  return [y[1]?1:y[3]?2:0,y[0]?1:y[2]?2:0,y[4]?1:0];
}
export function decodeControls(groups){
  if(groups.length!==3||groups.some((p,i)=>p.length!==[3,3,2][i]||p.some(v=>!Number.isFinite(v)||v<0||v>1)))throw Error('Invalid categorical predictions');
  const [steer,pedal,hand]=groups.map(p=>p.indexOf(Math.max(...p)));
  return [Number(pedal===1),Number(steer===1),Number(pedal===2),Number(steer===2),Number(hand===1),0];
}
export function createControlModel(seed=42,inputSpec=INPUT){
  const input=tf.input({shape:[inputSpec.height,inputSpec.width,inputSpec.channels]});
  const init=n=>tf.initializers.glorotUniform({seed:seed+n});
  let x=tf.layers.conv2d({filters:8,kernelSize:5,strides:4,padding:'same',activation:'relu',kernelInitializer:init(1)}).apply(input);
  x=tf.layers.conv2d({filters:12,kernelSize:3,strides:2,padding:'same',activation:'relu',kernelInitializer:init(2)}).apply(x);
  x=tf.layers.flatten().apply(x);x=tf.layers.dense({units:32,activation:'relu',kernelInitializer:init(3)}).apply(x);
  return tf.model({inputs:input,outputs:Object.entries(CONTROL_HEADS).map(([name,classes],i)=>tf.layers.dense({name,units:classes.length,activation:'softmax',kernelInitializer:init(4+i)}).apply(x))});
}
export function classBalance(labels,classes){
  const counts=Array(classes).fill(0);for(const y of labels){if(!Number.isInteger(y)||y<0||y>=classes)throw Error('Invalid class');counts[y]++;}
  if(!labels.length)throw Error('Empty labels');
  const raw=counts.map(n=>n?Math.min(4,Math.sqrt(labels.length/(classes*n))):0);
  const mean=counts.reduce((s,n,i)=>s+n*raw[i],0)/labels.length;
  return {counts,weights:raw.map(w=>w/mean)};
}
