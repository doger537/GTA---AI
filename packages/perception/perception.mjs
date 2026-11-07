import * as ort from 'onnxruntime-node';
import sharp from 'sharp';
import {fileURLToPath} from 'node:url';
import {SemanticRoad} from './semantic-road.mjs';
import {imageNetTensor} from './vision-tensor.mjs';
import {createInferenceSession} from './inference-session.mjs';
import {addRoadOcclusions} from './road-occlusion.mjs';
import {decodeFrame,frameImage} from './decoded-frame.mjs';

export class Perception {
  static async load({size=640,provider='dml',roadModel='semantic',cameraProfile='unknown',sessionMode='worker'}={}) {
    const filename=size===640?'./models/yolop-640.onnx':'./models/yolop-320.onnx';
    const session = await createInferenceSession(fileURLToPath(new URL(filename,import.meta.url)), { executionProviders: [provider], intraOpNumThreads: 3,enableMemPattern:false,executionMode:'sequential' },{mode:sessionMode});
    try{const semantic=roadModel==='semantic'?await SemanticRoad.load({provider,sessionMode}):null;return new Perception(session,size,semantic,cameraProfile);}
    catch(e){await session.release();throw e;}
  }
  constructor(session,size,semantic,cameraProfile) { this.session = session;this.size=size;this.semantic=semantic;this.cameraProfile=cameraProfile; }
  async analyze(bytes,{decodeOnce=false}={}) {
    if(typeof decodeOnce!=='boolean')throw Error('decodeOnce must be boolean');
    const started = performance.now();
    const meta=await sharp(bytes).metadata();
    // Other sizes/codecs can use decoder shrink or alpha-aware resize paths.
    // Keep those on the original pipeline rather than silently changing pixels.
    const eligible=meta.format==='jpeg'&&meta.space==='srgb'&&meta.channels===3&&!meta.icc&&!meta.orientation&&meta.width<=1280&&meta.height<=720&&this.size===640&&(!this.semantic||this.semantic.size===512);
    const decodedFrame=decodeOnce&&eligible?await decodeFrame(bytes):null;
    const n = this.size, ratio = Math.min(n / meta.width, n / meta.height);
    const rw = Math.round(meta.width * ratio), rh = Math.round(meta.height * ratio);
    const top = Math.floor((n - rh) / 2), left = Math.floor((n - rw) / 2);
    const raw = await frameImage(bytes,decodedFrame).removeAlpha().resize(rw, rh).extend({ top, bottom: n - rh - top, left, right: n - rw - left, background: { r:114,g:114,b:114 } }).raw().toBuffer();
    const values = imageNetTensor(raw,n*n);
    const [output,semantic] = await Promise.all([
      this.session.run({[this.session.inputNames[0]]:new ort.Tensor('float32',values,[1,3,n,n])}),
      this.semantic?this.semantic.analyze(bytes,{cameraProfile:this.cameraProfile,...(decodedFrame?{decodedFrame}:{})}):Promise.resolve(null)
    ]);
    const road = output.drive_area_seg, lanes = output.lane_line_seg, det = output.det_out;
    if(!road || !lanes || !det)throw new Error(`Unexpected model outputs: ${Object.keys(output)}`);
    const mask = new Uint8Array(n*n), lane = new Uint8Array(n*n);
    for(let i=0;i<n*n;i++){if(!semantic)mask[i]=road.data[n*n+i]>road.data[i]?1:0;lane[i]=lanes.data[n*n+i]>lanes.data[i]?1:0;}
    const boxes=[];const stride=det.dims.at(-1);
    for(let i=0;i<det.data.length;i+=stride){
      const d=det.data,score=d[i+4]*d[i+5];if(score<.35)continue;
      const x=(d[i]-d[i+2]/2-left)/rw,y=(d[i+1]-d[i+3]/2-top)/rh,w=d[i+2]/rw,h=d[i+3]/rh;
      if(x+w<0 || x>1 || y+h<0 || y>1)continue;
      if(y+h>.86 && x<.65 && x+w>.35 && w*h>.10)continue; // Ignore probable ego vehicle, rear camera only.
      if(semantic){
        let signPixels=0,total=0;
        for(let yy=.2;yy<=.8;yy+=.2)for(let xx=.2;xx<=.8;xx+=.2){
          const sx=Math.max(0,Math.min(semantic.gridWidth-1,Math.floor((x+w*xx)*semantic.gridWidth))),sy=Math.max(0,Math.min(semantic.gridHeight-1,Math.floor((y+h*yy)*semantic.gridHeight)));
          const index=sy*semantic.gridWidth+sx,id=semantic.labels[index];
          if([5,6,7].includes(id)&&semantic.probability[index]>.8)signPixels++;total++;
        }
        // Only veto a confidently recognized sign/pole/light. Uncertain semantics
        // must not erase a possible distant vehicle.
        if(signPixels/total>.6)continue;
      }
      boxes.push({x,y,w,h,score});
    }
    boxes.sort((a,b)=>b.score-a.score);const kept=[];
    for(const box of boxes){if(!kept.some(other=>iou(box,other)>.45))kept.push(box);if(kept.length>=30)break;}
    const corridorSemantic=semantic?addRoadOcclusions(semantic,kept):null;
    if(corridorSemantic){
      for(let y=0;y<rh;y++)for(let x=0;x<rw;x++){
        const sx=Math.min(semantic.gridWidth-1,Math.floor(x/rw*semantic.gridWidth)),sy=Math.min(semantic.gridHeight-1,Math.floor(y/rh*semantic.gridHeight));
        const fx=x/rw,fy=y/rh,hud=(fx<.22&&fy>.78)||(fx>.78&&fy>.56);
        mask[(top+y)*n+left+x]=!hud?corridorSemantic.corridorRoad[sy*semantic.gridWidth+sx]:0;
      }
    }
    const rows=[];
    for(const yf of [.48,.54,.60,.66]){
      const y=Math.round(top+yf*rh);let runs=[],start=-1;
      for(let x=left;x<=left+rw;x++){
        const on=x<left+rw && mask[y*n+x];
        if(on && start<0)start=x;
        if(!on && start>=0){if(x-start>rw*.08)runs.push({left:(start-left)/rw,right:(x-left)/rw});start=-1;}
      }
      runs.sort((a,b)=>Math.abs((a.left+a.right)/2-.5)-Math.abs((b.left+b.right)/2-.5));
      if(runs.length)rows.push({y:yf,...runs[0],center:(runs[0].left+runs[0].right)/2});
    }
    const confidence=rows.length/4;
    const center=rows.length?rows.reduce((a,r)=>a+r.center,0)/rows.length:null;
    let roadPixels=0,total=0;
    for(let y=top+Math.round(rh*.48);y<top+Math.round(rh*.66);y++)for(let x=left+Math.round(rw*.3);x<left+Math.round(rw*.7);x++){roadPixels+=mask[y*n+x];total++;}
    return {width:meta.width,height:meta.height,inference_ms:Math.round(performance.now()-started),rows,center,confidence,confidence_kind:'scanline_support_not_probability',road_model:semantic?'SegFormer B0 Cityscapes':'YOLOP',road_fraction:roadPixels/Math.max(total,1),vehicles:kept,mask,lane,semantic:corridorSemantic,letterbox:{n,top,left,rw,rh}};
  }
  async overlay(bytes,p){
    const {n,top,left,rw,rh}=p.letterbox;
    const rgba=Buffer.alloc(n*n*4);
    for(let i=0;i<n*n;i++){if(p.mask[i]){rgba[i*4+1]=255;rgba[i*4+3]=65;}if(p.lane[i]){rgba[i*4]=255;rgba[i*4+1]=100;rgba[i*4+3]=180;}}
    const mask=await sharp(rgba,{raw:{width:n,height:n,channels:4}}).extract({left,top,width:rw,height:rh}).resize(p.width,p.height).png().toBuffer();
    const svg=`<svg width="${p.width}" height="${p.height}">${p.vehicles.map(b=>`<rect x="${b.x*p.width}" y="${b.y*p.height}" width="${b.w*p.width}" height="${b.h*p.height}" fill="none" stroke="red" stroke-width="3"/>`).join('')}${p.rows.map(r=>`<circle cx="${r.center*p.width}" cy="${r.y*p.height}" r="7" fill="cyan"/>`).join('')}</svg>`;
    return sharp(bytes).composite([{input:mask},{input:Buffer.from(svg)}]).jpeg().toBuffer();
  }
}
function iou(a,b){const x=Math.max(0,Math.min(a.x+a.w,b.x+b.w)-Math.max(a.x,b.x)),y=Math.max(0,Math.min(a.y+a.h,b.y+b.h)-Math.max(a.y,b.y));return x*y/(a.w*a.h+b.w*b.h-x*y+1e-9);}
