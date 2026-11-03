import sharp from 'sharp';

export function agreeSpeedViews(candidates){
  const votes=new Map();
  for(const c of candidates){if(!c||!['gray','mask','cyan'].includes(c.family)||!/^\d{1,3}$/.test(c.text)||!Number.isFinite(c.confidence)||c.confidence<75||Number(c.text)>200)continue;const key=String(Number(c.text));if(!votes.has(key))votes.set(key,new Map());const group=votes.get(key);group.set(c.family,Math.max(group.get(c.family)??0,c.confidence));}
  const supported=[...votes].filter(([,families])=>families.size>=2);
  if(supported.length!==1)return {valid:false,text:'',confidence:0};
  const [text,families]=supported[0];return {valid:true,text,confidence:Math.min(...families.values())};
}

// Two fixed development-selected views. Agreement is not a calibrated probability.
export async function paddedSpeedConsensus(worker,bytes,roi,meta){
  const px=Math.max(1,Math.round(meta.width/640)),py=Math.max(1,Math.round(meta.height/668));
  const left=Math.max(0,roi.left-px),top=Math.max(0,roi.top-py);
  const box={left,top,width:Math.min(meta.width-left,roi.width+2*px),height:Math.min(meta.height-top,roi.height+2*py)};
  const raw=await sharp(bytes).extract(box).removeAlpha().toColourspace('srgb').raw().toBuffer(),candidates=[];
  try{for(const mode of ['cyan','mask']){
    const ink=Buffer.alloc(box.width*box.height,255);let xmin=box.width,ymin=box.height,xmax=-1,ymax=-1;
    for(let i=0;i<ink.length;i++){
      const offset=i*3,r=raw[offset],g=raw[offset+1],b=raw[offset+2];
      const on=mode==='cyan'?((g>180&&b>180&&b>r+10&&g>r+10)||Math.min(r,g,b)>220):((Math.min(r,g,b)>185&&Math.max(r,g,b)-Math.min(r,g,b)<75)||(g>170&&b>175&&g>r*1.08&&b>r*1.08));
      if(on){ink[i]=0;xmin=Math.min(xmin,i%box.width);xmax=Math.max(xmax,i%box.width);ymin=Math.min(ymin,Math.floor(i/box.width));ymax=Math.max(ymax,Math.floor(i/box.width));}
    }
    if(xmax<xmin){candidates.push({mode,text:'',confidence:0});continue;}
    const crop=await sharp(ink,{raw:{width:box.width,height:box.height,channels:1}}).extract({left:xmin,top:ymin,width:xmax-xmin+1,height:ymax-ymin+1}).resize({height:150,kernel:'lanczos3'}).extend({top:30,bottom:30,left:30,right:30,background:'white'}).png().toBuffer();
    await worker.setParameters({tessedit_pageseg_mode:mode==='cyan'?'7':'8'});
    const {data}=await worker.recognize(crop);candidates.push({mode,text:data.text.trim(),confidence:data.confidence});
  }}finally{await worker.setParameters({tessedit_pageseg_mode:'7'});}
  const [a,b]=candidates,valid=candidates.every(x=>/^\d{1,3}$/.test(x.text)&&x.confidence>=75)&&a.text===b.text&&Number(a.text)<=200;
  return {valid,text:valid?a.text:'',confidence:valid?Math.min(a.confidence,b.confidence):0,candidates};
}
