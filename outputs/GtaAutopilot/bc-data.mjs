import sharp from 'sharp';
import {orderedFrameCache} from './ordered-frame-cache.mjs';
export const INPUT={width:80,height:45,history:4,channels:12};
export function separateSessionSplit(train,validation,trainSession,validationSession){
  if(!trainSession||!validationSession||trainSession===validationSession)throw Error('Separate recording sessions required');
  if(train.length<32||validation.length<16)throw Error('Insufficient separate-session examples');
  if(train.some(e=>e.source_session!==trainSession)||validation.some(e=>e.source_session!==validationSession))throw Error('Mixed source sessions');
  return {train:[...train],validation:[...validation],cutoff_ms:null,gap_ms:null,omitted:0};
}
export function temporalSplit(examples,{fraction=.75,gapMs=1000}={}){
  if(examples.length<48)throw Error('At least 48 examples required');
  for(let i=0;i<examples.length;i++)if(!Number.isFinite(examples[i].time_ms)||(i&&examples[i].time_ms<=examples[i-1].time_ms))throw Error('Examples must have increasing timestamps');
  const cutoff=examples[0].time_ms+(examples.at(-1).time_ms-examples[0].time_ms)*fraction;
  const train=examples.filter(e=>e.time_ms<cutoff-gapMs/2),validation=examples.filter(e=>e.time_ms>cutoff+gapMs/2);
  if(train.length<32||validation.length<16)throw Error('Not enough temporally separated samples');
  const used=new Set(train.flatMap(e=>e.frames));
  if(validation.some(e=>e.frames.some(f=>used.has(f))))throw Error('Shared image across training and validation');
  return {train,validation,cutoff_ms:cutoff,gap_ms:gapMs,omitted:examples.length-train.length-validation.length};
}
export function packHistory(frames,width=INPUT.width,height=INPUT.height){
  if(frames.length!==4||frames.some(f=>f.length!==width*height*3))throw Error('Four RGB frames of matching size required');
  const out=new Float32Array(width*height*12);
  for(let p=0;p<width*height;p++){const source=p*3;let target=p*12;for(let t=0;t<4;t++){const f=frames[t];out[target++]=f[source]/127.5-1;out[target++]=f[source+1]/127.5-1;out[target++]=f[source+2]/127.5-1;}}
  return out;
}
export async function imageCache(root,examples){
  return orderedFrameCache(root,examples,full=>sharp(full).removeAlpha().toColourspace('srgb').resize(INPUT.width,INPUT.height).raw().toBuffer());
}
export function metrics(truth,probabilities,keys,threshold=.5){
  if(truth.length!==probabilities.length||!truth.length)throw Error('Non-empty equal-length predictions required');
  if(truth.some(y=>y.length!==keys.length||y.some(v=>v!==0&&v!==1))||probabilities.some(p=>p.length!==keys.length||p.some(v=>!Number.isFinite(v)||v<0||v>1)))throw Error('Invalid target or probability');
  const per_key=keys.map((key,k)=>{
    let tp=0,tn=0,fp=0,fn=0;
    truth.forEach((y,i)=>{const p=probabilities[i][k]>=threshold;if(y[k]){if(p)tp++;else fn++;}else{if(p)fp++;else tn++;}});
    const precision=tp+fp?tp/(tp+fp):null,recall=tp+fn?tp/(tp+fn):null;
    return {key,positive_examples:tp+fn,tp,tn,fp,fn,precision,recall,f1:tp+fn?2*tp/(2*tp+fp+fn):null};
  });
  const supported=per_key.filter(k=>k.f1!==null);
  return {samples:truth.length,exact_match:truth.filter((y,i)=>y.every((v,k)=>Boolean(v)===(probabilities[i][k]>=threshold))).length/truth.length,macro_f1_supported:supported.length?supported.reduce((s,k)=>s+k.f1,0)/supported.length:null,per_key};
}
