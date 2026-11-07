// Offline road failure review. Predictions and overlays never become labels.
import {readFile,writeFile,mkdir}from'node:fs/promises';
import path from'node:path';
import sharp from'sharp';
import {Perception}from'../../packages/perception/perception.mjs';
import {roadGeometry}from'../../packages/navigation/road-guidance.mjs';
import {visibleRoadReachability}from'../../packages/perception/road-topology.mjs';
const root=path.resolve(process.argv[2]??''),session=JSON.parse(await readFile(path.join(root,'session.json'),'utf8'));
const samples=(await readFile(path.join(root,'samples.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
const n=Number(process.argv.find(a=>a.startsWith('--frames='))?.split('=')[1]??40);
if(session.source!=='single_capture'||!samples.length||!Number.isInteger(n)||n<1||n>500)throw Error('A single-capture session and 1..500 frames required');
const count=Math.min(n,samples.length),selected=Array.from({length:count},(_,i)=>samples[count===1?0:Math.floor(i*(samples.length-1)/(count-1))]);
const out=path.resolve(process.argv.find(a=>a.startsWith('--output='))?.slice(9)??`experiments/runs/road-review/${session.id}`);await mkdir(out,{recursive:true});
const rows=[];let vision;
try{vision=await Perception.load({cameraProfile:session.camera_declared});
 for(const r of selected){
  if(!/^\d{6}\.jpg$/.test(r.file))throw Error('Invalid recorded path');
  const bytes=await readFile(path.join(root,r.file)),p=await vision.analyze(bytes),s=p.semantic,w=s.gridWidth,h=s.gridHeight;
  const raw={...s,corridorRoad:undefined,corridorObstacle:undefined},before=roadGeometry(raw,'lane_follow'),after=roadGeometry(s,'lane_follow'),reachability=visibleRoadReachability(s);
  const rowEvidence=[];
  for(let y=Math.floor(.54*h);y>=Math.floor(.27*h);y--){
   let rawRoad=0,corridorRoad=0,obstacle=0;
   for(let x=Math.floor(.44*w);x<=Math.ceil(.56*w);x++){const i=y*w+x;rawRoad+=!!s.road[i];corridorRoad+=!!s.corridorRoad[i];obstacle+=!!s.corridorObstacle[i];}
   rowEvidence.push({y:(y+.5)/h,raw_road_pixels:rawRoad,corridor_road_pixels:corridorRoad,obstacle_pixels:obstacle});
  }
  const line=(g,color,width)=>g.valid?`<polyline points="${g.points.map(q=>`${q.x*p.width},${q.y*p.height}`).join(' ')}" stroke="${color}" stroke-width="${width}" fill="none"/>`:'';
  const svg=Buffer.from(`<svg width="${p.width}" height="${p.height}">${line(before,'orange',6)}${line(after,'cyan',3)}<rect x="${.44*p.width}" y="${.42*p.height}" width="${.12*p.width}" height="${.12*p.height}" stroke="yellow" fill="none" stroke-width="2"/></svg>`);
  await sharp(await vision.semantic.overlay(bytes,s)).composite([{input:svg}]).png().toFile(path.join(out,r.file+'.png'));
  rows.push({file:r.file,before,after,reachability,occlusion:s.occlusion,projected_center_rows:rowEvidence,camera_heading_verified:false});
 }
}finally{if(vision)await Promise.allSettled([vision.session.release(),vision.semantic.session.release()]);}
const summary={frames:rows.length,before_paths:rows.filter(r=>r.before.valid).length,after_paths:rows.filter(r=>r.after.valid).length,topology_reachable:rows.filter(r=>r.reachability.reachable).length,removed_road_pixels:rows.reduce((sum,r)=>sum+r.occlusion.removed_road_pixels,0)};
await writeFile(path.join(out,'report.json'),JSON.stringify({session:session.id,summary,legend:'Green: raw road retained for corridor; magenta: raw road removed by current vehicle occlusion; orange: old path; cyan: fused path; yellow: assumed seed band. Predictions only, no lane/heading/metric clearance verification or game input.',rows},null,2));console.log(JSON.stringify({out,summary},null,2));
