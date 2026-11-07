import sharp from 'sharp';
// Conservative structural check for the narrow HUD seven. This is a development
// fallback, not a general digit classifier or a calibrated probability.
export function sevenGlyph(source,width,height){
  let left=width,top=height,right=-1,bottom=-1;const ink=Buffer.alloc(width*height,255);
  for(let i=0;i<width*height;i++)if(Math.min(source[i*3],source[i*3+1],source[i*3+2])>210){ink[i]=0;const x=i%width,y=Math.floor(i/width);left=Math.min(left,x);right=Math.max(right,x);top=Math.min(top,y);bottom=Math.max(bottom,y);}
  const w=right-left+1,h=bottom-top+1;
  if(left<1||top<1||right>=width-1||bottom>=height-1||h<10||w<4||w/h<.2||w/h>.8)return null;
  const rows=[];for(let y=top;y<=bottom;y++){let first=width,last=-1,count=0;for(let x=left;x<=right;x++)if(ink[y*width+x]===0){first=Math.min(first,x);last=x;count++;}if(!count)return null;rows.push({span:last-first+1,count,center:(first+last)/2-left});}
  if(Math.max(...rows.slice(0,Math.max(2,Math.ceil(h*.15))).map(r=>r.span))<w*.8)return null;
  const stem=rows.slice(Math.ceil(h*.2));
  if(stem.some(r=>r.span>w*.5||r.count!==r.span))return null;
  for(let i=1;i<stem.length;i++)if(stem[i].center>stem[i-1].center+1)return null;
  if(stem[0].center-stem.at(-1).center<w*.3)return null;
  return {ink,left,top,width:w,height:h};
}
export async function confirmSingleGlyph(worker,source,width,height){
  const glyph=sevenGlyph(source,width,height);if(!glyph)return {valid:false,candidates:[],reason:'not_supported_single_glyph'};
  const candidates=[];
  try{
    await worker.setParameters({tessedit_char_whitelist:'0123456789',tessedit_pageseg_mode:'8'});
    for(const renderHeight of [60,100]){
      const crop=await sharp(glyph.ink,{raw:{width,height,channels:1}}).extract({left:glyph.left,top:glyph.top,width:glyph.width,height:glyph.height}).resize({width:Math.round(glyph.width/glyph.height*renderHeight),height:renderHeight,kernel:'nearest'}).extend({top:20,bottom:20,left:20,right:20,background:'white'}).png().toBuffer();
      const {data}=await worker.recognize(crop);candidates.push({text:data.text.trim(),confidence:data.confidence,height:renderHeight});
    }
  }finally{await worker.setParameters({tessedit_char_whitelist:'0123456789.-',tessedit_pageseg_mode:'7'});}
  const valid=candidates.length===2&&candidates.every(c=>c.text==='7'&&c.confidence>=75);
  return {valid,text:valid?'7':'',confidence:valid?Math.min(...candidates.map(c=>c.confidence)):0,candidates,reason:valid?'ocr_and_seven_structure_agree':'glyph_ocr_disagreement'};
}
