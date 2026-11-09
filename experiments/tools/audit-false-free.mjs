import {fileURLToPath} from 'node:url';
// Offline false-free audit: runs the working perception on labelled development
// frames (or on a saved recording) and checks where the mask calls "free" a place
// a human marked as curb, pole, standing car or blocked view. No input, no bridge.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {auditFrame,pathTube,summarizeAudit} from '../../packages/perception/false-free-audit.mjs';
import {validateLabelFile} from '../../packages/perception/label-template.mjs';
import {corridorDrift} from '../../packages/perception/ego-motion.mjs';
import {percentiles} from '../../packages/protocols/latency-trace.mjs';

export async function auditLabels({labelFile,resolveImage,analyze,intent='lane_follow',cameraProfile='rear'}={}){
  const label=JSON.parse(await readFile(labelFile,'utf8'));
  const validation=validateLabelFile(label);
  if(!validation.ok)throw Error('Invalid label file: '+validation.problems.slice(0,5).join('; '));
  if(validation.labelled_points===0)throw Error('The label file has no points; label the frames before auditing');
  const frames=[],drifts=[];
  for(const frame of label.frames){
    const bytes=typeof resolveImage==='function'?await resolveImage(frame.file):Buffer.from(frame.file);
    const p=await analyze(bytes,{cameraProfile});
    const {connectedRoadGeometry}=await import('../../packages/perception/road-corridor.mjs');
    const corridor=connectedRoadGeometry(p.semantic??p,intent);
    const tube=corridor.valid?pathTube(corridor,{mask:p.semantic??p}):null;
    const audit=auditFrame(p.semantic??p,frame.points,{corridor,tube});
    const drift=corridorDrift(corridor);
    if(drift.ok)drifts.push(drift.lateral_drift);
    frames.push({file:frame.file,scene:frame.scene??null,corridor:corridor.valid?{valid:true,near_offset:corridor.near_offset??null,curvature:corridor.curvature??null}:{valid:false,reason:corridor.reason},
      drift:drift.ok?{lateral_drift:drift.lateral_drift,uncertainty:drift.uncertainty}:{ok:false,reason:drift.reason},
      audit,analysis_ms:p.inference_ms??null});
  }
  return {label_file:path.resolve(labelFile),session:label.session??null,intent,camera_profile:cameraProfile,
    scope:'Offline image-space audit on labelled development frames. Not independent validation and not a driving result.',
    summary:summarizeAudit(frames.map(f=>f.audit)),drift_summary:drifts.length?{frames:drifts.length,median:percentiles(drifts).p50,p95:percentiles(drifts).p95,units:'image fractions'}:null,
    latency_ms:percentiles(frames.map(f=>f.analysis_ms).filter(Number.isFinite)),frames};
}

const isMain=process.argv[1]&&path.resolve(process.argv[1])===path.resolve(fileURLToPath(import.meta.url));
if(isMain){
  const arg=(k,f)=>process.argv.find(a=>a.startsWith('--'+k+'='))?.split('=').slice(1).join('=')??f;
  const labelFile=process.argv[2];
  if(!labelFile)throw Error('Usage: node experiments/tools/audit-false-free.mjs <labels.json> [--root=DIR] [--intent=lane_follow] [--camera=rear] [--out=report.json]');
  const root=arg('root',path.dirname(path.resolve(labelFile)));
  const {Perception}=await import('../../packages/perception/perception.mjs');
  const vision=await Perception.load({cameraProfile:arg('camera','rear')});
  try{
    const label=JSON.parse(await readFile(labelFile,'utf8'));
    const known=new Set(label.frames.map(f=>f.file));
    const check=validateLabelFile(label,{knownFiles:known});
    if(!check.ok)throw Error('Invalid label file: '+check.problems.slice(0,5).join('; '));
    const report=await auditLabels({labelFile,intent:arg('intent','lane_follow'),cameraProfile:arg('camera','rear'),
      analyze:bytes=>vision.analyze(bytes),
      resolveImage:file=>readFile(path.join(root,file))});
    const out=arg('out',path.resolve(root,'false-free-report.json'));
    await mkdir(path.dirname(out),{recursive:true});
    await writeFile(out,JSON.stringify(report,null,2));
    console.log(JSON.stringify({report:out,verdict:report.summary.verdict,false_free_on_path:report.summary.false_free_on_path,false_free_total:report.summary.false_free_total,by_kind:report.summary.by_kind,drift:report.drift_summary,latency:report.latency_ms},null,2));
  }finally{await Promise.allSettled([vision.session?.release?.(),vision.semantic?.session?.release?.()]);}
}
