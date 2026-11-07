// Offline only. Usage from repo root:
// node experiments/tools/benchmark-perception-ablation.mjs MANIFEST.json NEW_OUTPUT_DIR
// Manifest: {scope, frames:[{root,file,sha256,primary,baseline?}], labels:PATH}.
// Baseline is an optional saved square semantic JSON, not a ground-truth label.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {Perception} from '../../packages/perception/perception.mjs';
import {offlineYolopGrid} from '../../packages/perception/offline-yolop-grid.mjs';
import {connectedRoadGeometry} from '../../packages/perception/road-corridor.mjs';
import {regionCells,masks} from './evaluate-quality-regions.mjs';
import {LatencyTrace,percentiles} from '../../packages/protocols/latency-trace.mjs';

const variants={A:{size:640,roadModel:'semantic'},B:{size:320,roadModel:'semantic'},C:{size:320,roadModel:'yolop'}};
const order=['A','B','C','C','B','A'];
const maskKeys=['rawRoad','road','obstacle','corridorRoad','corridorObstacle'];
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const key=f=>`${resolve(f.root)}/${f.file}`;
const json=async(path,value)=>writeFile(path,JSON.stringify(value,null,2));

function snapshot(p,grid){
  return {gridWidth:grid.gridWidth,gridHeight:grid.gridHeight,vehicles:p.vehicles,
    ...Object.fromEntries([...maskKeys,...(grid.labels?['labels']:[])].map(k=>[k,[...grid[k]]]))};
}

function qualityOf(frame,prediction,geometry,labels){
  const m=masks(prediction,false);
  return {root:frame.root,file:frame.file,set:labels.set,geometric_candidate:geometry.valid,geometry_reason:geometry.reason??'candidate',
    regions:labels.regions.map(r=>{
      const cells=regionCells(r.rect,m.w,m.h);
      return {...r,cells:cells.length,rawRoad:cells.filter(i=>m.raw[i]).length,free:cells.filter(i=>m.road[i]).length,obstacle:cells.filter(i=>m.obstacle[i]).length};
    })};
}

function summarizeQuality(rows){
  const groups={};
  for(const r of rows.flatMap(row=>row.regions)){
    const g=groups[r.label]??={regions:0,cells:0,rawRoad:0,free:0,obstacle:0,regionsWithFalseFree:0};
    g.regions++;
    for(const k of ['cells','rawRoad','free','obstacle'])g[k]+=r[k];
    if(r.label!=='road'&&r.free>0)g.regionsWithFalseFree++;
  }
  return {frames:rows.length,groups};
}

