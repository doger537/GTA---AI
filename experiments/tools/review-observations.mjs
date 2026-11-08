// Pixel-only contact sheets, intentionally omit predictions during manual review.
import sharp from 'sharp';import{readFile,mkdir,writeFile,access}from'node:fs/promises';import path from'node:path';
import {fileURLToPath} from 'node:url';import {createHash} from 'node:crypto';
const root=path.resolve(process.argv[2]??''),n=40,rows=(await readFile(path.join(root,'samples.jsonl'),'utf8')).trim().split('\n').map(JSON.parse),session=JSON.parse(await readFile(path.join(root,'session.json'),'utf8'));
if(rows.length<n)throw Error('At least forty frames required for this review protocol');
const selected=Array.from({length:n},(_,i)=>rows[Math.floor(i*(rows.length-1)/(n-1))]),allFiles=await Promise.all(rows.flatMap(r=>[r.file,r.hud_file,r.minimap_file]).map(f=>access(path.join(root,f)).then(()=>true,()=>false)));
for(let i=0;i<rows.length;i++){const r=rows[i];if(r.capture_start_ms>r.capture_end_ms||r.capture_skew_ms!==0||i&&(r.sequence<=rows[i-1].sequence||r.capture_start_ms<=rows[i-1].capture_start_ms))throw Error('Invalid recording timeline');}
const outputArg=process.argv.find(a=>a.startsWith('--out='))?.slice(6);
const destination=outputArg?path.resolve(outputArg):fileURLToPath(new URL('../../work/perception/review-'+session.id,import.meta.url));
await mkdir(path.dirname(destination),{recursive:true});await mkdir(destination);
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const labels=[];
for(const r of selected){
  const images={};
  for(const [kind,file]of [['road',r.file],['hud',r.hud_file],['minimap',r.minimap_file]]){
    if(typeof file!=='string'||path.basename(file)!==file||!/^\d+(?:-(?:hud|map))?\.(?:jpg|png)$/.test(file))throw Error('Invalid source image name');
    images[kind]={file,sha256:sha(await readFile(path.join(root,file)))};
  }
  labels.push({sequence:r.sequence,generation:r.generation,capture_start_ms:r.capture_start_ms,capture_end_ms:r.capture_end_ms,images,reviewed:false,speed_kmh:null,gear:null,camera:'unknown',vehicle_visible:'unknown',note:''});
}
await writeFile(path.join(destination,'labels.json'),JSON.stringify({schema_version:1,session_id:session.id,role:session.role,source_root:root,selection:'40 uniformly spaced source frames, fixed before predictions',predictions_included:false,review_status:'unreviewed',labels},null,2),{flag:'wx'});
for(let page=0;page<2;page++)for(const kind of ['hud','road']){
  const w=kind==='hud'?372:384,h=kind==='hud'?210:200,cell=h+30,composites=[];
  for(let j=0;j<20;j++){const r=selected[page*20+j],bytes=await sharp(path.join(root,kind==='hud'?r.hud_file:r.file)).resize(w,h,{kernel:kind==='hud'?'nearest':'lanczos3'}).png().toBuffer();const label=Buffer.from(`<svg width="${w}" height="30"><rect width="100%" height="100%" fill="white"/><text x="8" y="22" font-size="18" fill="black">${page*20+j}: ${r.file}</text></svg>`);composites.push({input:label,left:(j%4)*w,top:Math.floor(j/4)*cell},{input:bytes,left:(j%4)*w,top:Math.floor(j/4)*cell+30});}
  await sharp({create:{width:w*4,height:cell*5,channels:3,background:'white'}}).composite(composites).png().toFile(path.join(destination,kind+'-'+page+'.png'));
}
const intervals=rows.slice(1).map((r,i)=>r.capture_start_ms-rows[i].capture_start_ms),sum=intervals.reduce((a,b)=>a+b,0),sorted=[...intervals].sort((a,b)=>a-b);
const integrity={session:session.id,status:session.status,frames:rows.length,expected_image_files:rows.length*3,missing_files:allFiles.filter(x=>!x).length,recorded_span_ms:rows.at(-1).capture_start_ms-rows[0].capture_start_ms,mean_fps:1000/(sum/intervals.length),gap_p95_ms:sorted[Math.ceil(sorted.length*.95)-1],max_gap_ms:sorted.at(-1),capture_skew_ms:0,max_recorded_age_ms:Math.max(...rows.map(r=>r.age_ms)),focus_pauses:session.focus_pauses,selected:selected.map(r=>r.file)};
await writeFile(path.join(destination,'integrity.json'),JSON.stringify(integrity,null,2));console.log(JSON.stringify({destination,integrity},null,2));
