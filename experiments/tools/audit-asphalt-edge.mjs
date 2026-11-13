import {fileURLToPath} from 'node:url';
// Asphalt-edge labelling and reach report. Works in two steps so the mark is made
// before any prediction is looked at:
//   --template  writes an empty edge file for chosen frames (nothing pre-filled)
//   --report    compares the marks with grid rows available at that angle, with
//               the mask and with the planner, using saved predictions if present
// No model is loaded in --template, and no metres are produced without a measured
// camera calibration.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {ascentProfile,rowsAvailable,classifyReach,edgeXAt,groundDistance,cameraCalibration,reachScope,ASPHALT_SCOPE} from '../../packages/perception/asphalt-limit.mjs';
import {percentiles} from '../../packages/protocols/latency-trace.mjs';

export const EDGE_SCHEMA_VERSION=1;

export function emptyEdgeFile({session=null,files=[],frames=[]}={}){
  if(!Array.isArray(files)||!files.length)throw Error('A nonempty list of frame files is required');
  for(const file of files)if(typeof file!=='string'||!file||file.includes('/')||file.includes('\\'))throw Error('Frame file must be a bare name: '+file);
  const seedRow=frames.length?frames:files;
  return {schema_version:EDGE_SCHEMA_VERSION,session,role:'development',
    instructions:[
      'Mark the far edge of continuously visible asphalt: the last place where you can still see road surface, not where the mask ends.',
      'edge is a polyline of [x,y] image fractions from the bottom of the frame upwards; y must strictly decrease.',
      'Mark both edges of the visible asphalt if the far edge is a horizontal cut; one node is not enough.',
      'obstruction:"clear" when asphalt continues past the mark, or the kind of thing that hides it: curb, edge, shadow, vehicle, junction, bend, darkness, other.',
      'Do not look at any prediction first, and do not mark the mask as the road: a wrong mask is exactly what this file is meant to catch.'],
    obstruction_kinds:['clear','curb','edge','shadow','vehicle','junction','bend','darkness','other'],
    frames:seedRow.map(f=>typeof f==='string'
      ?{file:f,session,edge:[],obstruction:null,note:'',sha256:null}
      :{file:f.file,session,edge:[],obstruction:null,note:'',sha256:f.sha256??null})};
}

export function validateEdgeFile(file,{knownFiles=null}={}){
  const problems=[];
  if(!file||file.schema_version!==EDGE_SCHEMA_VERSION)problems.push('schema_version must be '+EDGE_SCHEMA_VERSION);
  if(!Array.isArray(file?.frames))return {ok:false,problems:['frames must be an array'],marked:0};
  const seen=new Set();let marked=0;
  for(const [i,frame] of file.frames.entries()){
    const at=frame?.file??('#'+i);
    if(typeof frame?.file!=='string'||!frame.file||frame.file.includes('/')||frame.file.includes('\\'))problems.push(at+': invalid file name');
    if(knownFiles&&!knownFiles.has(frame?.file))problems.push(at+': file is not part of the recording');
    if(seen.has(frame.file))problems.push(at+': duplicate frame');
    seen.add(frame?.file);
    if(frame?.obstruction!==null&&frame?.obstruction!==undefined&&!emptyEdgeFile.OBSTRUCTION_KINDS.includes(frame.obstruction))problems.push(at+': unknown obstruction');
    if(!Array.isArray(frame?.edge)){problems.push(at+': edge must be an array');continue;}
    // An empty edge list means "not marked yet", which is legal but counted as zero.
    if(!frame.edge.length)continue;
    const profile=ascentProfile(frame.edge);
    if(!profile.ok)problems.push(at+': '+profile.reason);else marked++;
  }
  return {ok:problems.length===0,problems,marked,frames:file.frames.length};
}
emptyEdgeFile.OBSTRUCTION_KINDS=Object.freeze(['clear','curb','edge','shadow','vehicle','junction','bend','darkness','other']);

// Reads a saved prediction for one frame. Everything except the grid size is
// optional: the reach report must work on masks, on corridor rows, or on both.
export async function loadPrediction(file){
  try{const p=JSON.parse(await readFile(file,'utf8'));return {ok:true,prediction:p};}
  catch(error){return {ok:false,reason:error.code==='ENOENT'?'prediction_missing':'prediction_unreadable'};}
}

