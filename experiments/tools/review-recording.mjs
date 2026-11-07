import {readFile,readdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
const dir=path.resolve(process.argv[2]??'');
const session=JSON.parse(await readFile(path.join(dir,'session.json'),'utf8'));
const rows=(await readFile(path.join(dir,'samples.jsonl'),'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
const quantile=(a,q)=>{const b=[...a].sort((x,y)=>x-y);return b.length?b[Math.floor((b.length-1)*q)]:null;};
const combinations={},keys={},failures=[];let stable=0;
for(const r of rows){
  if(!/^\d+\.jpg$/.test(r.file))throw Error('Unexpected image filename');
  try{await sharp(path.join(dir,r.file)).resize(1,1).raw().toBuffer();}catch{failures.push(r.file);}
  const same=JSON.stringify(r.keys_before)===JSON.stringify(r.keys_after);
  if(same&&r.label_stable){stable++;const combo=r.keys_before.join('+')||'none';combinations[combo]=(combinations[combo]??0)+1;for(const k of r.keys_before)keys[k]=(keys[k]??0)+1;}
}
const gaps=rows.slice(1).map((r,i)=>r.capture_start_ms-rows[i].capture_start_ms),durations=rows.map(r=>r.capture_end_ms-r.capture_start_ms);
const files=await readdir(dir);
const report={session,jpegs:files.filter(f=>/^\d+\.jpg$/.test(f)).length,rows:rows.length,stable,ambiguous:rows.length-stable,decode_failures:failures,monotonic:rows.every((r,i)=>Number.isFinite(r.capture_start_ms)&&r.capture_end_ms>=r.capture_start_ms&&(!i||r.capture_start_ms>rows[i-1].capture_start_ms&&r.sequence>rows[i-1].sequence)),gap_ms:{median:quantile(gaps,.5),p95:quantile(gaps,.95),max:Math.max(...gaps)},capture_ms:{median:quantile(durations,.5),p95:quantile(durations,.95)},stable_combinations:combinations,stable_key_counts:keys};
await writeFile(path.join(dir,'validation.json'),JSON.stringify(report,null,2));
const indices=new Set(Array.from({length:9},(_,i)=>Math.floor((rows.length-1)*i/8)));
for(const key of ['a','d','s','space']){const i=rows.findIndex(r=>r.label_stable&&r.keys_before.includes(key));if(i>=0)indices.add(i);}
const chosen=[...indices].sort((a,b)=>a-b),tiles=[];const height=205;
for(let i=0;i<chosen.length;i++){
  const r=rows[chosen[i]],thumb=await sharp(path.join(dir,r.file)).resize(320,175,{fit:'contain',background:'#111'}).png().toBuffer();
  const label=`${((r.capture_start_ms-rows[0].capture_start_ms)/1000).toFixed(1)}s | ${r.keys_before.join('+')||'none'} | ${r.label_stable?'stable':'transition'}`;
  const tile=await sharp({create:{width:320,height,channels:3,background:'#111'}}).composite([{input:thumb,top:0,left:0},{input:Buffer.from(`<svg width="320" height="30"><text x="5" y="21" fill="white" font-size="15">${label}</text></svg>`),top:175,left:0}]).png().toBuffer();
  tiles.push({input:tile,left:(i%3)*320,top:Math.floor(i/3)*height});
}
if(tiles.length)await sharp({create:{width:960,height:Math.ceil(tiles.length/3)*height,channels:3,background:'#111'}}).composite(tiles).jpeg({quality:90}).toFile(path.join(dir,'review.jpg'));
console.log(JSON.stringify(report,null,2));
