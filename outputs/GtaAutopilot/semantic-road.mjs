import * as ort from 'onnxruntime-node';
import sharp from 'sharp';
import {fileURLToPath} from 'node:url';
import {readFile} from 'node:fs/promises';
import {excludedByCamera} from './camera-profile.mjs';
import {imageNetTensor} from './vision-tensor.mjs';
import {createInferenceSession} from './inference-session.mjs';

export class SemanticRoad {
  static async load({provider='dml',size=512,sessionMode='worker'}={}) {
    const config=JSON.parse(await readFile(new URL('./models/segformer-config.json',import.meta.url),'utf8'));
    if(config.id2label['0']!=='road'||config.id2label['1']!=='sidewalk')throw Error('Unexpected class map');
    const session=await createInferenceSession(fileURLToPath(new URL('./models/segformer-cityscapes.onnx',import.meta.url)),{executionProviders:[provider],enableMemPattern:false,executionMode:'sequential',intraOpNumThreads:3,logSeverityLevel:3},{mode:sessionMode});
    return new SemanticRoad(session,size,config.id2label);
  }
  constructor(session,size,labels){this.session=session;this.size=size;this.labels=labels;}
  async analyze(bytes,{cameraProfile='unknown',horizontalFlip=false,resizeMode='square'}={}){
    if(!['square','aspect'].includes(resizeMode))throw Error('Unknown semantic resize mode');
    const start=performance.now(),meta=await sharp(bytes).metadata(),n=this.size;
    const inputWidth=resizeMode==='aspect'?Math.max(32,Math.round(n*meta.width/meta.height/32)*32):n;
    if(resizeMode==='aspect'&&(!Number.isInteger(inputWidth)||inputWidth<32||inputWidth>2048))throw Error('Unsupported semantic input width');
    let pipeline=sharp(bytes).removeAlpha().toColourspace('srgb');if(horizontalFlip)pipeline=pipeline.flop();
    const raw=await pipeline.resize(inputWidth,n,{fit:'fill',kernel:'linear'}).raw().toBuffer();
    const tensor=imageNetTensor(raw,inputWidth*n);
    const result=await this.session.run({pixel_values:new ort.Tensor('float32',tensor,[1,3,n,inputWidth])});
    const logits=result.logits,[batch,classes,height,nativeWidth]=logits.dims;
    // Keep the established square image-space grid for downstream geometry.
    // In aspect mode select native logit cells at destination cell centers.
    const width=resizeMode==='aspect'?height:nativeWidth,nativeCount=nativeWidth*height;
    if(batch!==1||classes!==19)throw Error(`Unexpected logits: ${logits.dims}`);
    const count=width*height,labels=new Uint8Array(count),probability=new Float32Array(count);
    const road=new Uint8Array(count),rawRoad=new Uint8Array(count),sidewalk=new Uint8Array(count),obstacle=new Uint8Array(count);
    for(let i=0;i<count;i++){
      const nativeX=Math.min(nativeWidth-1,Math.floor((i%width+.5)*nativeWidth/width));
      const modelIndex=Math.floor(i/width)*nativeWidth+(horizontalFlip?nativeWidth-1-nativeX:nativeX);
      let best=-Infinity,id=0;
      for(let c=0;c<classes;c++){const v=logits.data[c*nativeCount+modelIndex];if(v>best){best=v;id=c;}}
      let sum=0;for(let c=0;c<classes;c++)sum+=Math.exp(logits.data[c*nativeCount+modelIndex]-best);
      labels[i]=id;probability[i]=1/sum;
      rawRoad[i]=id===0&&probability[i]>=.65?1:0;
      road[i]=rawRoad[i]&&!excludedByCamera((i%width+.5)/width,(Math.floor(i/width)+.5)/height,cameraProfile)?1:0;
      sidewalk[i]=id===1&&probability[i]>=.5?1:0;
      obstacle[i]=id>=11&&id<=18&&probability[i]>=.5?1:0;
    }
    return {width:meta.width,height:meta.height,gridWidth:width,gridHeight:height,labels,probability,road,rawRoad,sidewalk,obstacle,cameraProfile,horizontalFlip,inference_ms:Math.round(performance.now()-start),model:'SegFormer B0 Cityscapes'};
  }
  async overlay(bytes,p){
    const rgba=Buffer.alloc(p.gridWidth*p.gridHeight*4);
    for(let i=0;i<p.labels.length;i++){
      if(p.road[i]&&p.corridorRoad&&!p.corridorRoad[i]){rgba[i*4]=255;rgba[i*4+2]=255;rgba[i*4+3]=140;}
      else if(p.road[i]){rgba[i*4+1]=255;rgba[i*4+3]=85;}
      else if(p.sidewalk[i]){rgba[i*4]=220;rgba[i*4+2]=255;rgba[i*4+3]=110;}
      else if(p.obstacle[i]){rgba[i*4]=255;rgba[i*4+3]=100;}
    }
    const overlay=await sharp(rgba,{raw:{width:p.gridWidth,height:p.gridHeight,channels:4}}).resize(p.width,p.height,{kernel:'nearest'}).png().toBuffer();
    return sharp(bytes).composite([{input:overlay}]).jpeg({quality:90}).toBuffer();
  }
  sample(p,x,y){const i=Math.min(p.gridHeight-1,Math.floor(y*p.gridHeight))*p.gridWidth+Math.min(p.gridWidth-1,Math.floor(x*p.gridWidth));return {class_id:p.labels[i],label:this.labels[String(p.labels[i])],probability:p.probability[i],road:p.road[i]===1};}
}
