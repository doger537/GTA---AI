import {readFile,writeFile,mkdir} from 'node:fs/promises';import sharp from 'sharp';import {fileURLToPath} from 'node:url';
import {SemanticRoad} from '../../packages/perception/semantic-road.mjs';import {roadGeometry} from '../../packages/navigation/road-guidance.mjs';import {roadGeometry as legacy} from '../../packages/control/road-guidance-v1.mjs';
const cases=JSON.parse(await readFile(new URL('../../fixtures/corridor-cases.json',import.meta.url))),s=await SemanticRoad.load(),results=[];
const dir=new URL(`../runs/corridor/${new Date().toISOString().replaceAll(':','-')}/`,import.meta.url);await mkdir(dir,{recursive:true});
try{for(const c of cases){
  const bytes=await readFile(new URL(`../recordings/${c.session}/${c.file}`,import.meta.url)),p=await s.analyze(bytes,{cameraProfile:'rear'}),before=legacy(p,'lane_follow'),t=performance.now(),after=roadGeometry(p,'lane_follow'),geometry_ms=performance.now()-t;
  const line=(g,color,width)=>g.valid?`<polyline points="${g.points.map(q=>`${q.x*p.width},${q.y*p.height}`).join(' ')}" fill="none" stroke="${color}" stroke-width="${width}"/>`:'';
  const svg=Buffer.from(`<svg width="${p.width}" height="${p.height}">${line(before,'orange',6)}${line(after,'cyan',3)}</svg>`),name=c.session+'-'+c.file;
  await sharp(await s.overlay(bytes,p)).composite([{input:svg}]).jpeg({quality:90}).toFile(fileURLToPath(new URL(name,dir)));
  results.push({...c,before,after,inference_ms:p.inference_ms,geometry_ms,overlay:name,driving_heading_verified:false});
}}finally{await s.session.release();}
const report={scope:'Development comparisons on eight saved frames, no pixel ground-truth or independent driving validation. Orange: old line; cyan: connected path. Road mask unchanged. Camera yaw unverified; a visible path may not match vehicle heading.',total:results.length,before_paths:results.filter(r=>r.before.valid).length,after_paths:results.filter(r=>r.after.valid).length,results};
await writeFile(new URL('report.json',dir),JSON.stringify(report,null,2));console.log(JSON.stringify({report:fileURLToPath(new URL('report.json',dir)),total:report.total,before_paths:report.before_paths,after_paths:report.after_paths,geometry_ms_mean:results.reduce((s,x)=>s+x.geometry_ms,0)/results.length},null,2));
