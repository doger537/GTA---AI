import sharp from 'sharp';
import {readFile} from 'node:fs/promises';
import {INPUT,imageCache,packHistory} from '../../training/bc-data.mjs';
import {excludedByCamera} from './camera-profile.mjs';
import {orderedFrameCache} from './ordered-frame-cache.mjs';
export const MOTION_INPUT={width:128,height:72,history:4,channels:4};
export function packGray(frames,width=128,height=72){
  if(frames.length!==4||frames.some(f=>f.length!==width*height))throw Error('Four grayscale frames required');
  const out=new Float32Array(width*height*4),[a,b,c,d]=frames;for(let p=0;p<width*height;p++){const i=p*4;out[i]=a[p]/127.5-1;out[i+1]=b[p]/127.5-1;out[i+2]=c[p]/127.5-1;out[i+3]=d[p]/127.5-1;}return out;
}
export async function ablationFrame(bytes,{rgb=false,mask=false,contrast=false}={}){
  let img=sharp(bytes).removeAlpha().resize(128,72);
  const channels=rgb?3:1;
  let b=await (rgb?img.toColourspace('srgb'):img.grayscale().toColourspace('b-w')).raw().toBuffer();
  const applyMask=()=>{for(let y=0;y<72;y++)for(let x=0;x<128;x++)if(maskedPreparedPixel((x+.5)/128,(y+.5)/72))for(let c=0;c<channels;c++)b[(y*128+x)*channels+c]=128;};
  if(mask)applyMask();
  if(contrast){if(rgb)throw Error('Contrast ablation is grayscale only');b=await sharp(b,{raw:{width:128,height:72,channels:1}}).clahe({width:8,height:8,maxSlope:2}).toColourspace('b-w').raw().toBuffer();}
  if(mask)applyMask();return b;
}
async function ablationCache(root,examples,options){
  return orderedFrameCache(root,examples,async full=>ablationFrame(await readFile(full),options));
}
export function maskedPreparedPixel(x,y){
  // prepare-dataset.mjs maps original y=.20..75 into each saved road crop.
  return excludedByCamera(x,.20+y*.55,'rear');
}
export async function grayRoad(bytes){
  const {width,height}=MOTION_INPUT;
  const gray=await sharp(bytes).removeAlpha().grayscale().resize(width,height).toColourspace('b-w').raw().toBuffer();
  for(let y=0;y<height;y++)for(let x=0;x<width;x++)if(maskedPreparedPixel((x+.5)/width,(y+.5)/height))gray[y*width+x]=128;
  const contrast=await sharp(gray,{raw:{width,height,channels:1}}).clahe({width:8,height:8,maxSlope:2}).toColourspace('b-w').raw().toBuffer();
  for(let y=0;y<height;y++)for(let x=0;x<width;x++)if(maskedPreparedPixel((x+.5)/width,(y+.5)/height))contrast[y*width+x]=128;
  return contrast;
}
export function packMotion(frames,width=MOTION_INPUT.width,height=MOTION_INPUT.height){
  if(frames.length!==4||frames.some(f=>f.length!==width*height))throw Error('Four grayscale frames required');
  const values=new Float32Array(width*height*4);
  for(let i=0;i<width*height;i++){
    values[i*4]=frames[3][i]/127.5-1;
    for(let t=0;t<3;t++)values[i*4+t+1]=Math.max(-1,Math.min(1,(frames[t+1][i]-frames[t][i])/127.5));
  }
  return values;
}
async function motionCache(root,examples){
  return orderedFrameCache(root,examples,async full=>grayRoad(await sharp(full).toBuffer()));
}
export function controlVision(name='rgb-v1'){
  if(name==='pilotnet-gray-v1')return {input:{width:200,height:66,history:4,channels:4},traits:{rgb:false,mask:false,contrast:false,motion:false},pack:f=>packGray(f,200,66),cache:(root,examples)=>orderedFrameCache(root,examples,async full=>sharp(await readFile(full)).removeAlpha().grayscale().resize(200,66).toColourspace('b-w').raw().toBuffer())};
  if(name==='rgb-v1')return {input:INPUT,cache:imageCache,pack:packHistory,traits:{rgb:true,mask:false,contrast:false,motion:false}};
  if(name==='gray-motion-v1')return {input:MOTION_INPUT,cache:motionCache,pack:packMotion,traits:{rgb:false,mask:true,contrast:true,motion:true}};
  const profiles={
    'rgb-hi-v1':{rgb:true,mask:false,contrast:false,motion:false},
    'gray-stack-v1':{rgb:false,mask:false,contrast:false,motion:false},
    'gray-mask-v1':{rgb:false,mask:true,contrast:false,motion:false},
    'gray-contrast-v1':{rgb:false,mask:false,contrast:true,motion:false},
    'gray-delta-v1':{rgb:false,mask:false,contrast:false,motion:true},
  };
  if(profiles[name]){const traits=profiles[name];return {input:{width:128,height:72,history:4,channels:traits.rgb?12:4},cache:(r,e)=>ablationCache(r,e,traits),pack:traits.rgb?f=>packHistory(f,128,72):traits.motion?packMotion:packGray,traits};}
  throw Error('Unsupported control vision profile');
}
