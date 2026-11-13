import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
// Offline false-free audit: runs the working perception on labelled development
// frames (or on a saved recording) and checks where the mask calls "free" a place
// a human marked as curb, pole, standing car or blocked view. No input, no bridge.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {auditFrame,pathTube,summarizeAudit} from '../../packages/perception/false-free-audit.mjs';
import {validateLabelFile} from '../../packages/perception/label-template.mjs';
import {corridorDrift,MotionSequence,latencyBreakdown,scaleReadiness} from '../../packages/perception/ego-motion.mjs';
import {recordedMinimap,decodeMinimap} from '../../packages/perception/recorded-minimap.mjs';
import {percentiles} from '../../packages/protocols/latency-trace.mjs';

// `gapFrames` says how many original recording frames sit between two labelled
// frames. A shift across a gap is not a consecutive-frame shift, so the audit
// reports the gap instead of quietly treating sampled frames as neighbours.
export async function auditLabels({labelFile,resolveImage,analyze,resolveMinimap=null,minimapReader=decodeMinimap,gapFrames=null,intent='lane_follow',cameraProfile='rear',clock=()=>performance.now()}={}){
  const label=JSON.parse(await readFile(labelFile,'utf8'));
  const validation=validateLabelFile(label);
  if(!validation.ok)throw Error('Invalid label file: '+validation.problems.slice(0,5).join('; '));
  if(validation.labelled_points===0)throw Error('The label file has no points; label the frames before auditing');
  const frames=[],drifts=[],motion=new MotionSequence({gapFrames});
  const {connectedRoadGeometry}=await import('../../packages/perception/road-corridor.mjs');
  for(const frame of label.frames){
    const started=clock();
    const bytes=typeof resolveImage==='function'?await resolveImage(frame.file):Buffer.from(frame.file);
    if(frame.sha256!=null && createHash('sha256').update(bytes).digest('hex')!==frame.sha256){
      throw Error('Label source image hash mismatch for '+frame.file);
    }
    const p=await analyze(bytes,{cameraProfile});
    const corridor=connectedRoadGeometry(p.semantic??p,intent);
    const tube=corridor.valid?pathTube(corridor,{mask:p.semantic??p}):null;
    const audit=auditFrame(p.semantic??p,frame.points,{corridor,tube});
    // The inter-frame shift is measured on the whole sequence, not per frame, so a
    // labelled frame can never be reported as moving on its own.
    // Same mask the audit scored: the analyzer may return the frame directly.
    const map=resolveMinimap?await recordedMinimap(()=>resolveMinimap(frame.file),minimapReader):{image:null,reason:'minimap_resolver_missing'};
    const match=/^(\d+)\.jpg$/.exec(frame.file);
    const motionRow=motion.update({file:frame.file,source_index:match?Number(match[1]):null,
      semantic:p.semantic??p,minimap:map.image,minimap_reason:map.reason});
    const drift=corridorDrift(corridor);
    if(drift.ok)drifts.push(drift.lateral_drift);
    frames.push({file:frame.file,scene:frame.scene??null,corridor:corridor.valid?{valid:true,near_offset:corridor.near_offset??null,curvature:corridor.curvature??null}:{valid:false,reason:corridor.reason},
      drift:drift.ok?{lateral_drift:drift.lateral_drift,uncertainty:drift.uncertainty}:{ok:false,reason:drift.reason},
      audit,motion:motionRow,analysis_ms:clock()-started,inference_ms:p.inference_ms??null});
  }
  const sequence=frames.length>1?motion.summary():null;
  return {label_file:path.resolve(labelFile),session:label.session??null,intent,camera_profile:cameraProfile,
    annotation_source:label.annotation_source??null,human_reviewed:typeof label.human_reviewed==='boolean'?label.human_reviewed:null,
    scope:'Offline image-space audit on labelled development frames. Not independent validation and not a driving result.',
    summary:summarizeAudit(frames.map(f=>f.audit)),drift_summary:drifts.length?{frames:drifts.length,median:percentiles(drifts).p50,p95:percentiles(drifts).p95,units:'image fractions'}:null,
    // Corridor geometry (drift) and inter-frame motion are two different questions:
    // drift is the shape of one frame, the shift needs neighbours.
    motion_summary:sequence?{frames:sequence.frames,gap_frames:sequence.gap_frames,gap_range:sequence.gap_range,sources:sequence.sources,
      reasons:sequence.reasons,shift_pixels:sequence.shift_pixels,verified:false,
      note:'Image-space shift between labelled neighbours; not a yaw, not a distance. Source hypotheses are unverified.'}:null,
    minimap_used:motion.rows.some(r=>r.minimap_profile_ok),scale_readiness:scaleReadiness(),
    // Recorded age, offline analysis time and a live loop are three measurements.
    latency:latencyBreakdown({offlineAnalysisMs:frames.map(f=>f.analysis_ms).filter(Number.isFinite)}),
    latency_ms:percentiles(frames.map(f=>f.inference_ms).filter(Number.isFinite)),frames};
}

const isMain=process.argv[1]&&path.resolve(process.argv[1])===path.resolve(fileURLToPath(import.meta.url));
if(isMain){
  const arg=(k,f)=>process.argv.find(a=>a.startsWith('--'+k+'='))?.split('=').slice(1).join('=')??f;
  const labelFile=process.argv[2];
  if(!labelFile)throw Error('Usage: node experiments/tools/audit-false-free.mjs <labels.json> [--root=DIR] [--intent=lane_follow] [--camera=rear] [--gap=N] [--out=report.json]');
  const root=arg('root',path.dirname(path.resolve(labelFile)));
  const {Perception}=await import('../../packages/perception/perception.mjs');
  const vision=await Perception.load({cameraProfile:arg('camera','rear')});
  try{
    const label=JSON.parse(await readFile(labelFile,'utf8'));
    const known=new Set(label.frames.map(f=>f.file));
    const check=validateLabelFile(label,{knownFiles:known});
    if(!check.ok)throw Error('Invalid label file: '+check.problems.slice(0,5).join('; '));
    // Labelled frames sit next to their minimap (<stem>-map.png) when the recording
    // kept one. The gap says how many original frames separate two labelled frames.
    const minimapName=file=>path.basename(file).replace(/\.jpg$/,'')+'-map.png';
    const report=await auditLabels({labelFile,intent:arg('intent','lane_follow'),cameraProfile:arg('camera','rear'),
      gapFrames:arg('gap',null)===null?null:Number(arg('gap',null)),
      analyze:bytes=>vision.analyze(bytes),
      resolveImage:file=>readFile(path.join(root,file)),
      resolveMinimap:file=>readFile(path.join(root,minimapName(file)))});
    const out=arg('out',path.resolve(root,'false-free-report.json'));
    await mkdir(path.dirname(out),{recursive:true});
    await writeFile(out,JSON.stringify(report,null,2));
    console.log(JSON.stringify({report:out,verdict:report.summary.verdict,false_free_on_path:report.summary.false_free_on_path,false_free_total:report.summary.false_free_total,by_kind:report.summary.by_kind,drift:report.drift_summary,motion:report.motion_summary,latency:report.latency},null,2));
  }finally{await Promise.allSettled([vision.session?.release?.(),vision.semantic?.session?.release?.()]);}
}
