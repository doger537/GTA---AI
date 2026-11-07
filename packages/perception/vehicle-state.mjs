import sharp from 'sharp';
import {createWorker,PSM} from 'tesseract.js';
import {fileURLToPath} from 'node:url';
import {SpeedReader} from './speed-reader.mjs';
import {gearGlyph,matchGearGlyph,loadGearTemplates,confirmGear} from './gear-shape.mjs';
export const GAUGE_PROFILE={
  speed:{normalized:true,dash_means_zero:true,require_consensus:true,left:.8455882353,top:.8329979879,width:.025210084,height:.0342052314},
  gear:{left:.8640625,top:.7814371257,width:.015625, height:.0479041916},
};
export class VehicleStateReader {
  static async create(profile=GAUGE_PROFILE){
    const templates=profile.gear.shape_confirmation?await loadGearTemplates():null;
    const speed=await SpeedReader.create(profile.speed);
    const worker=await createWorker('eng',1,{langPath:fileURLToPath(new URL('./models/ocr/',import.meta.url)),gzip:false,cacheMethod:'none'});
    await worker.setParameters({tessedit_char_whitelist:'RN12345678',tessedit_pageseg_mode:PSM.SINGLE_CHAR,user_defined_dpi:'70'});
    const reader=new VehicleStateReader(speed,worker,profile);
    reader.templates=templates;
    return reader;
  }
  constructor(speed,worker,profile){this.speed=speed;this.worker=worker;this.profile=profile;}
  async read(bytes,time_ms,{speedResult=null}={}){
    if(speedResult&&speedResult.time_ms!==time_ms)throw Error('Speed result must belong to this capture timestamp');
    const meta=await sharp(bytes).metadata(),r=this.profile.gear;
    const roi={left:Math.round(r.left*meta.width),top:Math.round(r.top*meta.height),width:Math.round(r.width*meta.width),height:Math.round(r.height*meta.height)};
    const raw=await sharp(bytes).extract(roi).removeAlpha().toColourspace('srgb').raw().toBuffer();
    const binary=Buffer.alloc(roi.width*roi.height,255);
    for(let i=0;i<binary.length;i++){const R=raw[i*3],G=raw[i*3+1],B=raw[i*3+2];if(G>180&&B>180&&((G>R*1.05&&B>R*1.05)||Math.min(R,G,B)>210))binary[i]=0;}
    const crop=await sharp(binary,{raw:{width:roi.width,height:roi.height,channels:1}}).resize({height:180,kernel:'nearest'}).extend({top:12,bottom:12,left:12,right:12,background:'white'}).png().toBuffer();
    const [speed,result]=await Promise.all([speedResult??this.speed.read(bytes,time_ms),this.worker.recognize(crop)]);
    let data=result.data;
    if(!/^[RN1-8]$/.test(data.text.trim())||data.confidence<75){
      const strict=Buffer.alloc(binary.length,255);for(let i=0;i<strict.length;i++){const R=raw[i*3],G=raw[i*3+1],B=raw[i*3+2];if(G>200&&B>200&&((G>R*1.05&&B>R*1.05)||Math.min(R,G,B)>210))strict[i]=0;}
      const strictCrop=await sharp(strict,{raw:{width:roi.width,height:roi.height,channels:1}}).resize({height:192,kernel:'nearest'}).extend({top:30,bottom:30,left:30,right:30,background:'white'}).png().toBuffer();
      await this.worker.setParameters({tessedit_pageseg_mode:PSM.SINGLE_WORD});
      const candidate=(await this.worker.recognize(strictCrop)).data;if(/^[RN1-8]$/.test(candidate.text.trim())&&candidate.confidence>data.confidence)data=candidate;
      await this.worker.setParameters({tessedit_pageseg_mode:PSM.SINGLE_CHAR});
      const alternative=await sharp(bytes).extract(roi).resize({height:180}).grayscale().normalize().png().toBuffer();
      const other=(await this.worker.recognize(alternative)).data;
      if(/^[RN1-8]$/.test(other.text.trim())&&other.confidence>data.confidence)data=other;
    }
    const text=data.text.trim(),gearValid=/^[RN1-8]$/.test(text)&&data.confidence>=75;
    let gear={valid:gearValid,value:gearValid?text:null,text,confidence:data.confidence};
    if(!gearValid&&this.templates)gear=confirmGear(gear,matchGearGlyph(await gearGlyph(bytes,r),this.templates));
    return {time_ms,speed,gear,profile:this.templates?'fixed_gauge_shape_v3':'fixed_gauge_roi_v2',source:'screen_ocr'};
  }
  async close(){await Promise.all([this.speed.close(),this.worker.terminate()]);}
}
export function classifySAction(state,before,after){
  if(!state?.gear?.valid)return {label:'unknown',reason:'unreadable_gear'};
  const gear=state.gear.value;
  if(gear==='R')return {label:!state.speed.valid?'reverse_selected_speed_unknown':state.speed.kmh>1?'reverse':'reverse_selected_stationary',reason:'reverse_gear_observed'};
  if(gear==='N')return {label:'unknown',reason:'neutral_gear'};
  if(state.speed.valid&&state.speed.kmh<=1)return {label:'stationary_s',reason:'zero_speed_in_forward_gear'};
  if(before?.speed?.valid&&after?.speed?.valid&&before.gear?.valid&&after.gear?.valid&&/^[1-8]$/.test(before.gear.value)&&/^[1-8]$/.test(after.gear.value)){
    const dt=(after.time_ms-before.time_ms)/1000;
    if(dt>0&&dt<=3&&after.speed.kmh<before.speed.kmh-2)return {label:'observed_deceleration_with_s',reason:'forward_gear_and_speed_drop'};
  }
  if(!state.speed.valid)return {label:'unknown',reason:'unreadable_speed'};
  return {label:'s_while_forward_moving',reason:'deceleration_not_confirmed'};
}
