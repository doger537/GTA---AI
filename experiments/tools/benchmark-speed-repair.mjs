// Existing labelled frames are regression/development data, not new held-out trips.
import sharp from 'sharp';import{readFile,writeFile,mkdir}from'node:fs/promises';import{pathToFileURL}from'node:url';import path from'node:path';
import{SpeedReader}from'../../packages/perception/speed-reader.mjs';import{hudProfile}from'../../packages/perception/hud-profile.mjs';
const baseline=process.argv.find(a=>a.startsWith('--baseline='))?.slice(11);if(!baseline)throw Error('Pass --baseline=PATH_TO_UNCHANGED_SPEED_READER');
const Old=(await import(pathToFileURL(path.resolve(baseline)))).SpeedReader;
const labels=JSON.parse(await readFile('fixtures/gear-labels.json')),rows=[];
let old,next,key;
async function check(bytes,geometry,label,metadata){
  const profile=hudProfile(geometry).speed,current=JSON.stringify(profile);if(current!==key){if(old)await Promise.all([old.close(),next.close()]);old=await Old.create(profile);next=await SpeedReader.create(profile);key=current;}
  old.previous=null;next.previous=null;const before=await old.read(bytes,100),after=await next.read(bytes,100);rows.push({...metadata,label,before,after});
}
try{
  for(const row of labels.rows){const bytes=await readFile(`experiments/recordings/${row.session}/${row.file}`),meta=await sharp(bytes).metadata(),left=Math.floor(meta.width*.82),top=Math.floor(meta.height*.76),width=Math.ceil(meta.width*.95)-left,height=Math.ceil(meta.height*.90)-top,geometry={full_width:meta.width,full_height:meta.height,left,top,width,height};const hud=await sharp(bytes).extract({left,top,width,height}).png().toBuffer();await check(hud,geometry,row.speed,{session:row.session,file:row.file,role:'existing_regression',split:row.split});}
  const geometry=JSON.parse(await readFile('fixtures/native-hud/geometry.json'));for(const [name,label]of [['zero',0],['five',5],['seven',7]])await check(await readFile(`fixtures/native-hud/${name}.png`),geometry,label,{session:'native-hud-known-development',file:name+'.png',role:'known_development'});
}finally{if(old)await Promise.all([old.close(),next.close()]);}
const labelled=rows.filter(r=>Number.isFinite(r.label)),allRows=rows;const metrics=field=>{const rows=labelled;return ({frames:rows.length,accepted:rows.filter(r=>r[field].valid).length,correct:rows.filter(r=>r[field].valid&&r[field].kmh===r.label).length,wrong:rows.filter(r=>r[field].valid&&r[field].kmh!==r.label).length,unknown:rows.filter(r=>!r[field].valid).length,false_zero:rows.filter(r=>r.label>0&&r[field].valid&&r[field].kmh===0).length});};
const summary={unlabelled:allRows.length-labelled.length,before:metrics('before'),after:metrics('after'),changed:rows.filter(r=>r.before.valid!==r.after.valid||r.before.kmh!==r.after.kmh).map(r=>({file:r.file,session:r.session,label:r.label,before:r.before.kmh,after:r.after.kmh})),sessions:[...new Set(rows.map(r=>r.session))]};
await mkdir('experiments/runs/moving-perception',{recursive:true});await writeFile('experiments/runs/moving-perception/speed-regression.json',JSON.stringify({scope:'Previously inspected labelled data; native HUD cropped losslessly from decoded JPEG for old recordings. Not an independent validation of the seven fix.',summary,rows},null,2));console.log(JSON.stringify(summary,null,2));
