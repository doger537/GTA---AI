import sharp from 'sharp';
import {segmentSpeedGlyphs} from './segmented-speed.mjs';

// A one has a left-facing head and an upright contiguous narrow stem. Source
// evidence for both ones is required before OCR may repair a dropped character.
export function elevenGlyphs(source,width,height){
  const segmented=segmentSpeedGlyphs(source,width,height,{requireSeven:false});
  if(!segmented||segmented.boxes.length!==2)return null;
  for(const b of segmented.boxes){
    if(b.width/b.height>.35)return null;
    const rows=[];
    for(let y=b.top;y<b.top+b.height;y++){
      let first=b.width,last=-1,count=0;
      for(let x=0;x<b.width;x++)if(segmented.ink[y*width+b.left+x]===0){first=Math.min(first,x);last=x;count++;}
      if(!count||last-first+1!==count)return null;
      rows.push({first,last,count});
    }
    const split=Math.ceil(b.height*.25),head=rows.slice(0,split),stem=rows.slice(split),anchor=stem[0];
    if(stem.some(r=>r.count>Math.ceil(b.width*.6)||Math.abs(r.first-anchor.first)>1||Math.abs(r.last-anchor.last)>1))return null;
    if(Math.max(...head.map(r=>r.count))<=Math.max(...stem.map(r=>r.count))||Math.min(...head.map(r=>r.first))>=Math.min(...stem.map(r=>r.first)))return null;
  }
  return segmented;
}

export async function confirmElevenSpeed(worker,source,width,height,wholeViews=[]){
  const segmented=elevenGlyphs(source,width,height);
  if(!segmented)return {valid:false,reason:'not_two_complete_ones',glyphs:[]};
  // Only the known deletion 11 -> 1 is compatible with the source geometry.
  if(wholeViews.some(c=>c&&/^\d{1,3}$/.test(c.text)&&Number.isFinite(c.confidence)&&c.confidence>=75&&!['1','11'].includes(c.text)))return {valid:false,reason:'conflicting_whole_speed',glyphs:[]};
  const glyphs=[];
  try{
    await worker.setParameters({tessedit_char_whitelist:'0123456789',tessedit_pageseg_mode:'8'});
    for(const box of segmented.boxes){
      const candidates=[];
      for(const renderHeight of [80,100]){
        const image=await sharp(segmented.ink,{raw:{width,height,channels:1}})
          .extract({left:box.left,top:box.top,width:box.width,height:box.height})
          .resize({height:renderHeight,kernel:'nearest'})
          .extend({top:20,bottom:20,left:20,right:20,background:'white'}).png().toBuffer();
        const {data}=await worker.recognize(image);
        candidates.push({text:data.text.trim(),confidence:data.confidence,height:renderHeight});
      }
      const valid=candidates.every(c=>c.text==='1'&&Number.isFinite(c.confidence)&&c.confidence>=75);
      glyphs.push({box,candidates,valid});
      if(!valid)return {valid:false,reason:'one_ocr_disagreement',glyphs};
    }
  }finally{await worker.setParameters({tessedit_char_whitelist:'0123456789.-',tessedit_pageseg_mode:'7'});}
  return {valid:true,text:'11',confidence:Math.min(...glyphs.flatMap(g=>g.candidates.map(c=>c.confidence))),reason:'two_complete_ones_and_ocr_agree',glyphs};
}
