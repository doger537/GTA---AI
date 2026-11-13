import {fileURLToPath} from 'node:url';
// Joins three already measured things — an asphalt-edge mark, the planner depth
// recorded in corridor-breaks.json and optionally a saved prediction — and names
// the first limit. No model runs here: the depth comes from a previous offline run
// on the same frames, so this cannot silently re-tune perception thresholds.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {ascentProfile,rowsAvailable,classifyReach,groundDistance,cameraCalibration,reachScope} from '../../packages/perception/asphalt-limit.mjs';
import {percentiles} from '../../packages/protocols/latency-trace.mjs';

// The planner depth is recorded in grid rows on a 128×128 grid with the seed row
// in pixels; both are converted here, not assumed.
export const GRID=128;

export async function joinReach({edgeFile,depthFile,requiredRows=13,calibration=null,beyondMarkToleranceRows=0.5}={}){
  const edges=JSON.parse(await readFile(edgeFile,'utf8'));
  const breaks=JSON.parse(await readFile(depthFile,'utf8'));
  const depth=new Map((breaks.rows??[]).map(r=>[r.file,r]));
  const cal=calibration?cameraCalibration(calibration):null;
  if(cal&&!cal.verified)throw Error('Calibration is not verified: '+cal.problems.slice(0,3).join('; '));
  const rows=[];let missing=0;
  for(const frame of edges.frames??[]){
    if(!Array.isArray(frame.edge)||!frame.edge.length){rows.push({file:frame.file,skipped:'not_marked'});continue;}
    const profile=ascentProfile(frame.edge);
    if(!profile.ok){rows.push({file:frame.file,skipped:'invalid_edge',reason:profile.reason});continue;}
    const recorded=depth.get(frame.file);
    if(!recorded){missing++;rows.push({file:frame.file,skipped:'no_recorded_depth',seed_y:profile.near.y});continue;}
    // The mark starts at the planner seed, so the available rows are measured from
    // that same row; using the bottom of the polygon would inflate the view.
    const seedY=(recorded.seed[1]+0.5)/GRID;
    const available=rowsAvailable({profile,gridHeight:GRID,seedY});
    if(!available.ok){rows.push({file:frame.file,skipped:'invalid_available_rows',reason:available.reason});continue;}
    const reach=classifyReach({available,planner:recorded.depth,requiredRows,beyondMarkToleranceRows});
    rows.push({file:frame.file,obstruction:frame.obstruction??null,
      seed_y:seedY,marked_near_y:profile.near.y,mark_seed_offset_rows:(profile.near.y-seedY)*GRID,
      far_y:profile.far.y,available_rows:available.rows_from_seed,
      planner_rows:recorded.depth,recorded_first_blocked_row:recorded.first_blocked_row??null,
      recorded_layer_short:recorded.first_layer_short??null,
      reach,metres:cal?{at_edge:groundDistance({y:profile.far.y,calibration:cal}),
        at_seed:groundDistance({y:seedY,calibration:cal})}:null});
  }
  const scored=rows.filter(r=>r.reach?.ok);
  const blockers={};for(const r of scored){const k=r.reach.first_blocker??'none';blockers[k]=(blockers[k]??0)+1;}
  const beyond=scored.filter(r=>r.reach.planned_beyond_mark);
  const viewShort=scored.filter(r=>r.reach.eye_view_insufficient);
  return {edge_file:path.resolve(edgeFile),depth_file:path.resolve(depthFile),required_rows:requiredRows,
    depth_source:{base:breaks.base??null,rows:breaks.rows?.length??0,
      note:'Planner depth comes from an earlier offline run on the same frames; this join does not re-infer anything.'},
    scope:'Development join of a marked asphalt edge with a recorded planner depth. Rows are image-space; not a distance and not a driving result.',
    calibration:cal?(cal.verified?{ok:true,verified:true,source:cal.source,focal_px:cal.focal_px,
      max_error_pct:cal.verification.max_error_pct,rows_apart:cal.verification.rows_apart}:{ok:false,reason:cal.reason,problems:cal.problems}):null,
    scope_of_units:reachScope({calibration:cal?.verified?cal:null,haveMarks:scored.length>0,haveFrames:(edges.frames??[]).length>0}),
    summary:{frames:(edges.frames??[]).length,scored:scored.length,missing_depth:missing,
      first_blocker:blockers,
      view_insufficient:scored.length?viewShort.length:null,
      // A corridor that runs past the marked asphalt is reported on its own: it is
      // the opposite error to a short corridor and must not be averaged away.
      planned_beyond_mark:beyond.length,
      beyond_mark_detail:beyond.map(r=>({file:r.file,rows_beyond_mark:+r.reach.rows_beyond_mark.toFixed(2),planner_rows:r.planner_rows,available_rows:+r.available_rows.toFixed(2)})),
      // Share of the available range the planner actually used, where it is defined.
      planner_use_fraction:percentiles(scored.filter(r=>r.available_rows>0).map(r=>r.planner_rows/r.available_rows)),
      available_rows:percentiles(scored.map(r=>r.available_rows)),
      planner_rows:percentiles(scored.map(r=>r.planner_rows)),
      mark_seed_offset_rows:percentiles(scored.map(r=>r.mark_seed_offset_rows))},
    rows,none_guessed:'Frames without a mark or without recorded depth are skipped and counted, never filled.'};
}

const isMain=process.argv[1]&&path.resolve(process.argv[1])===path.resolve(fileURLToPath(import.meta.url));
if(isMain){
  const arg=(k,f)=>process.argv.find(a=>a.startsWith('--'+k+'='))?.split('=').slice(1).join('=')??f;
  const [edgeFile,depthFile]=process.argv.slice(2).filter(a=>!a.startsWith('--'));
  if(!edgeFile||!depthFile)throw Error('Usage: node experiments/tools/join-asphalt-reach.mjs <asphalt-edges.json> <corridor-breaks.json> [--required=13] [--calibration=file.json] [--out=report.json]');
  const calibrationFile=arg('calibration',null);
  const calibration=calibrationFile?JSON.parse(await readFile(calibrationFile,'utf8')):null;
  const report=await joinReach({edgeFile,depthFile,requiredRows:Number(arg('required',13)),calibration,
    beyondMarkToleranceRows:Number(arg('beyond-tolerance',0.5))});
  const out=arg('out',path.resolve(path.dirname(edgeFile),'asphalt-reach-join.json'));
  await mkdir(path.dirname(out),{recursive:true});
  await writeFile(out,JSON.stringify(report,null,2));
  console.log(JSON.stringify({report:out,summary:report.summary,units:report.scope_of_units},null,2));
}
