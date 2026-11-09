// Shared offline replay of a recorded observation session. OCR reads the
// original HUD PNG, road vision reads the matching JPEG, and the recorded capture
// time drives chronology. Nothing here sends input or talks to the bridge.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {percentiles} from './latency-trace.mjs';

const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');

export function loadSessionFiles({samples,session}){
  if(!Array.isArray(samples)||!samples.length)throw Error('A nonempty samples.jsonl is required');
  if(session?.source!=='single_capture')throw Error('A single-capture observation recording is required');
  for(const [i,r] of samples.entries()){
    for(const key of ['file','hud_file','minimap_file'])if(typeof r[key]!=='string'||path.basename(r[key])!==r[key]||!/^\d+(?:-(?:hud|map))?\.(?:jpg|png)$/.test(r[key]))throw Error('Invalid source image name at '+i);
    const stem=r.file.replace(/\.jpg$/,'');
    if(!/^\d+\.jpg$/.test(r.file)||r.hud_file!==stem+'-hud.png'||r.minimap_file!==stem+'-map.png')throw Error('Mixed source image names at '+i);
    if(!Number.isSafeInteger(r.sequence)||r.sequence<1||!Number.isFinite(r.capture_start_ms)||!Number.isFinite(r.capture_end_ms)||r.capture_start_ms>r.capture_end_ms)throw Error('Invalid capture manifest at '+i);
    if(!Number.isSafeInteger(r.generation)||r.generation<0||i&&r.generation!==samples[0].generation)throw Error('Recording generation changed at '+i);
    if(!Number.isFinite(r.age_ms)||r.age_ms<r.capture_end_ms-r.capture_start_ms)throw Error('Invalid recording age at '+i);
    if(i&&JSON.stringify(r.hud_geometry)!==JSON.stringify(samples[0].hud_geometry))throw Error('HUD geometry changed within the recording');
    if(r.capture_skew_ms!==0)throw Error('Separately captured components cannot be replayed as one observation at '+i);
    if(i&&(r.sequence<=samples[i-1].sequence||r.capture_start_ms<=samples[i-1].capture_start_ms))throw Error('Non-increasing recording timeline at '+i);
  }
  return samples;
}

export function sampleUniform(samples,count){
  if(!Number.isInteger(count)||count<1||count>samples.length)throw Error('Sampling count must be 1..frames');
  const step=(samples.length-1)/(count===1?1:count-1);
  return Array.from({length:count},(_,i)=>samples[Math.min(samples.length-1,Math.round(i*step))]);
}

// Road mask and the chosen connected path are drawn on the road JPEG so a human
// can see exactly which pixels produced the decision. Export failures never
// crash an analysis run, they are reported instead.
export async function renderPathOverlay({roadBytes,semantic,corridor,file}){
  try{
    const {default:sharp}=await import('sharp');
    const layers=[];
    if(semantic?.road){
      const {gridWidth:w,gridHeight:h}=semantic;
      const rgba=Buffer.alloc(w*h*4);
      for(let i=0;i<w*h;i++){
        if(semantic.road[i]&&semantic.corridorRoad&&!semantic.corridorRoad[i]){rgba[i*4]=255;rgba[i*4+2]=255;rgba[i*4+3]=120;}
        else if(semantic.road[i]){rgba[i*4+1]=255;rgba[i*4+3]=70;}
        else if(semantic.sidewalk?.[i]){rgba[i*4]=220;rgba[i*4+2]=255;rgba[i*4+3]=90;}
        else if(semantic.obstacle?.[i]){rgba[i*4]=255;rgba[i*4+3]=90;}
      }
      const mask=await sharp(rgba,{raw:{width:w,height:h,channels:4}}).resize(semantic.width,semantic.height,{kernel:'nearest'}).png().toBuffer();
      layers.push({input:mask});
    }
    if(corridor?.valid&&Array.isArray(corridor.points)&&corridor.points.length){
      const meta=await sharp(roadBytes).metadata();
      const circles=corridor.points.map(p=>`<circle cx="${(p.x*meta.width).toFixed(1)}" cy="${(p.y*meta.height).toFixed(1)}" r="4" fill="#00e5ff"/>`).join('');
      layers.push({input:Buffer.from(`<svg width="${meta.width}" height="${meta.height}">${circles}</svg>`)});
    }
    if(!layers.length)return {file:null,reason:'nothing_to_draw'};
    const image=await sharp(roadBytes).composite(layers).png().toBuffer();
    if(file){await mkdir(path.dirname(file),{recursive:true});await writeFile(file,image);}
    return {file:file??null,bytes:file?undefined:image};
  }catch(error){return {error:error.message};}
}

