// Fitting uses manual speed labels only. No OCR-generated or inferred labels.
import {readFile,writeFile,mkdir,access}from'node:fs/promises';
import path from'node:path';
import sharp from'sharp';
import {hudProfile}from'./hud-profile.mjs';
import {extractHudDigits,digitVector,digitSimilarity,DIGIT_WIDTH,DIGIT_HEIGHT,decodeDigitModel,matchHudDigits}from'./hud-digit-model.mjs';
const root=path.resolve(process.argv[2]??''),out=path.resolve(process.argv.find(a=>a.startsWith('--output='))?.slice(9)??`runs/hud-digits/${new Date().toISOString().replaceAll(':','-')}/model.json`);
for(const file of [out,out+'.report.json']){try{await access(file);}catch(e){if(e.code==='ENOENT')continue;throw e;}throw Error('Output already exists; choose a new path: '+file);}
const session=JSON.parse(await readFile(path.join(root,'session.json'),'utf8'));
if(session.id==='2026-11-02T07-43-54-725Z'||session.role!=='development'||session.source!=='single_capture')throw Error('Only an explicitly development single-capture trip may be fitted; protected validation data is forbidden');
const annotations=await Promise.all(['annotations.json','annotations-seven-targeted.json'].map(async file=>{
 const a=JSON.parse(await readFile(path.join(root,file),'utf8'));if(a.session!==session.id)throw Error('Annotation session mismatch');return a.rows;
}));
const labels=new Map();for(const r of annotations.flat()){
 if(!/^\d{6}\.jpg$/.test(r.file)||!Number.isInteger(r.speed)||r.speed<1||r.speed>200)continue;
 if(labels.has(r.file)&&labels.get(r.file)!==r.speed)throw Error('Conflicting manual speed labels');labels.set(r.file,r.speed);
}
const samples=(await readFile(path.join(root,'samples.jsonl'),'utf8')).trim().split('\n').map(JSON.parse),geometry=samples[0].hud_geometry,r=hudProfile(geometry).speed;
const roi={left:Math.round(r.left*geometry.width),top:Math.round(r.top*geometry.height),width:Math.round(r.width*geometry.width),height:Math.round(r.height*geometry.height)};
const entries=[];
for(const [file,speed]of [...labels].sort()){
 const raw=await sharp(await readFile(path.join(root,file.replace('.jpg','-hud.png')))).extract(roi).removeAlpha().raw().toBuffer(),glyphs=extractHudDigits(raw,roi.width,roi.height);
 entries.push({file,speed,raw,glyphs,frame:Number(file.slice(0,6))});
}
const fitting=entries.filter(e=>e.frame<=399),groups=Array.from({length:10},()=>[]);
for(const e of fitting){
 const text=String(e.speed);if(!e.glyphs||e.glyphs.boxes.length!==text.length)continue;
 e.glyphs.boxes.forEach((box,i)=>groups[Number(text[i])].push({vector:digitVector(e.glyphs,box),file:e.file}));
}
const prototypes=[];
for(let digit=0;digit<10;digit++){
 const examples=[...new Map(groups[digit].map(e=>[Buffer.from(e.vector).toString('base64'),e])).values()];
 if(!examples.length)throw Error(`No manually labelled training examples for ${digit}`);
 const central=examples.map(e=>({e,score:examples.reduce((s,q)=>s+digitSimilarity(e.vector,q.vector),0)})).sort((a,b)=>b.score-a.score)[0].e;
 const chosen=[central];
 while(chosen.length<Math.min(4,examples.length)){
  const next=examples.filter(e=>!chosen.includes(e)).map(e=>({e,d:Math.max(...chosen.map(p=>digitSimilarity(e.vector,p.vector)))})).sort((a,b)=>a.d-b.d)[0].e;chosen.push(next);
 }
 for(const e of chosen)prototypes.push({digit:String(digit),file:e.file,vector:Buffer.from(e.vector).toString('base64')});
}
const json={version:1,width:DIGIT_WIDTH,height:DIGIT_HEIGHT,input:{width:roi.width,height:roi.height},min_score:.90,min_margin:.08,prototypes,training:{session:session.id,manual_label_files:['annotations.json','annotations-seven-targeted.json'],max_frame:399,excluded_gap:'400..465',check_min_frame:466,frames:fitting.length,digit_examples:groups.map(g=>g.length),scope:'One development trip; targeted labels and correlated frames. Later time block is diagnostic, not independent session validation.'}};
const model=decodeDigitModel(json),rows=entries.map(e=>({file:e.file,speed:e.speed,split:e.frame<=399?'fit':e.frame>=466?'later_block':'gap',match:matchHudDigits(e.raw,roi.width,roi.height,model)})),summary={};
for(const split of ['fit','later_block','gap']){const selected=rows.filter(r=>r.split===split),accepted=selected.filter(r=>r.match.valid);summary[split]={frames:selected.length,accepted:accepted.length,correct:accepted.filter(r=>Number(r.match.text)===r.speed).length,wrong:accepted.filter(r=>Number(r.match.text)!==r.speed).length};}
await mkdir(path.dirname(out),{recursive:true});await writeFile(out,JSON.stringify(json,null,2),{flag:'wx'});await writeFile(out+'.report.json',JSON.stringify({summary,rows},null,2),{flag:'wx'});console.log(JSON.stringify({model:out,prototypes:prototypes.length,summary},null,2));
