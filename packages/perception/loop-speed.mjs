import sharp from 'sharp';

// Only a complete, isolated 6 or 8. Topology confirms two OCR views; it never
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
  const text=holes.length===1&&holes[0].centerY>.55?'6':holes.length===2&&holes[0].centerY<.5&&holes[1].centerY>.5?'8':null;
  return text?{text,holes,box:{left,top,width:w,height:h}}:null;
}

export async function confirmLoopSpeed(worker,source,width,height,wholeViews=[]){
  const glyph=loopSpeedGlyph(source,width,height);
  if(!glyph)return {valid:false,reason:'not_isolated_six_or_eight',candidates:[]};
  if(wholeViews.some(v=>v&&/^\d{1,3}$/.test(v.text)&&Number.isFinite(v.confidence)&&v.confidence>=75&&v.text!==glyph.text))return {valid:false,reason:'conflicting_whole_speed',candidates:[]};
  const candidates=[];
  try{
    await worker.setParameters({tessedit_char_whitelist:'0123456789',tessedit_pageseg_mode:'8'});
    for(const mode of ['white','cyan']){
      const ink=Buffer.alloc(width*height,255);let left=width,top=height,right=-1,bottom=-1;
      for(let i=0;i<ink.length;i++){
        const r=source[i*3],g=source[i*3+1],b=source[i*3+2];
        const on=mode==='white'?Math.min(r,g,b)>210:((g>180&&b>180&&b>r+10&&g>r+10)||Math.min(r,g,b)>220);
        if(on){ink[i]=0;left=Math.min(left,i%width);right=Math.max(right,i%width);top=Math.min(top,Math.floor(i/width));bottom=Math.max(bottom,Math.floor(i/width));}
      }
      if(left<1||top<1||right>=width-1||bottom>=height-1||right<left||bottom<top)return {valid:false,reason:'incomplete_loop_view',candidates};
      const image=await sharp(ink,{raw:{width,height,channels:1}}).extract({left,top,width:right-left+1,height:bottom-top+1}).resize({height:100,kernel:'nearest'}).extend({top:20,bottom:20,left:20,right:20,background:'white'}).png().toBuffer();
      const {data}=await worker.recognize(image);candidates.push({mode,text:data.text.trim(),confidence:data.confidence});
    }
  }finally{await worker.setParameters({tessedit_char_whitelist:'0123456789.-',tessedit_pageseg_mode:'7'});}
  const valid=candidates.length===2&&candidates.every(c=>c.text===glyph.text&&Number.isFinite(c.confidence)&&c.confidence>=75);
  return {valid,text:valid?glyph.text:'',confidence:valid?Math.min(...candidates.map(c=>c.confidence)):0,candidates,reason:valid?'closed_loops_and_two_ocr_views_agree':'loop_ocr_disagreement'};
}
