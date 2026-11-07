import sharp from 'sharp';
import {createWorker,PSM} from 'tesseract.js';
import {fileURLToPath} from 'node:url';
import {detectZeroDash} from './zero-dash.mjs';
import {paddedSpeedConsensus,agreeSpeedViews} from './padded-speed.mjs';
import {confirmSingleGlyph} from './single-glyph-speed.mjs';
import {confirmSegmentedSpeed} from './segmented-speed.mjs';
import {loadDigitModel,matchHudDigits,confirmDigitModel} from './hud-digit-model.mjs';

export function speedTimingCheck(kmh,time_ms,previous){
  if(!Number.isFinite(time_ms))return {valid:false,reason:'invalid_capture_time'};
  if(!previous)return {valid:true};
  const dt=(time_ms-previous.time_ms)/1000,change=Math.abs(kmh-previous.kmh),limit=Math.max(8,dt*36);
  const details={dt_ms:dt*1000,change_kmh:change,limit_kmh:limit,previous_kmh:previous.kmh};
  if(dt<=0)return {valid:false,reason:'non_increasing_capture_time',...details};
  if(dt<=2&&change>limit)return {valid:false,reason:'temporal_speed_jump',...details};
  return {valid:true,...details};
}

export class SpeedReader {
  static async create(roi){
    if(!roi || !['left','top','width','height'].every(k=>Number.isFinite(roi[k])&&roi[k]>=0) || roi.width<=0 || roi.height<=0)throw Error('Configure a real speedometer pixel ROI');
    const digitModel=roi.native_digit_confirmation===true?await loadDigitModel():null;
    const worker=await createWorker('eng',1,{langPath:fileURLToPath(new URL('./models/ocr/',import.meta.url)),gzip:false,cacheMethod:'none'});
    await worker.setParameters({tessedit_char_whitelist:'0123456789.-',tessedit_pageseg_mode:PSM.SINGLE_LINE,user_defined_dpi:'150'});
    return new SpeedReader(worker,roi,digitModel);
  }
  constructor(worker,roi,digitModel=null){this.worker=worker;this.roi=roi;this.digitModel=digitModel;this.previous=null;}
  async read(bytes,time_ms){
    const meta=await sharp(bytes).metadata();
    const roi=this.roi.normalized?{left:Math.round(this.roi.left*meta.width),top:Math.round(this.roi.top*meta.height),width:Math.round(this.roi.width*meta.width),height:Math.round(this.roi.height*meta.height)}:{left:this.roi.left,top:this.roi.top,width:this.roi.width,height:this.roi.height};
    const source=await sharp(bytes).extract(roi).removeAlpha().raw().toBuffer();
    const dash=this.roi.dash_means_zero===true&&detectZeroDash(source,roi.width,roi.height,{cyan:this.roi.dash_cyan===true});
    const crop=await sharp(bytes).extract(roi).resize({height:100}).grayscale().normalize().png().toBuffer();
    let data=dash?{text:'-',confidence:0}:(await this.worker.recognize(crop)).data;
    const primary={text:data.text.trim(),confidence:data.confidence};let secondary=null;
    if(!dash&&(this.roi.require_consensus||!/^\d{1,3}(\.\d)?$/.test(data.text.trim())||data.confidence<75)){
      // Separate the bright HUD glyphs from coloured asphalt/curb backgrounds.
      const binary=Buffer.alloc(roi.width*roi.height,255);
      for(let i=0;i<binary.length;i++){const offset=i*3,r=source[offset],g=source[offset+1],b=source[offset+2];if((Math.min(r,g,b)>185&&Math.max(r,g,b)-Math.min(r,g,b)<75)||(g>170&&b>175&&g>r*1.08&&b>r*1.08))binary[i]=0;}
      const alternative=await sharp(binary,{raw:{width:roi.width,height:roi.height,channels:1}}).resize({height:138,kernel:'nearest'}).extend({top:15,bottom:15,left:15,right:15,background:'white'}).png().toBuffer();
      const candidate=(await this.worker.recognize(alternative)).data;
      secondary={text:candidate.text.trim(),confidence:candidate.confidence};
      if(/^\d{1,3}(\.\d)?$/.test(candidate.text.trim())&&candidate.confidence>=75)data=candidate;
    }
    let padded=null;
    if(!dash&&this.roi.padded_consensus===true&&this.roi.require_consensus===true&&!(secondary&&primary.confidence>=75&&secondary.confidence>=75&&primary.text===secondary.text&&/^\d{1,3}(\.\d)?$/.test(primary.text))){
      padded=await paddedSpeedConsensus(this.worker,bytes,roi,meta);
      padded={...padded,...agreeSpeedViews([{...primary,family:'gray'},{...secondary,family:'mask'},...padded.candidates.map(c=>({...c,family:c.mode}))])};
      if(padded.valid)data={text:padded.text,confidence:padded.confidence};
    }
    let glyph=null;
    if(!dash&&this.roi.single_glyph_confirmation===true&&!padded?.valid&&!(secondary&&primary.confidence>=75&&secondary.confidence>=75&&primary.text===secondary.text&&/^\d{1,3}(\.\d)?$/.test(primary.text))){
      glyph=await confirmSingleGlyph(this.worker,source,roi.width,roi.height);
      if(glyph.valid&&[primary,secondary,...(padded?.candidates??[])].some(c=>c&&/^\d{1,3}$/.test(c.text)&&c.confidence>=75&&Number(c.text)!==7))glyph={...glyph,valid:false,reason:'conflicting_ocr'};
      if(glyph.valid)data={text:glyph.text,confidence:glyph.confidence};
    }
    let segmented=null;
    if(!dash&&this.roi.segmented_seven_confirmation===true&&!padded?.valid&&!glyph?.valid&&!(secondary&&primary.confidence>=75&&secondary.confidence>=75&&primary.text===secondary.text&&/^\d{1,3}(\.\d)?$/.test(primary.text))){
      segmented=await confirmSegmentedSpeed(this.worker,source,roi.width,roi.height,[primary,secondary,...(padded?.candidates??[])]);
      if(segmented.valid)data={text:segmented.text,confidence:segmented.confidence};
    }
    let font=null;
    if(!dash&&this.digitModel&&!padded?.valid&&!glyph?.valid&&!segmented?.valid&&!(secondary&&primary.confidence>=75&&secondary.confidence>=75&&primary.text===secondary.text&&/^\d{1,3}(\.\d)?$/.test(primary.text))){
      font=confirmDigitModel(matchHudDigits(source,roi.width,roi.height,this.digitModel),[primary,secondary,...(padded?.candidates??[])]);
      if(font.valid)data={text:font.text,confidence:font.confidence};
    }
    const text=data.text.trim(),numeric=/^\d{1,3}(\.\d)?$/.test(text)&&data.confidence>=75;
    // OCR punctuation alone cannot prove that the car is stopped.
    const unverifiedDash=!dash&&this.roi.dash_means_zero===true&&/^[-–—]$/.test(text);
    const zero=!numeric&&dash;
    const kmh=numeric?Number(text):zero?0:NaN;
    let valid=Number.isFinite(kmh)&&kmh<=200&&(zero||data.confidence>=75);
    let rejection_reason=valid?null:unverifiedDash?'unverified_zero_dash':'unreadable_or_out_of_range_speed',temporal_check=null;
    const consensus=!this.roi.require_consensus||zero||padded?.valid||glyph?.valid||segmented?.valid||font?.valid||(secondary&&/^\d{1,3}(\.\d)?$/.test(primary.text)&&primary.confidence>=75&&secondary.confidence>=75&&primary.text===secondary.text);
    if(!consensus){valid=false;rejection_reason=unverifiedDash?'unverified_zero_dash':'ocr_unconfirmed';}
    if(valid){temporal_check=speedTimingCheck(kmh,time_ms,this.previous);if(!temporal_check.valid){valid=false;rejection_reason=temporal_check.reason;}}
    if(valid)this.previous={kmh,time_ms};
    else if(this.previous&&time_ms-this.previous.time_ms>2000)this.previous=null;
    return {valid,kmh:valid?kmh:null,speed_mps:valid?kmh/3.6:null,confidence:zero?null:data.confidence,text,source:!consensus?'ocr_unconfirmed':zero?'configured_zero_dash':font?.valid?'ocr_digit_model_confirmation':segmented?.valid?'ocr_segmented_seven':glyph?.valid?'ocr_glyph_shape_confirmation':padded?.valid?'ocr_padded_consensus':'ocr',rejection_reason,...(temporal_check?{temporal_check}:{}),...(this.roi.require_consensus?{candidates:[primary,secondary]}:{}),...(padded?{padded_candidates:padded.candidates}:{}),...(glyph?{glyph_confirmation:glyph}:{}),...(segmented?{segmented_confirmation:segmented}:{}),...(font?{digit_model_confirmation:font}:{}),time_ms};
  }
  async close(){await this.worker.terminate();}
}