export async function benchmarkPerceptionAblation(manifestPath,outputPath){
  const manifest=JSON.parse(await readFile(manifestPath,'utf8'));
  const labelsBytes=await readFile(manifest.labels),labels=JSON.parse(labelsBytes);
  if(!manifest.scope||!Array.isArray(manifest.frames)||!manifest.frames.length||!Array.isArray(labels.rows))throw Error('Invalid manifest or partial labels');
  const data=[];
  for(const f of manifest.frames){
    const bytes=await readFile(resolve(f.root,f.file));
    if(sha(bytes)!==f.sha256||data.some(d=>key(d)===key(f)))throw Error('Input hash mismatch or duplicate frame');
    data.push({...f,bytes,reference:f.baseline?JSON.parse(await readFile(f.baseline,'utf8')):null});
  }
  const byKey=new Map(data.map(f=>[key(f),f])),labelMap=new Map();
  for(const f of labels.rows){
    if(!byKey.has(key(f))||byKey.get(key(f)).sha256!==f.sha256||labelMap.has(key(f)))throw Error('Label source mismatch, absent frame or duplicate label');
    for(const r of f.regions)regionCells(r.rect,128,128);
    labelMap.set(key(f),f);
  }
  const moduleRoot=fileURLToPath(new URL('../../',import.meta.url));
  const sources=['experiments/tools/benchmark-perception-ablation.mjs',...['offline-yolop-grid','perception','semantic-road','vision-tensor','camera-profile','road-occlusion','road-corridor','inference-session','inference-worker'].map(n=>'packages/perception/'+n+'.mjs'),'packages/protocols/latency-trace.mjs','experiments/tools/evaluate-quality-regions.mjs','package-lock.json','configs/segformer-config.json'];
  const models=['packages/perception/models/yolop-640.onnx','packages/perception/models/yolop-320.onnx','packages/perception/models/segformer-cityscapes.onnx'];
  const hashes=async names=>Object.fromEntries(await Promise.all(names.map(async name=>[name,sha(await readFile(resolve(moduleRoot,name)))])));
  const sourceHashes=await hashes(sources),modelHashes=await hashes(models);
  const referenceHashes=Object.fromEntries(await Promise.all(data.filter(f=>f.baseline).map(async f=>[f.baseline,sha(await readFile(f.baseline))])));
  const output=resolve(outputPath);
  await mkdir(output,{recursive:false});
  await json(output+'/protocol.json',{
    registered_utc:new Date().toISOString(),manifest,manifest_sha256:sha(await readFile(manifestPath)),labels_sha256:sha(labelsBytes),
    scope:'Offline development ablation only. No game capture, control, OCR, training, threshold tuning or production changes. Adjacent cells/frames correlated; no independent validation or driving success.',
    variants,order,warmups_per_run:2,provider:'dml',session_mode:'production workers, one session per worker, shared serial DirectML admission; intraOp=3, memPattern=false, sequential',
    timing:'Inputs preloaded. Session startup, warmup, file I/O, parity, labels and serialization excluded. Total includes JPEG/preprocessing, inference, postprocessing, optional YOLOP grid adapter and connectedRoadGeometry. Worker .run wall includes GPU/driver/copy/waits; it is not pure GPU compute. Background load uncontrolled.',
    comparisons:'A must exactly match all supplied baseline masks/labels/boxes. Each variant repeat must exactly match its first result, including native road/lane and semantic probability hashes. Cross-variant differences are intentional quality changes, not parity failures.',
    quality:'Frozen partial source-reviewed 97 patches, if supplied. Report road/raw coverage and false free on nonroad, obstacle coverage on other vehicles, no full IoU. Never choose by number of accepted paths. C loses semantic silhouettes, nonvehicle obstacles and semantic sign/pole veto; no invented labels/probabilities.',
    sourceHashes,modelHashes,referenceHashes,node:process.version
  });
  const first=new Map(),quality={},runs=[];
  let completed=false,error=null;
  try{
    for(const [runIndex,name] of order.entries()){
      const run={index:runIndex+1,variant:name,rows:[]};runs.push(run);
      const vision=await Perception.load({...variants[name],provider:'dml',cameraProfile:'rear',sessionMode:'worker'});
      const trace=new LatencyTrace();
      try{
        trace.wrap(vision,'analyze','vision');trace.wrap(vision.session,'run','yolop');
        if(vision.semantic){trace.wrap(vision.semantic,'analyze','semantic');trace.wrap(vision.semantic.session,'run','segformer');}
        for(let i=0;i<2;i++){const p=await vision.analyze(data[0].bytes);connectedRoadGeometry(p.semantic??offlineYolopGrid(p),'lane_follow');}
        const runDir=`${output}/${run.index}-${name}`;await mkdir(runDir);
        for(const [frameIndex,f] of data.entries()){
          trace.begin();
          const p=await vision.analyze(f.bytes),adapterStart=performance.now();
          const grid=p.semantic??offlineYolopGrid(p),geometryStart=performance.now();
          const geometry=connectedRoadGeometry(grid,'lane_follow'),end=performance.now(),events=trace.end();
          const native={yolop:vision.session.lastRun.worker_ms,segformer:vision.semantic?.session.lastRun.worker_ms??null};
          const actual=snapshot(p,grid);
          const extraHash=createHash('sha256');
          for(const a of [p.mask,p.lane,grid.probability].filter(Boolean))extraHash.update(Buffer.from(a.buffer,a.byteOffset,a.byteLength));
          const signature=sha(JSON.stringify({actual,geometry,extra:extraHash.digest('hex')}));
          const id=`${name}/${key(f)}`,previous=first.get(id),repeat=previous?previous.signature===signature:null;
          const baseline=name==='A'&&f.reference?Object.entries(actual).every(([k,v])=>isDeepStrictEqual(v,f.reference[k])):null;
          const row={root:f.root,file:f.file,primary:!!f.primary,total_ms:end-trace.start,adapter_ms:geometryStart-adapterStart,geometry_ms:end-geometryStart,native_ms:native,events,
            geometry_valid:geometry.valid,geometry_reason:geometry.reason??'candidate',baseline_parity:baseline,repeat_parity:repeat,signature};
          run.rows.push(row);
          await json(`${runDir}/${String(frameIndex).padStart(3,'0')}.json`,{...actual,geometry,signature});
          if(repeat===false||baseline===false)throw Error(`Exact parity failed ${name} ${f.file}`);
          if(!previous){
            first.set(id,{signature,actual});
            const labeled=labelMap.get(key(f));
            if(labeled)(quality[name]??=[]).push(qualityOf(f,actual,geometry,labeled));
          }
        }
        console.log(JSON.stringify({run:run.index,variant:name,frames:run.rows.length,total_ms:percentiles(run.rows.map(r=>r.total_ms)),baseline_parity:run.rows.filter(r=>r.baseline_parity===true).length,repeat_parity:run.rows.filter(r=>r.repeat_parity===true).length}));
      }finally{
        trace.close();
        const releases=await Promise.allSettled([vision.session.release(),...(vision.semantic?[vision.semantic.session.release()]:[])]);
        if(releases.some(r=>r.status==='rejected'))throw Error('Session release failed');
      }
      await json(output+'/timings.json',{completed:false,error:null,runs});
    }
    if(!isDeepStrictEqual(await hashes(sources),sourceHashes)||!isDeepStrictEqual(await hashes(models),modelHashes))throw Error('Source or weights changed during experiment');
    const summary={runs:runs.map(run=>({index:run.index,variant:run.variant,frames:run.rows.length,
      ...Object.fromEntries([['all',run.rows],['primary',run.rows.filter(r=>r.primary)]].map(([set,rows])=>[set,{
        total_ms:percentiles(rows.map(r=>r.total_ms)),native_ms:Object.fromEntries(['yolop','segformer'].map(k=>[k,percentiles(rows.map(r=>r.native_ms[k]).filter(v=>v!==null))])),
        geometric_candidates:rows.filter(r=>r.geometry_valid).length,geometry_reasons:rows.reduce((a,r)=>(a[r.geometry_reason]=(a[r.geometry_reason]??0)+1,a),{})
      }])),baseline_parity:run.rows.filter(r=>r.baseline_parity===true).length,repeat_parity:run.rows.filter(r=>r.repeat_parity===true).length})),
      quality:Object.fromEntries(Object.entries(quality).map(([name,rows])=>[name,{all:summarizeQuality(rows),sets:Object.fromEntries([...new Set(rows.map(r=>r.set))].map(set=>[set,summarizeQuality(rows.filter(r=>r.set===set))]))}])),
      differences:Object.fromEntries(['B','C'].map(name=>[name,data.map(f=>{
        const a=first.get(`A/${key(f)}`).actual,b=first.get(`${name}/${key(f)}`).actual;
        return {root:f.root,file:f.file,...Object.fromEntries(maskKeys.map(k=>[k,a[k].reduce((sum,v,i)=>sum+(v!==b[k][i]?1:0),0)])),vehicle_boxes_changed:!isDeepStrictEqual(a.vehicles,b.vehicles)};
      })]))};
    await json(output+'/quality-details.json',quality);await json(output+'/summary.json',summary);
    completed=true;
    return summary;
  }catch(e){error=e.stack;throw e;}
  finally{await json(output+'/timings.json',{completed,error,runs});}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  if(process.argv.length!==4)throw Error('Usage: node benchmark-perception-ablation.mjs MANIFEST.json NEW_OUTPUT_DIR (paths relative to cwd)');
  await benchmarkPerceptionAblation(process.argv[2],process.argv[3]);
}