// Rows the mask keeps usable at or above the marked edge: measured on the model's
// own road mask along the marked edge, row by row, not by the planner.
export function maskRowsToEdge({prediction,profile,gridHeight=null}={}){
  const w=prediction?.gridWidth,h=prediction?.gridHeight;
  const road=prediction?.corridorRoad??prediction?.road;
  if(!road||!Number.isInteger(w)||!Number.isInteger(h)||road.length!==w*h)return {ok:false,reason:'no_road_mask'};
  if(!profile?.ok)return {ok:false,reason:'edge_required'};
  const gh=gridHeight??h;
  const farY=profile.far.y;
  let lastUsable=null;
  // Walk upwards from the bottom of the frame and stop at the marked edge: the
  // question is how far the mask still agrees with the marked asphalt, not where
  // the mask happens to end.
  for(let y=h-1;y>=0;y--){
    const yy=(y+.5)/h;
    if(yy<farY)break;
    const x=edgeXAt(profile,yy);
    if(x===null)break;
    const gx=Math.min(w-1,Math.max(0,Math.floor(x*w)));
    if(road[y*w+gx])lastUsable=yy;
  }
  if(lastUsable===null)return {ok:true,rows:0,last_usable_y:null,reason:'no_road_at_edge',grid_height:h};
  // Distances are measured from the planner seed, not from the bumper: rows the
  // planner cannot start from are not reach.
  const seedY=profile.near.y;
  const rows=(seedY-lastUsable)*h;
  return {ok:true,rows:Math.max(0,rows),last_usable_y:lastUsable,edge_y:farY,seed_y:seedY,grid_height:h};
}

// Why a file has no usable marks. A zero in the summary must say whether the marks
// are missing, or present under a shape this tool cannot read: silently reporting
// "0 of 40" is not a measurement, it is a lost measurement.
export function diagnoseMarks(file){
  const frames=Array.isArray(file?.frames)?file.frames:[];
  const counts={empty:0,marked:0,invalid:0,edge_not_array:0,unexpected_shape:0};
  const hints=[];
  for(const [i,frame] of frames.entries()){
    const edge=frame?.edge;
    if(edge===undefined||edge===null){
      counts.empty++;
      if(i===0)hints.push('frame 0 has no "edge" field at all; the file may come from another tool or an older template');
      continue;
    }
    if(!Array.isArray(edge)){counts.edge_not_array++;continue;}
    if(!edge.length){counts.empty++;continue;}
    // Common near-misses: objects instead of [x,y] pairs, or a flat x,y,x,y list.
    const firstPair=edge[0];
    if(firstPair&&typeof firstPair==='object'&&!Array.isArray(firstPair)){
      counts.unexpected_shape++;
      if(hints.length<3)hints.push('edge uses {'+Object.keys(firstPair).join(',')+'} objects; this tool needs [x,y] pairs, e.g. [[0.5,0.58],[0.5,0.40]]');
      continue;
    }
    if(Array.isArray(firstPair)&&firstPair.length!==2){
      counts.unexpected_shape++;
      if(hints.length<3)hints.push('edge entries have '+firstPair.length+' numbers; exactly [x,y] is required');
      continue;
    }
    if(typeof firstPair==='number'){
      counts.unexpected_shape++;
      if(hints.length<3)hints.push('edge is a flat number list; group it into [x,y] pairs');
      continue;
    }
    const profile=ascentProfile(edge);
    if(profile.ok)counts.marked++;else{counts.invalid++;if(hints.length<3)hints.push(frame?.file+': '+profile.reason);}
  }
  const keys=frames[0]?Object.keys(frames[0]).join(','):'';
  return {counts,frame_keys:keys,hints,
    explanation:counts.marked?null:counts.empty===frames.length
      ?'Every frame has an empty edge list: the template was copied but not labelled. Mark the far edge of visible asphalt on each frame you want scored.'
      :counts.unexpected_shape?'Edge data is present but in a shape this tool does not read.'+' '+(hints[0]??'')
      :'Marks are present but invalid; see hints.'};
}

export function plannerRows(corridor){
  if(!corridor?.valid||!Array.isArray(corridor.points)||corridor.points.length<2)return null;
  const near=corridor.points[0],far=corridor.points.at(-1);
  return near.y>far.y?(near.y-far.y)*128:null;
}