// Optional human labels stay authoritative. Nothing is derived from predictions.
function labelled(annotations,file,session){
  const row=annotations?.rows?.find(r=>r.file===file&&(!r.session||r.session===session));
  if(!row)return null;
  const speed=Number.isFinite(row.speed)?row.speed:null,gear=/^[RN1-8]$/.test(row.gear??'')?row.gear:null;
  return {speed,gear,partial:speed===null||gear===null};
}

export async function replayObservations(root,{
  readerFactory,hudProfile,visionFactory,intent='lane_follow',sampling=40,
  skill=null,annotations=null,overlay=true,output=null,clock=()=>performance.now()
}={}){
  // A plain options object is a skill configuration; only an adapter with update() runs.
  const skillRunner=skill&&typeof skill.update==='function'?skill:skill?skill.runner??null:null;
  const samples=loadSessionFiles({
    samples:(await readFile(path.join(root,'samples.jsonl'),'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse),
    session:JSON.parse(await readFile(path.join(root,'session.json'),'utf8'))});
  const session=JSON.parse(await readFile(path.join(root,'session.json'),'utf8'));
  if(annotations?.session&&annotations.session!==session.id)throw Error('Annotations belong to another session');
  const selected=sampleUniform(samples,sampling);
  const geometryKey=JSON.stringify(selected[0].hud_geometry);
  if(selected.some(r=>JSON.stringify(r.hud_geometry)!==geometryKey))throw Error('HUD geometry changed within the recording');

  let reader=null,vision=null,overlayError=null;
  const rows=[];
  // One corridor computation feeds both the decision and the saved overlay so a
  // human cannot be shown a different path than the one that produced the command.
  const {connectedRoadGeometry}=await import('../perception/road-corridor.mjs');
  try{
    if(readerFactory){reader=await readerFactory(hudProfile(selected[0].hud_geometry));}
    if(visionFactory)vision=await visionFactory();
    for(const [index,s] of samples.entries()){
      const hudBytes=await readFile(path.join(root,s.hud_file)),roadBytes=await readFile(path.join(root,s.file));
      const started=clock();
      const state=reader?await reader.read(hudBytes,s.capture_start_ms):null;
      const p=vision?await vision.analyze(roadBytes):null;
      const analysisMs=clock()-started;
      const truth=labelled(annotations,s.file,session.id);
      const row={index,file:s.file,sequence:s.sequence,capture_start_ms:s.capture_start_ms,capture_end_ms:s.capture_end_ms,recorded_age_ms:s.age_ms,
        hud_sha256:sha256(hudBytes),road_sha256:sha256(roadBytes),analysis_ms:analysisMs,label:truth,state,vision:p?{road_fraction:p.road_fraction,rows:p.rows,vehicles:p.vehicles?.length??0,inference_ms:p.inference_ms}:null};
      const corridor=p?.semantic?connectedRoadGeometry(p.semantic,intent):null;
      if(skillRunner){
        row.corridor=corridor?{valid:corridor.valid,reason:corridor.reason,points:corridor.points??null,near_offset:corridor.near_offset??null,curvature:corridor.curvature??null}:null;
        const skillFrame={generation:s.generation,corridor,sequence:s.sequence,capture_start_ms:s.capture_start_ms,capture_end_ms:s.capture_end_ms,age_ms:s.age_ms,state,vision:p,stop_requested:Boolean(s.stop_requested??skill?.stop_requested)};
        const decision=skillRunner.update(skillFrame);
        row.decision={corridor_valid:row.corridor?.valid===true,state:decision.state,reason:decision.reason,command:decision.command,lateral:decision.lateral,stop_confirmed:decision.stop_confirmed,pedal_release_allowed:decision.pedal_release_allowed,actuation_allowed:decision.actuation_allowed};
        if(overlay&&p?.semantic){
          const overlayFile=path.join(path.dirname(output??path.join(root,'replay.json')),'paths',String(index).padStart(3,'0')+'.png');
          const rendered=await renderPathOverlay({roadBytes,semantic:p.semantic,corridor,file:overlayFile});
          if(rendered.error)overlayError??=rendered.error;
          row.decision.overlay_file=rendered.file??null;
        }
      }
      if(selected.includes(s))rows.push(row);
    }
  }finally{await reader?.close?.();if(vision)await Promise.allSettled([vision.session?.release?.(),vision.semantic?.session?.release?.()]);}

  const decisions=rows.map(r=>r.decision).filter(Boolean);
  const speedErrors=rows.filter(r=>r.state?.speed?.valid&&Number.isFinite(r.label?.speed)).map(r=>Math.abs(r.state.speed.kmh-r.label.speed));
  const summary={
    frames_processed:samples.length,frames_recorded:samples.length,frames_replayed:rows.length,ocr_used:Boolean(reader),vision_used:Boolean(vision),
    valid_speed:rows.filter(r=>r.state?.speed?.valid).length,
    valid_gear:rows.filter(r=>r.state?.gear?.valid).length,
    labelled_speed:rows.filter(r=>Number.isFinite(r.label?.speed)).length,
    labelled_gear:rows.filter(r=>/^[RN1-8]$/.test(r.label?.gear??'')).length,
    correct_labelled_speed:rows.filter(r=>Number.isFinite(r.label?.speed)&&r.state?.speed?.valid&&r.state.speed.kmh===r.label.speed).length,
    wrong_labelled_speed:rows.filter(r=>Number.isFinite(r.label?.speed)&&r.state?.speed?.valid&&r.state.speed.kmh!==r.label.speed).length,
    speed_error_kmh:percentiles(speedErrors),
    corridor_geometry_valid:rows.filter(r=>r.corridor?.valid===true).length,
    corridor_rejections:Object.fromEntries([...new Set(rows.filter(r=>r.corridor&&!r.corridor.valid).map(r=>r.corridor.reason))].map(reason=>[reason,rows.filter(r=>r.corridor?.reason===reason).length])),
    analysis_ms:percentiles(rows.map(r=>r.analysis_ms)),
    decision_states:Object.fromEntries([...new Set(decisions.map(d=>d.state))].map(s=>[s,decisions.filter(d=>d.state===s).length])),
    rejection_reasons:Object.fromEntries([...new Set(decisions.filter(d=>d.state==='FAULT').map(d=>d.reason))].map(s=>[s,decisions.filter(d=>d.state==='FAULT'&&d.reason===s).length])),
    path_overlay_errors:overlayError,
    // A live result needs the exact same frames plus real reactions; this is not it.
    driving_verified:false
  };
  const report={session:session.id,role:session.role,camera_declared:session.camera_declared,camera_verified:session.camera_verified,
    intent,sampling:{requested:sampling,replayed:rows.length,method:'uniform report positions; every source frame processed sequentially'},
    scope:'Offline replay of recorded observations. OCR reads the stored HUD PNG at the recorded capture time; road vision reads the matching JPEG. No bridge, no game input, no actuation. Ages are the recorded receipt ages, not a live loop measurement.',
    game_input_sent:false,summary,rows};
  if(output){await mkdir(path.dirname(output),{recursive:true});await writeFile(output,JSON.stringify(report,null,2));}
  return report;
}
