// Metric controller core. Only calibrated sensor data may authorize acceleration.
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
export class Controller {
  constructor(){this.steer=0;this.lastTime=null;}
  update(s){
    const fail=reason=>{this.steer=0;return {throttle:0,brake:1,steer:0,state:'STOP',reason};};
    const now=s?.time_ms;
    if(!Number.isFinite(now)||now<0){this.lastTime=null;return fail('invalid_capture_time');}
    if(this.lastTime!==null&&now<=this.lastTime)return fail('non_increasing_capture_time');
    const dt=this.lastTime===null?.1:clamp((now-this.lastTime)/1000,.01,.25);this.lastTime=now;
    if(!Number.isFinite(s.frame_age_ms)||s.frame_age_ms<0||s.frame_age_ms>300)return fail('stale_frame');
    if(s.camera_calibrated!==true || s.speed_valid!==true || !Number.isFinite(s.speed_mps) || s.speed_mps<0)return fail('uncalibrated_speed_or_camera');
    if(!Number.isFinite(s.road_confidence)||s.road_confidence<.75 || !Array.isArray(s.paths) || !s.paths.length)return fail('road_uncertain');
    const v=s.speed_mps,a=s.braking_mps2;
    if(!Number.isFinite(a)||a<1||a>12)return fail('braking_not_calibrated');
    const stoppingDistance=v*.45+v*v/(2*a)+3;
    const candidates=s.paths.filter(p=>Number.isFinite(p.clearance_m)&&Number.isFinite(p.offset_m)&&Number.isFinite(p.heading_error_rad)&&Number.isFinite(p.curvature)&&p.clearance_m>stoppingDistance&&Math.abs(p.offset_m)<4&&p.confidence>=.75);
    if(!candidates.length)return fail('no_clear_corridor');
    candidates.sort((a,b)=>(Math.abs(a.offset_m)+Math.abs(a.heading_error_rad)*2)-(Math.abs(b.offset_m)+Math.abs(b.heading_error_rad)*2));
    const path=candidates[0];
    if(!Array.isArray(s.obstacles)||s.obstacles.some(o=>![o.lateral_m,o.closing_mps,o.distance_m].every(Number.isFinite)))return fail('obstacle_data_invalid');
    const ttc=s.obstacles.filter(o=>Math.abs(o.lateral_m-path.offset_m)<1.8&&o.closing_mps>0).map(o=>o.distance_m/o.closing_mps);
    if(ttc.some(t=>t<2.5))return fail('collision_time_low');
    const curve=Number.isFinite(path.curvature)?Math.abs(path.curvature):0;
    const targetSpeed=Math.min(8,Math.sqrt(1.5/Math.max(curve,.001)),Math.sqrt(Math.max(0,2*a*(path.clearance_m-3))));
    const targetSteer=clamp(path.heading_error_rad*.9+Math.atan2(path.offset_m,Math.max(5,v*1.2)),-.6,.6);
    this.steer+=clamp(targetSteer-this.steer,-.7*dt,.7*dt);
    const speedError=targetSpeed-v;
    return {throttle:clamp(speedError*.18,0,.45),brake:clamp(-speedError*.25,0,1),steer:this.steer,state:'FOLLOW',target_speed_mps:targetSpeed,stopping_distance_m:stoppingDistance,chosen_offset_m:path.offset_m};
  }
}

// Perception alone has no trustworthy metric speed, distance or camera calibration.
// Shadow predictions must therefore remain stopped until a calibrated estimator is implemented.
export function shadowSensors(p,frame){return {time_ms:performance.now(),frame_age_ms:frame.frame_age_ms+p.inference_ms,camera_calibrated:false,speed_valid:false,road_confidence:p.confidence,paths:[]};}
