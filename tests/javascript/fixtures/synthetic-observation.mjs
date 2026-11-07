// Explicitly synthetic packet/measurements. No GTA frame, label or calibration.
import {observationGeometry} from '../../../packages/protocols/observation-stream.mjs';
export function observation(sequence=1,{generation=7,received=0,age=100}={}){
  const capture_start_ms=1000+sequence*50,capture_end_ms=capture_start_ms+10;
  const timing={sequence,generation,capture_start_ms,capture_end_ms,frame_age_ms:age,delivery_ms:0,received_at_ms:received};
  return {...timing,source:'single_capture',capture_skew_ms:0,road:{...timing,mimeType:'image/jpeg',bytes:Buffer.from('synthetic road')},hud:{...timing,mimeType:'image/png',bytes:Buffer.from('synthetic hud'),hud:{full_width:2000,full_height:1000,left:1640,top:760,width:260,height:140}},minimap:{...timing,mimeType:'image/png',bytes:Buffer.from('synthetic map'),region:{left:0,top:720,width:500,height:280}},navigation:{valid:true,intent:'lane_follow',source:'user',issued_ms:1,expires_ms:10000,sequence:1}};
}
export const status=(generation=7)=>({target_found:true,foreground:true,busy:false,generation,input_owner:null,input_state:'disarmed',ownership_supported:true,decision_deadline_supported:true,drive_safety_supported:true});
export const state=o=>({time_ms:o.capture_start_ms,speed:{valid:true,kmh:0,time_ms:o.capture_start_ms,source:'synthetic-test'},gear:{valid:true,value:'1'}});
export const source=o=>({sequence:o.sequence,generation:o.generation,capture_start_ms:o.capture_start_ms});
export function context(o){return {observation:o,state:state(o),status:status(o.generation),vehicle_id:'synthetic-unit-car',camera_profile:'rear',navigation:o.navigation,identity:{verified:true,vehicle_id:'synthetic-unit-car',source:source(o)},heading:{verified:true,relative_yaw_rad:0,source:source(o)},metric:{source:source(o),road_confidence:.9,paths:[{clearance_m:30,offset_m:0,heading_error_rad:0,curvature:0,confidence:.9}],obstacles:[]}};}
export const profile=()=>({vehicle_id:'synthetic-unit-car',actuator_kind:'gamepad',camera_profile:'rear',observation_geometry:observationGeometry(observation())});
