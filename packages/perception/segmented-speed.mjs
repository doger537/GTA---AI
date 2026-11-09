import sharp from 'sharp';
import {sevenGlyph} from './single-glyph-speed.mjs';

// Only isolated, complete native HUD glyphs. Never split touching ink or repair
// cropped characters. Threshold and scales were selected on the development trip.
export function segmentSpeedGlyphs(source,width,height,{requireSeven=true}={}){
  if(!Number.isInteger(width)||!Number.isInteger(height)||width<3||height<3||source.length!==width*height*3)return null;
  const ink=Buffer.alloc(width*height,255),columns=new Uint8Array(width);
  for(let i=0;i<width*height;i++)if(Math.min(source[i*3],source[i*3+1],source[i*3+2])>210){ink[i]=0;columns[i%width]=1;}
  const boxes=[];let start=-1;
  for(let x=0;x<=width;x++){
    if(x<width&&columns[x]){if(start<0)start=x;}
    else if(start>=0){
      let top=height,bottom=-1;
      for(let xx=start;xx<x;xx++)for(let y=0;y<height;y++)if(ink[y*width+xx]===0){top=Math.min(top,y);bottom=Math.max(bottom,y);}
      const box={left:start,top,width:x-start,height:bottom-top+1};
      if(start<1||x>=width||top<1||bottom>=height-1||box.height<10||box.width<2||box.width/box.height>.85)return null;
      boxes.push(box);start=-1;
    }
  }
  if(boxes.length<2||boxes.length>3)return null;
  const top=Math.min(...boxes.map(b=>b.top)),bottom=Math.max(...boxes.map(b=>b.top+b.height));
  if(boxes.some(b=>Math.abs(b.top-top)>2||Math.abs(b.top+b.height-bottom)>2))return null;
  for(const b of boxes){
    const w=b.width+4,h=b.height+4,rgb=Buffer.alloc(w*h*3);
    for(let y=0;y<b.height;y++)for(let x=0;x<b.width;x++)if(ink[(y+b.top)*width+x+b.left]===0)rgb.fill(255,((y+2)*w+x+2)*3,((y+2)*w+x+2)*3+3);
    b.seven=!!sevenGlyph(rgb,w,h);
  }
  return !requireSeven||boxes.some(b=>b.seven)?{ink,boxes}:null;
}

// The known whole-string failures replace/drop a structurally verified seven.
// A conflicting confidently read NON-seven digit must still veto the repair.
export function compatibleSevenReading(observed,expected){
  if(!/^[1-9]\d{1,2}$/.test(expected)||!expected.includes('7')||!/^\d{1,3}$/.test(observed))return false;
  let variants=[''];for(const c of expected)variants=variants.flatMap(prefix=>(c==='7'?['7','1','']: [c]).map(v=>prefix+v));
  return variants.includes(observed);
}

export async function confirmSegmentedSpeed(worker,source,width,height,wholeViews=[]){
  const segmented=segmentSpeedGlyphs(source,width,height);
  if(!segmented)return {valid:false,reason:'no_complete_separated_seven',glyphs:[]};
  const glyphs=[];
  try{
    await worker.setParameters({tessedit_char_whitelist:'0123456789',tessedit_pageseg_mode:'8'});
    for(const box of segmented.boxes){
      const candidates=[];
      // Fixed pairs, no search for a favourable confidence at runtime. The narrow
      // slanted seven needs a smaller raster than the other isolated characters.
      for(const renderHeight of box.seven?[60,80]:[100,120]){
        const crop=await sharp(segmented.ink,{raw:{width,height,channels:1}})
          .extract({left:box.left,top:box.top,width:box.width,height:box.height})
          .resize({width:Math.round(box.width/box.height*renderHeight),height:renderHeight,kernel:'nearest'})
          .extend({top:20,bottom:20,left:20,right:20,background:'white'}).png().toBuffer();
        const {data}=await worker.recognize(crop);candidates.push({text:data.text.trim(),confidence:data.confidence,height:renderHeight});
      }
      const text=candidates[0].text;
      const valid=/^\d$/.test(text)&&candidates.every(c=>c.text===text&&Number.isFinite(c.confidence)&&c.confidence>=75)&&(!box.seven||text==='7');
      glyphs.push({box,candidates,valid,text:valid?text:null});
      if(!valid)return {valid:false,reason:'glyph_ocr_disagreement',glyphs};
    }
  }finally{await worker.setParameters({tessedit_char_whitelist:'0123456789.-',tessedit_pageseg_mode:'7'});}
  const text=glyphs.map(g=>g.text).join('');
  if(!/^[1-9]\d{1,2}$/.test(text)||Number(text)>200)return {valid:false,reason:'outside_speed_range',glyphs};
  if(wholeViews.some(c=>c&&/^\d{1,3}$/.test(c.text)&&c.confidence>=75&&!compatibleSevenReading(c.text,text)))return {valid:false,reason:'conflicting_non_seven_digits',glyphs};
  return {valid:true,text,confidence:Math.min(...glyphs.flatMap(g=>g.candidates.map(c=>c.confidence))),reason:'separated_digits_and_seven_structure_agree',glyphs};
}
