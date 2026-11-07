import sharp from 'sharp';import{readFile,writeFile,mkdir}from'node:fs/promises';
import{SpeedReader}from'../../packages/perception/speed-reader.mjs';import{hudProfile}from'../../packages/perception/hud-profile.mjs';
const profile=hudProfile(JSON.parse(await readFile('fixtures/native-hud/geometry.json'))).speed,reader=await SpeedReader.create(profile),rows=[];
try{for(const name of ['zero','five','seven']){
  await reader.worker.setParameters({tessedit_char_whitelist:'0123456789'});const bytes=await readFile('fixtures/native-hud/'+name+'.png'),meta=await sharp(bytes).metadata(),roi={left:Math.round(profile.left*meta.width),top:Math.round(profile.top*meta.height),width:Math.round(profile.width*meta.width),height:Math.round(profile.height*meta.height)};
  reader.previous=null;const baseline=await reader.read(bytes,100);const raw=await sharp(bytes).extract(roi).removeAlpha().toColourspace('srgb').raw().toBuffer();
  const views=[];
  for(const mode of ['white','gray']){let xmin=roi.width,ymin=roi.height,xmax=-1,ymax=-1;const ink=Buffer.alloc(roi.width*roi.height,255);
    for(let i=0;i<ink.length;i++){const r=raw[i*3],g=raw[i*3+1],b=raw[i*3+2],on=Math.min(r,g,b)>210;if(on){ink[i]=0;xmin=Math.min(xmin,i%roi.width);xmax=Math.max(xmax,i%roi.width);ymin=Math.min(ymin,Math.floor(i/roi.width));ymax=Math.max(ymax,Math.floor(i/roi.width));}}
    if(xmax<xmin)continue;
    for(const height of [60,100,150]){const image=await (mode==='gray'?sharp(raw,{raw:{width:roi.width,height:roi.height,channels:3}}).grayscale().normalize().negate():sharp(ink,{raw:{width:roi.width,height:roi.height,channels:1}})).extract({left:xmin,top:ymin,width:xmax-xmin+1,height:ymax-ymin+1}).resize({width:Math.round((xmax-xmin+1)/(ymax-ymin+1)*height),height,kernel:'nearest'}).extend({top:20,bottom:20,left:20,right:20,background:'white'}).png().toBuffer();
      for(const psm of ['7','8','10','13']){await reader.worker.setParameters({tessedit_pageseg_mode:psm});const d=(await reader.worker.recognize(image)).data;views.push({mode,height,psm,text:d.text.trim(),confidence:d.confidence});}
    }
  }rows.push({name,baseline,views});await reader.worker.setParameters({tessedit_pageseg_mode:'7'});
}}finally{await reader.close();}
await mkdir('../../work/perception',{recursive:true});await writeFile('../../work/perception/native-speed-probe.json',JSON.stringify(rows,null,2));console.log(JSON.stringify(rows,null,2));
