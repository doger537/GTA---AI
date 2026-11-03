import sharp from 'sharp';
import {readFile} from 'node:fs/promises';
const decodedTemplates=new WeakMap();
function decodedGlyph(template){
  // JSON glyphs are immutable strings; mutable Buffer inputs must be decoded afresh.
  if(typeof template.glyph!=='string')return Buffer.from(template.glyph,'base64');
  let cached=decodedTemplates.get(template);if(!cached||cached.source!==template.glyph){cached={source:template.glyph,bytes:Buffer.from(template.glyph,'base64')};decodedTemplates.set(template,cached);}return cached.bytes;
}

export async function gearGlyph(bytes,profile){
  const m=await sharp(bytes).metadata(),roi={left:Math.round(profile.left*m.width),top:Math.round(profile.top*m.height),width:Math.round(profile.width*m.width),height:Math.round(profile.height*m.height)};
  const raw=await sharp(bytes).extract(roi).removeAlpha().toColourspace('srgb').raw().toBuffer(),mask=new Uint8Array(roi.width*roi.height);
  for(let i=0;i<mask.length;i++){const offset=i*3,r=raw[offset],g=raw[offset+1],b=raw[offset+2];mask[i]=(g>180&&b>180&&((g>r*1.05&&b>r*1.05)||Math.min(r,g,b)>210))?1:0;}
  const seen=new Uint8Array(mask.length),components=[];
  for(let i=0;i<mask.length;i++)if(mask[i]&&!seen[i]){const q=[i];seen[i]=1;let xmin=roi.width,xmax=0,ymin=roi.height,ymax=0;
    for(let k=0;k<q.length;k++){const p=q[k],x=p%roi.width,y=Math.floor(p/roi.width);xmin=Math.min(xmin,x);xmax=Math.max(xmax,x);ymin=Math.min(ymin,y);ymax=Math.max(ymax,y);
      for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){const nx=x+dx,ny=y+dy,j=ny*roi.width+nx;if(nx>=0&&nx<roi.width&&ny>=0&&ny<roi.height&&mask[j]&&!seen[j]){seen[j]=1;q.push(j);}}
    }if(ymax-ymin>=roi.height*.4&&Math.abs((xmin+xmax)/2-roi.width/2)<roi.width*.3)components.push({q,xmin,xmax,ymin,ymax});
  }
  components.sort((a,b)=>b.q.length-a.q.length);if(!components.length)return null;
  const c=components[0],width=c.xmax-c.xmin+1,height=c.ymax-c.ymin+1,ink=Buffer.alloc(width*height);
  for(const p of c.q)ink[(Math.floor(p/roi.width)-c.ymin)*width+p%roi.width-c.xmin]=255;
  return sharp(ink,{raw:{width,height,channels:1}}).resize(24,40,{fit:'fill',kernel:'linear'}).raw().toBuffer();
}
export function matchGearGlyph(glyph,templates,{exclude=null,min_score=.82,min_margin=.08}={}){
  if(!glyph)return {valid:false,value:null,reason:'no_gear_glyph'};
  const byClass=new Map();
  for(const t of templates){if(t.id===exclude)continue;const ref=decodedGlyph(t);if(ref.length!==glyph.length)throw Error('Gear template shape mismatch');let same=0,total=0;
    for(let i=0;i<ref.length;i++){same+=2*Math.min(ref[i],glyph[i]);total+=ref[i]+glyph[i];}const score=total?same/total:0;
    byClass.set(t.gear,Math.max(byClass.get(t.gear)??0,score));
  }
  const ranked=[...byClass].sort((a,b)=>b[1]-a[1]),best=ranked[0],margin=best?best[1]-(ranked[1]?.[1]??0):0;
  const valid=!!best&&best[1]>=min_score&&margin>=min_margin;
  return {valid,value:valid?best[0]:null,score:best?.[1]??0,margin,reason:valid?'shape_match':'shape_uncertain',source:'fixed_hud_templates'};
}
export async function loadGearTemplates(){return JSON.parse(await readFile(new URL('./models/gear-templates.json',import.meta.url))).templates;}
export function confirmGear(ocr,shape){
  if(ocr.valid)return ocr;
  if(shape.valid&&/^[RN1-8]$/.test(ocr.text)&&ocr.text===shape.value)return {...ocr,valid:true,value:shape.value,source:'ocr_shape_confirmation',shape_score:shape.score,shape_margin:shape.margin};
  return {...ocr,shape_rejected:true};
}
