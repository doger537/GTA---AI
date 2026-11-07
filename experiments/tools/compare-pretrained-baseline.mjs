// Offline baseline export; no bridge or actuator imports.
import{readFile,writeFile,mkdir}from'node:fs/promises';import path from'node:path';
import{Perception}from'../../packages/perception/perception.mjs';
const root=path.resolve(process.argv[2]),out=path.resolve(process.argv[3]),provider=process.argv[4]??'dml';
const samples=(await readFile(path.join(root,'samples.jsonl'),'utf8')).trim().split('\n').map(JSON.parse),selected=Array.from({length:40},(_,i)=>samples[Math.floor(i*(samples.length-1)/39)]),vision=await Perception.load({provider,cameraProfile:'rear'});await mkdir(out,{recursive:true});
const rows=[];
try{const warm=await readFile(path.join(root,selected[0].file));for(let i=0;i<2;i++)await vision.analyze(warm);
for(const r of selected){const bytes=await readFile(path.join(root,r.file)),start=performance.now(),p=await vision.analyze(bytes),s=p.semantic;
const result={file:r.file,gridWidth:s.gridWidth,gridHeight:s.gridHeight,road:[...s.road],rawRoad:[...s.rawRoad],obstacle:[...s.obstacle],corridorRoad:[...s.corridorRoad],corridorObstacle:[...s.corridorObstacle],vehicles:p.vehicles,analysis_ms:performance.now()-start};
await writeFile(path.join(out,r.file+'.json'),JSON.stringify(result));rows.push({file:r.file,analysis_ms:result.analysis_ms});}
}finally{await Promise.allSettled([vision.session.release(),vision.semantic.session.release()]);}
await writeFile(path.join(out,'summary.json'),JSON.stringify({provider,warmup:2,rows},null,2));console.log(JSON.stringify({provider,frames:rows.length}));
