import {INTENTS} from './navigation-context.mjs';
import {connectedRoadGeometry} from '../perception/road-corridor.mjs';
// Image-space paths only. This is not metric camera calibration or a lane detector.
export const roadGeometry=connectedRoadGeometry;
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
