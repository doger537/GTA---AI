import{readFile,writeFile}from'node:fs/promises';import path from'node:path';
import{excludedByCamera}from'../../packages/perception/camera-profile.mjs';import{connectedRoadGeometry}from'../../packages/perception/road-corridor.mjs';import{percentiles}from'../../packages/protocols/latency-trace.mjs';
const root=path.resolve(process.argv[2]),annotations=JSON.parse(await readFile(process.argv[3],'utf8')),summaries={},details={};
for(const name of ['baseline-cpu','baseline-dml','gta','yolopv2']){
 const rows=[];
 for(const r of annotations.rows){
  const p=JSON.parse(await readFile(path.join(root,name,r.file+'.json'),'utf8')),w=p.gridWidth,h=p.gridHeight,raw=p.rawRoad??p.road,road=Uint8Array.from(p.corridorRoad??p.road),obstacle=Uint8Array.from(p.corridorObstacle??p.obstacle);
  if(raw.length!==w*h||obstacle.length!==w*h)throw Error('Mask dimensions do not match');
  if(!name.startsWith('baseline')){
   for(let y=0;y<h;y++)for(let x=0;x<w;x++)if(excludedByCamera((x+.5)/w,(y+.5)/h,'rear'))road[y*w+x]=0;
   for(const b of p.vehicles){if(![b.x,b.y,b.w,b.h].every(Number.isFinite))throw Error('Invalid vehicle box');for(let y=Math.max(0,Math.floor(b.y*h));y<Math.min(h,Math.ceil((b.y+b.h)*h));y++)for(let x=Math.max(0,Math.floor(b.x*w));x<Math.min(w,Math.ceil((b.x+b.w)*w));x++)obstacle[y*w+x]=1;}
   for(let i=0;i<road.length;i++)if(obstacle[i])road[i]=0;
  }
  const points=r.points.map(q=>{const i=Math.floor(q.y*h)*w+Math.floor(q.x*w);return {...q,raw_road:!!raw[i],corridor_road:!!road[i],obstacle:!!obstacle[i],ego_class:p.ego?!!p.ego[i]:null,vehicle_box:p.vehicles.some(b=>q.x>=b.x&&q.x<=b.x+b.w&&q.y>=b.y&&q.y<=b.y+b.h)};});
  const t=performance.now(),geometry=connectedRoadGeometry({gridWidth:w,gridHeight:h,road,obstacle},'lane_follow');
  rows.push({file:r.file,points,geometry,analysis_ms:p.analysis_ms,geometry_ms:performance.now()-t});
 }
 const scene=rows.flatMap(r=>r.points).filter(p=>p.source==='original_review'||!p.ego),positives=scene.filter(p=>p.road),negatives=scene.filter(p=>!p.road),ego=rows.flatMap(r=>r.points).filter(p=>p.source==='fixed_anchor_blinded_visual_review'&&p.ego),vehicles=scene.filter(p=>p.vehicle);
 summaries[name]={frames:rows.length,scene_points:scene.length,raw_scene_correct:scene.filter(p=>p.road===p.raw_road).length,corridor_scene_correct:scene.filter(p=>p.road===p.corridor_road).length,road_positive_points:positives.length,raw_road_detected:positives.filter(p=>p.raw_road).length,corridor_road_retained:positives.filter(p=>p.corridor_road).length,nonroad_points:negatives.length,raw_false_road:negatives.filter(p=>p.raw_road).length,corridor_false_road:negatives.filter(p=>p.corridor_road).length,ego_points:ego.length,raw_road_on_ego:ego.filter(p=>p.raw_road).length,corridor_road_on_ego:ego.filter(p=>p.corridor_road).length,ego_class_covered:name==='gta'?ego.filter(p=>p.ego_class).length:null,other_vehicle_points:vehicles.length,other_vehicle_box_covered:vehicles.filter(p=>p.vehicle_box).length,other_vehicle_obstacle_covered:vehicles.filter(p=>p.obstacle).length,geometric_paths:rows.filter(r=>r.geometry.valid).length,analysis_ms:percentiles(rows.map(r=>r.analysis_ms)),geometry_ms:percentiles(rows.map(r=>r.geometry_ms))};details[name]=rows;
}
await writeFile(path.join(root,'comparison.json'),JSON.stringify({scope:'Offline development, sparse point labels only. Native preprocessing/default thresholds differ across models. Raw mask and conservative corridor metrics separated. Baseline retains native semantic row-fill, candidates use their own obstacle masks plus boxes; camera exclusions and corridor solver shared. All timings exclude load/disk IO; CPU/DirectML not directly interchangeable. No driving or model promotion.',summaries,details},null,2));console.log(JSON.stringify(summaries,null,2));
