// Offline only. Fixed historical development data; never captures or sends input.
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {Perception} from '../../packages/perception/perception.mjs';
import {VehicleStateReader} from '../../packages/perception/vehicle-state.mjs';
import {hudProfile} from '../../packages/perception/hud-profile.mjs';
import {roadGeometry, guidanceGate} from '../../packages/navigation/road-guidance.mjs';
import {percentiles} from '../../packages/protocols/latency-trace.mjs';
import {regionCells, masks} from './evaluate-quality-regions.mjs';

const sessions = new Set(['2026-11-03T07-08-56.123Z', '2026-11-01T17-32-01-342Z']);
export function requireDevelopmentRoot(root) {
  if (!sessions.has(path.basename(path.resolve(root)))) throw Error('Only fixed development sessions allowed');
}
async function visionFor(mode) {
  const vision = await Perception.load({provider:'dml', cameraProfile:'rear'});
  const analyze = vision.semantic.analyze.bind(vision.semantic);
  vision.semantic.analyze = (bytes, opts) => analyze(bytes, {...opts, resizeMode:mode});
  return vision;
}
async function closeVision(v) { await Promise.allSettled([v.session.release(), v.semantic.session.release()]); }
const payload = p => {
  const s=p.semantic;
  return {gridWidth:s.gridWidth,gridHeight:s.gridHeight,rawRoad:[...s.rawRoad],road:[...s.road],obstacle:[...s.obstacle],corridorRoad:[...s.corridorRoad],corridorObstacle:[...s.corridorObstacle],vehicles:p.vehicles};
};
export async function runFollowup(output, {reverse=false,pipelineOnly=false}={}) {
  const order=reverse?['aspect','square']:['square','aspect'];
  await mkdir(output, {recursive:false});
  const labels=JSON.parse(await readFile('work/boundary-audit/regions-source-reviewed.json','utf8'));
  const cross=labels.rows.filter(r=>r.set==='other-session');
  if(cross.length!==8) throw Error('Expected frozen eight-frame comparison');
  const result={scope:'Offline historical development only; no held-out validation or input. Aspect parameters frozen.',cross:{},pipeline:{}};
  for(const mode of (pipelineOnly?[]:order)) {
    const v=await visionFor(mode), rows=[];
    await mkdir(`${output}/${mode}`);
    try {
      for(let i=0;i<2;i++) await v.analyze(await readFile(cross[0].root+'/'+cross[0].file));
      for(const f of cross) {
        requireDevelopmentRoot(f.root);
        const bytes=await readFile(f.root+'/'+f.file);
        if(createHash('sha256').update(bytes).digest('hex')!==f.sha256) throw Error('Frame hash mismatch');
        const p=payload(await v.analyze(bytes)),m=masks(p,false);
        await writeFile(`${output}/${mode}/${f.file}.json`,JSON.stringify(p));
        const regions=f.regions.map(r=>{const cells=regionCells(r.rect,m.w,m.h);return {...r,cells:cells.length,raw:cells.filter(i=>m.raw[i]).length,free:cells.filter(i=>m.road[i]).length,obstacle:cells.filter(i=>m.obstacle[i]).length};});
        rows.push({file:f.file,regions});
      }
    } finally { await closeVision(v); }
    const groups={};
    for(const r of rows.flatMap(r=>r.regions)) {
      const g=groups[r.label]??={patches:0,cells:0,raw:0,free:0,obstacle:0,fully_free:0};
      g.patches++; for(const k of ['cells','raw','free','obstacle'])g[k]+=r[k];
      if(r.free===r.cells)g.fully_free++;
    }
    result.cross[mode]={rows,groups};
    await writeFile(output+'/comparison.json',JSON.stringify(result,null,2));
    console.log(JSON.stringify({stage:'cross',mode,groups}));
  }
  const root='experiments/observation-recordings/2026-11-03T07-08-56.123Z';
  requireDevelopmentRoot(root);
  const samples=(await readFile(root+'/samples.jsonl','utf8')).trim().split('\n').map(JSON.parse);
  const selected=Array.from({length:40},(_,i)=>samples[Math.floor(i*(samples.length-1)/39)]);
  const data=await Promise.all(selected.map(async r=>({sample:r,road:await readFile(root+'/'+r.file),hud:await readFile(root+'/'+r.hud_file)})));
  for(const mode of order) {
    const v=await visionFor(mode), rows=[];
    try {
      for(let pass=0;pass<3;pass++) {
        const reader=await VehicleStateReader.create(hudProfile(data[0].sample.hud_geometry));
        const process=async d=>{
          const start=performance.now();let ocr_ms,vision_ms;
          const [state,p]=await Promise.all([
            reader.read(d.hud,d.sample.capture_start_ms).then(s=>{ocr_ms=performance.now()-start;return s;}),
            v.analyze(d.road).then(p=>{vision_ms=performance.now()-start;return p;})
          ]);
          const geometry=roadGeometry(p.semantic,'lane_follow');
          const analysis_ms=performance.now()-start;
          // Replay compute duration is a lower bound: current capture age is unavailable.
          const gate=guidanceGate({navigation:d.sample.navigation??null,state,geometry,age_ms:analysis_ms});
          return {file:d.sample.file,pass,analysis_ms:performance.now()-start,ocr_ms,vision_ms,geometry,state,gate};
        };
        try {
          for(let i=0;i<2;i++)await process(data[0]);
          reader.speed.previous=null;
          for(const d of data)rows.push(await process(d));
        } finally {await reader.close();}
        console.log(JSON.stringify({stage:'pipeline',mode,pass,frames:rows.length}));
      }
    } finally {await closeVision(v);}
    result.pipeline[mode]={rows,summary:{frames:rows.length,passes:3,warmups_per_pass:2,analysis_ms:percentiles(rows.map(r=>r.analysis_ms)),ocr_ms:percentiles(rows.map(r=>r.ocr_ms)),vision_ms:percentiles(rows.map(r=>r.vision_ms)),compute_over450:rows.filter(r=>r.analysis_ms>450).length,valid_speed:rows.filter(r=>r.state.speed.valid).length,geometry_candidates:rows.filter(r=>r.geometry.valid).length,drive_allowed:rows.filter(r=>r.gate.drive_allowed).length}};
    await writeFile(output+'/comparison.json',JSON.stringify(result,null,2));
    console.log(JSON.stringify({stage:'summary',mode,...result.pipeline[mode].summary}));
  }
  return result;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await runFollowup(process.argv[2],{reverse:process.argv.includes('--reverse'),pipelineOnly:process.argv.includes('--pipeline-only')});
