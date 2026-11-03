import {INTENTS} from './navigation-context.mjs';
// Image-space paths only. This is not metric camera calibration or a lane detector.
export function roadGeometry(p,intent){
  const w=p.gridWidth,h=p.gridHeight;
  if(!p.road||!w||!h)return {valid:false,reason:'no_semantic_road'};
  const at=(x,y,array=p.road)=>array[Math.min(h-1,Math.max(0,Math.floor(y*h)))*w+Math.min(w-1,Math.max(0,Math.floor(x*w)))];
  let nearY=null;
  for(const y of [.50,.48,.46,.44])if(at(.5,y)){nearY=y;break;}
  if(nearY===null)return {valid:false,reason:'projected_heading_not_on_road'};
  let farY=null,runs=[];
  for(const distance of [.12,.10,.08,.06,.04]){
    const y=nearY-distance,iy=Math.floor(y*h),found=[];let start=-1;
    for(let x=0;x<=w;x++){const on=x<w&&p.road[iy*w+x];if(on&&start<0)start=x;if(!on&&start>=0){if(x-start>=3)found.push({left:start/w,right:x/w});start=-1;}}
    if(found.some(r=>r.right>.3&&r.left<.7)){farY=y;runs=found;break;}
  }
  if(!runs.length)return {valid:false,reason:'no_far_road'};
  let run;
  if(intent==='left'||intent==='right'){
    // A single wide patch is not proof of an intersection branch.
    if(runs.length<2)return {valid:false,reason:'turn_branch_not_resolved'};
    run=intent==='left'?runs[0]:runs.at(-1);
  }else run=[...runs].sort((a,b)=>Math.abs((a.left+a.right)/2-.5)-Math.abs((b.left+b.right)/2-.5))[0];
  const margin=Math.min(.02,(run.right-run.left)/4),endX=Math.max(run.left+margin,Math.min(run.right-margin,.5));
  if((intent==='left'&&endX>=.44)||(intent==='right'&&endX<=.56))return {valid:false,reason:'turn_branch_direction_uncertain'};
  const points=Array.from({length:16},(_,i)=>{const t=i/15;return {x:.5+(endX-.5)*t,y:nearY+(farY-nearY)*t};});
  const roadSupport=points.filter(q=>at(q.x,q.y)).length/points.length;
  const blocked=points.some(q=>p.obstacle&&at(q.x,q.y,p.obstacle));
  if(roadSupport<.85||blocked)return {valid:false,reason:blocked?'path_crosses_semantic_obstacle':'path_leaves_visible_road',road_support:roadSupport};
  return {valid:true,points,near_offset:0,far_offset:(endX-.5)/.25,curvature:0,road_support:roadSupport,scope:'image-space road corridor; lane ownership and metric clearance unknown'};
}
export function steeringFeatures(geometry,state){
  if(!geometry?.valid||!state?.speed?.valid||!Number.isFinite(state.speed.kmh))throw Error('Valid geometry and measured speed required');
  return [geometry.near_offset,geometry.far_offset,Math.min(120,state.speed.kmh)/120,geometry.curvature];
}
export function guidanceGate({navigation,state,geometry,age_ms}){
  const result=(allow,reason)=>({allow_shadow_proposal:allow,drive_allowed:false,reason});
  if(!Number.isFinite(age_ms)||age_ms<0||age_ms>450)return result(false,'stale_observation');
  if(!navigation?.valid||!INTENTS.includes(navigation.intent))return result(false,'navigation_unknown');
  if(navigation.intent==='stop')return result(false,'navigation_stop');
  if(!state?.gear?.valid||!state?.speed?.valid)return result(false,'vehicle_state_unknown');
  if(!Number.isFinite(state.speed.kmh)||state.speed.kmh<0||state.speed.kmh>120)return result(false,'speed_outside_model_range');
  if(!/^[1-8]$/.test(state.gear.value))return result(false,'reverse_or_neutral_not_supported');
  if(!geometry?.valid)return result(false,geometry?.reason??'road_unknown');
  return result(true,'shadow_proposal_only');
}