export async function edgeReport({edgeFile,root,calibration=null,requiredRows=13,predictionSuffix='.json'}={}){
  const file=JSON.parse(await readFile(edgeFile,'utf8'));
  const known=new Set(file.frames.map(f=>f.file));
  const check=validateEdgeFile(file,{knownFiles:known});
  const diagnosis=diagnoseMarks(file);
  const noMarks=check.marked===0;
  // Nothing scored means there is nothing to validate against: the report explains
  // the shape of the file instead of failing with a validator message. With real
  // marks present, a malformed file is still a hard error.
  if(noMarks&&!diagnosis.counts.empty+diagnosis.counts.unexpected_shape+diagnosis.counts.invalid){
    /* empty frame list */ }
  // A malformed polyline in one frame is a per-frame skip (reported in rows), not
  // a reason to discard the whole file. Structural problems still abort.
  const structural=['invalid file name','file is not part of the recording','duplicate frame',
    'unknown obstruction','edge must be an array','schema_version','frames must be an array'];
  const fatal=check.problems.filter(p=>structural.some(k=>p.includes(k)));
  if(!noMarks&&fatal.length)throw Error('Invalid edge file: '+fatal.slice(0,5).join('; '));
  const cal=calibration?cameraCalibration(calibration):null;
  const rows=[];
  for(const frame of file.frames){
    if(!Array.isArray(frame.edge)||!frame.edge.length){rows.push({file:frame.file,skipped:'not_marked'});continue;}
    const profile=ascentProfile(frame.edge);
    // A malformed polyline is reported per frame; it never aborts the whole report.
    if(!profile.ok){rows.push({file:frame.file,skipped:'invalid_edge',reason:profile.reason});continue;}
    const stem=path.basename(frame.file).replace(/\.(?:jpg|png)$/i,'');
    // The prediction file sits next to the recording, never inferred from a label.
    const predictionPath=path.join(root,stem+predictionSuffix);
    const loaded=await loadPrediction(predictionPath);
    const gridHeight=loaded.ok?(loaded.prediction.gridHeight??null):null;
    const available=rowsAvailable({profile,gridHeight:gridHeight??128,seedY:profile.near.y});
    // The seed of the real planner starts above the bottom of the mark, so the
    // available rows are reported both from the mark itself and from the seed.
    const mask=loaded.ok?maskRowsToEdge({prediction:loaded.prediction,profile}):null;
    const corridor=loaded.ok?loaded.prediction.corridor??null:null;
    const reach=available.ok?classifyReach({available,maskReachRows:mask?.ok?mask.rows:null,planner:plannerRows(corridor),requiredRows}):available;
    // Metres are reported only for a measured calibration, and only for the
    // marked edge and the planner seed; every other row stays a row.
    const metres=cal?.verified===true&&cal?.ok?{
      at_edge:groundDistance({y:profile.far.y,calibration:cal}),
      at_seed:groundDistance({y:profile.near.y,calibration:cal})}:null;
    rows.push({file:frame.file,obstruction:frame.obstruction??null,note:frame.note??'',
      edge:{near_y:profile.near.y,far_y:profile.far.y,points:profile.points.length},
      prediction:loaded.ok?'loaded':loaded.reason,
      available_rows:available.ok?available.rows_from_seed:null,
      mask_rows:mask?.ok?mask.rows:null,mask_reason:mask?.ok?null:mask?.reason??null,
      planner_rows:plannerRows(corridor),reach:reach.ok?reach:null,
      metres:metres?{edge:metres.at_edge,seed:metres.at_seed}:null});
  }
  const scored=rows.filter(r=>r.reach?.ok);
  const byObstruction={};
  for(const r of scored){const k=r.obstruction??'unstated';byObstruction[k]=(byObstruction[k]??0)+1;}
  const blockers={};
  for(const r of scored){const k=r.reach.first_blocker??'none';blockers[k]=(blockers[k]??0)+1;}
  return {edge_file:path.resolve(edgeFile),session:file.session??null,required_rows:requiredRows,
    // Present whenever nothing could be scored; null once real marks exist.
    why_not_scored:noMarks?{reason:'no_asphalt_edge_marks',counts:diagnosis.counts,frame_keys:diagnosis.frame_keys,
      validation_problems:check.problems.slice(0,5),
      hints:diagnosis.hints,explanation:diagnosis.explanation,
      note:'This file measures nothing yet. The 22/25 from the earlier mask analysis still only means the model found no road there; it says nothing about what the camera could see.'}:null,
    scope:'Development reach report: image rows available at a marked asphalt edge versus the mask and the planner. Not a distance, not a driving result.',
    calibration:cal?(cal.ok?{ok:true,source:cal.source,focal_px:cal.focal_px,height_m:cal.height_m,pitch_deg:cal.pitch_deg}:{ok:false,reason:cal.reason,problems:cal.problems}):null,
    scope_of_units:reachScope({calibration:cal?.ok?cal:null,haveMarks:check.marked>0,haveFrames:file.frames.length>0}),
    summary:{frames:file.frames.length,marked:check.marked,scored:scored.length,skipped:rows.length-check.marked,
      obstruction:byObstruction,first_blocker:blockers,
      view_rows:percentiles(scored.map(r=>r.available_rows).filter(Number.isFinite)),
      mask_rows:percentiles(scored.map(r=>r.mask_rows).filter(Number.isFinite)),
      planner_rows:percentiles(scored.map(r=>r.planner_rows).filter(Number.isFinite)),
      // With nothing scored these are null: a zero here would read as a measured zero.
      view_insufficient:scored.length?scored.filter(r=>r.reach.eye_view_insufficient).length:null,
      view_allows_required:scored.length?scored.filter(r=>r.reach.view_allows_required).length:null},
    rows,none_guessed:'Frames without a mark are skipped, never filled with a prediction.'};
}

