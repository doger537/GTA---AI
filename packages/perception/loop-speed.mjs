import sharp from 'sharp';

// Only a complete, isolated 6, 8 or 9. Topology confirms two OCR views; it never
// assigns a number to a blank crop, open/clipped glyph or unsupported digit.
export function loopSpeedGlyph(source,width,height){
  if(!Number.isInteger(width)||!Number.isInteger(height)||width<3||height<10||source.length!==width*height*3)return null;
  const ink=new Uint8Array(width*height);let left=width,top=height,right=-1,bottom=-1;
  for(let i=0;i<ink.length;i++)if(Math.min(source[i*3],source[i*3+1],source[i*3+2])>210){ink[i]=1;left=Math.min(left,i%width);right=Math.max(right,i%width);top=Math.min(top,Math.floor(i/width));bottom=Math.max(bottom,Math.floor(i/width));}
  const w=right-left+1,h=bottom-top+1;
  if(left<1||top<1||right>=width-1||bottom>=height-1||h<10||w<4||w/h<.2||w/h>.8)return null;
  const visited=new Uint8Array(ink.length),holes=[];let components=0;
  for(let y=top;y<=bottom;y++)for(let x=left;x<=right;x++){
    const seed=y*width+x;if(visited[seed])continue;const value=ink[seed],queue=[seed];visited[seed]=1;let edge=false,sumY=0;
    for(let j=0;j<queue.length;j++){
      const i=queue[j],xx=i%width,yy=Math.floor(i/width);sumY+=yy;if(xx===left||xx===right||yy===top||yy===bottom)edge=true;
      for(const [nx,ny]of [[xx-1,yy],[xx+1,yy],[xx,yy-1],[xx,yy+1]]){if(nx<left||nx>right||ny<top||ny>bottom)continue;const next=ny*width+nx;if(!visited[next]&&ink[next]===value){visited[next]=1;queue.push(next);}}
    }
    if(value)components++;else if(!edge&&queue.length>=2)holes.push({area:queue.length,centerY:(sumY/queue.length-top)/h});
  }
  if(components!==1)return null;
  holes.sort((a,b)=>a.centerY-b.centerY);
  // Nine has an upper loop and a right-hand descending stroke. An upper loop
  // with a left stem (P-like ink) must not become a nine.
  let rightTail=true;
  for(let y=top+Math.ceil(h*.55);y<top+Math.floor(h*.8);y++){
    let last=-1;for(let x=left;x<=right;x++)if(ink[y*width+x])last=x;
    if(last<left+w*.5)rightTail=false;
  }
  const text=holes.length===1&&holes[0].centerY>.55?'6':holes.length===1&&holes[0].centerY<.45&&rightTail?'9':holes.length===2&&holes[0].centerY<.5&&holes[1].centerY>.5?'8':null;
  return text?{text,holes,box:{left,top,width:w,height:h}}:null;
}

export async function confirmLoopSpeed(worker,source,width,height,wholeViews=[]){
  const glyph=loopSpeedGlyph(source,width,height);
  if(!glyph)return {valid:false,reason:'not_isolated_loop_digit',candidates:[]};
  if(wholeViews.some(v=>v&&/^\d{1,3}$/.test(v.text)&&Number.isFinite(v.confidence)&&v.confidence>=75&&v.text!==glyph.text))return {valid:false,reason:'conflicting_whole_speed',candidates:[]};
  const candidates=[],ink=Buffer.alloc(width*height,255);
  for(let i=0;i<ink.length;i++)if(Math.min(source[i*3],source[i*3+1],source[i*3+2])>210)ink[i]=0;
  // Preserve the verified white contour. Cyan glow can close an extra hole in
  // six. Fixed raster sizes confirm it without a search for favourable output.
  // Rotate nine to the six orientation before OCR, retaining its original
  // topology and right tail as the evidence for mapping the result back to 9.
  const rotation=glyph.text==='9'?180:0,expected=rotation?'6':glyph.text;
  const isolated=await sharp(ink,{raw:{width,height,channels:1}}).extract(glyph.box).png().toBuffer();
  try{
    await worker.setParameters({tessedit_char_whitelist:'0123456789',tessedit_pageseg_mode:'8'});
    for(const renderHeight of [80,100]){
      const image=await sharp(isolated).rotate(rotation).resize({height:renderHeight,...(rotation?{width:Math.round(renderHeight*.6),fit:'fill'}:{}),kernel:'nearest'}).extend({top:20,bottom:20,left:20,right:20,background:'white'}).png().toBuffer();
      const {data}=await worker.recognize(image);candidates.push({mode:'white',height:renderHeight,rotation,text:data.text.trim(),confidence:data.confidence});
    }
  }finally{await worker.setParameters({tessedit_char_whitelist:'0123456789.-',tessedit_pageseg_mode:'7'});}
  const valid=candidates.length===2&&candidates.every(c=>c.text===expected&&Number.isFinite(c.confidence)&&c.confidence>=75);
  return {valid,text:valid?glyph.text:'',confidence:valid?Math.min(...candidates.map(c=>c.confidence)):0,candidates,reason:valid?'closed_loops_and_two_ocr_views_agree':'loop_ocr_disagreement'};
}
