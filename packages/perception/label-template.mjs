// Skeleton for manual labels. Fields are left empty on purpose: nothing here may
// be filled from a prediction, and an unlabelled point is never guessed later.
import {HAZARD_KINDS} from './false-free-audit.mjs';

export const SCENE_KINDS=Object.freeze(['straight','bend','junction','parking','blocked_view','other']);

export function emptyLabelFile({session=null,files=[],hazardKinds=HAZARD_KINDS}={}){
  if(!Array.isArray(files)||!files.length)throw Error('A nonempty list of frame files is required');
  for(const file of files)if(typeof file!=='string'||!file||file.includes('/')||file.includes('\\'))throw Error('Frame file must be a bare name: '+file);
  return {
    schema_version:1,
    session,
    role:'development',
    instructions:[
      'Label original images before looking at any prediction.',
      'expected:"road" for drivable asphalt, "hazard" for anything a car must not hit.',
      'Every hazard needs a kind: '+hazardKinds.join(', ')+'.',
      'Use null for a point you cannot decide; do not guess.',
      'scene.kind and camera_yaw describe the whole frame, not the path.'
    ],
    hazard_kinds:hazardKinds,
    frames:files.map(file=>({file,session,role:'development',scene:{kind:null,camera_yaw:null,ego_visible:null},points:[],note:''}))
  };
}

export function validateLabelFile(label,{knownFiles=null}={}){
  const problems=[];
  if(!label||label.schema_version!==1)problems.push('schema_version must be 1');
  if(!Array.isArray(label?.frames))return {ok:false,problems:['frames must be an array']};
  const seen=new Set();
  for(const [i,frame] of label.frames.entries()){
    const at=frame?.file??('#'+i);
    if(typeof frame?.file!=='string'||!frame.file||frame.file.includes('/')||frame.file.includes('\\'))problems.push(at+': invalid file name');
    if(knownFiles&&!knownFiles.has(frame?.file))problems.push(at+': file is not part of the recording');
    if(seen.has(frame.file))problems.push(at+': duplicate frame');
    seen.add(frame.file);
    if(!Array.isArray(frame?.points))problems.push(at+': points must be an array');
    for(const [j,point] of (frame?.points??[]).entries()){
      const where=at+' point '+j;
      if(!Number.isFinite(point?.x)||!Number.isFinite(point?.y)||point.x<0||point.x>1||point.y<0||point.y>1){problems.push(where+': x/y must be inside 0..1');continue;}
      if(point.expected==='road')continue;
      if(point.expected!=='hazard'){problems.push(where+': expected must be road or hazard');continue;}
      if(!HAZARD_KINDS.includes(point.kind))problems.push(where+': hazard needs a known kind');
    }
    const kind=frame?.scene?.kind;
    if(kind!==null&&kind!==undefined&&!SCENE_KINDS.includes(kind))problems.push(at+': scene.kind must be null or one of '+SCENE_KINDS.join(','));
  }
  return {ok:problems.length===0,problems,labelled_points:label.frames.reduce((a,f)=>a+(Array.isArray(f.points)?f.points.length:0),0)};
}