const isMain=process.argv[1]&&path.resolve(process.argv[1])===path.resolve(fileURLToPath(import.meta.url));
if(isMain){
  const arg=(k,f)=>process.argv.find(a=>a.startsWith('--'+k+'='))?.split('=').slice(1).join('=')??f;
  const first=process.argv[2];
  if(!first)throw Error('Usage: node experiments/tools/audit-asphalt-edge.mjs <recording-or-frames.json> [--template] [--report] [--root=DIR] [--out=] [--calibration=file.json] [--required=13]');
  const template=process.argv.includes('--template'),report=process.argv.includes('--report');
  if(!template&&!report)throw Error('Choose --template (write an empty edge file) or --report (build the reach report)');
  if(template){
    // A recording folder gives its frames, a JSON file gives an explicit list.
    const root=arg('root',null);
    let files=[],session=arg('session',null);
    if(first.endsWith('.json')){
      const listed=JSON.parse(await readFile(first,'utf8'));
      files=Array.isArray(listed)?listed:listed.frames??[];
      files=files.map(f=>typeof f==='string'?f:f.file??f);
      session=session??(Array.isArray(listed)?null:listed.session??null);
    }else{
      const samples=[];
      try{
        const lines=(await readFile(path.join(first,'samples.jsonl'),'utf8')).trim().split('\n').filter(Boolean);
        for(const line of lines)samples.push(JSON.parse(line));
      }catch(error){if(error.code!=='ENOENT')throw error;}
      if(!samples.length)throw Error('No samples.jsonl under '+first+' and no explicit frame list given');
      const limit=Number(arg('frames',40));
      if(!Number.isInteger(limit)||limit<1)throw Error('frames must be a positive integer');
      const step=(samples.length-1)/Math.max(1,limit-1);
      const picked=Array.from({length:limit},(_,i)=>samples[Math.min(samples.length-1,Math.round(i*step))]);
      files=picked.map(s=>s.file);session=session??(JSON.parse(await readFile(path.join(first,'session.json'),'utf8')).id??null);
    }
    // A folder argument means "write the edge file into that recording", so a
    // template can never silently land in the current directory instead.
    const isFolder=!first.endsWith('.json');
    const out=arg('out',isFolder?path.join(first,'asphalt-edges.json'):path.join(root??path.dirname(path.resolve(first)),'asphalt-edges.json'));
    const edgeFile=emptyEdgeFile({session,files});
    await writeFile(out,JSON.stringify(edgeFile,null,2),{flag:'wx'}).catch(error=>{
      if(error.code==='EEXIST')throw Error('Refusing to overwrite an existing edge file: '+out);throw error;});
    console.log(JSON.stringify({edges:out,frames:files.length,note:'Mark edge polylines by hand; nothing is pre-filled.'},null,2));
  }else{
    const calibrationFile=arg('calibration',null);
    const calibration=calibrationFile?JSON.parse(await readFile(calibrationFile,'utf8')):null;
    const root=arg('root',path.dirname(path.resolve(first)));
    const requiredRows=Number(arg('required',13));
    const report=await edgeReport({edgeFile:first,root,calibration,requiredRows});
    const out=arg('out',path.resolve(root,'asphalt-reach-report.json'));
    await mkdir(path.dirname(out),{recursive:true});
    await writeFile(out,JSON.stringify(report,null,2));
    console.log(JSON.stringify({report:out,summary:report.summary,units:report.scope_of_units,
      why_not_scored:report.why_not_scored},null,2));
    if(report.why_not_scored){
      // stdout stays machine-readable; the human reads stderr.
      console.error('\nNothing was scored: '+report.why_not_scored.explanation);
      for(const hint of report.why_not_scored.hints)console.error('  - '+hint);
      process.exitCode=2;
    }
  }
}
