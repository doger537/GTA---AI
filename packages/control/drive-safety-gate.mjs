import {validateObservation,observationGeometry} from '../protocols/observation-stream.mjs';
import {frameAge} from '../protocols/bridge-client.mjs';
import {DecisionLease} from '../actuation/decision-lease.mjs';
import {calibrationReadiness} from './calibration-readiness.mjs';
import {isCalibrationEvidence} from './calibration-evidence.mjs';
import {Controller} from './controller.mjs';

const permits=new WeakMap();
const commandKey=c=>JSON.stringify([c?.steer,c?.throttle,c?.brake]);
const matches=(a,b)=>a&&b&&['sequence','generation','capture_start_ms'].every(k=>a[k]===b[k]);
const commandValid=c=>c&&[c.steer,c.throttle,c.brake].every(Number.isFinite)&&Math.abs(c.steer)<=1&&c.throttle>=0&&c.throttle<=1&&c.brake>=0&&c.brake<=1&&!(c.throttle>0&&c.brake>0);
const result=(allowed,reason)=>({allowed,drive_allowed:allowed,reason});

export function inspectDrivePermit(permit){const p=permits.get(permit);if(!p)throw Error('DriveSafetyGate permit required');const [steer,throttle,brake]=JSON.parse(p.command);return {scope:p.scope,mode:p.gate.mode,kind:p.gate.kind,source:{...p.source},command:p.scope==='command'?{steer,throttle,brake}:null};}
export function assertDrivePermit(permit,{scope='command',kind,command,source,mode}={}){
  const p=permits.get(permit);
  const now=p?.gate.clock();if(!p||!Number.isFinite(now)||now<p.gate.armedAt||p.scope!==scope||p.epoch!==p.gate.epoch||!p.gate.armed||now>=p.expires||kind&&kind!==p.gate.kind||mode&&mode!==p.gate.mode)throw Error('DriveSafetyGate permit missing, expired or revoked');
  if(scope==='command'&&(!commandValid(command)||commandKey(command)!==p.command||!matches(source,p.source)||source.decision_expires_ms!==undefined&&source.decision_expires_ms>p.source.decision_expires_ms))throw Error('DriveSafetyGate command/source mismatch');
  return inspectDrivePermit(permit);
}
export function revokeDrivePermit(permit){const p=permits.get(permit);if(p)p.gate.revoke('explicit_stop');}

// Modes are explicit: autonomous requires measured calibration/metric state;
// calibration is bounded operator work; diagnostics never authorize pedals.
export class DriveSafetyGate {
  #epoch; #armed; #history; #context; #key; #last; #lease; #armedAt;
  get armed(){return this.#armed;}
  get epoch(){return this.#epoch;}
  get armedAt(){return this.#armedAt;}
  constructor({mode='autonomous',kind='gamepad',calibration=null,clock=()=>performance.now(),leaseMs=250}={}){
    if(!['autonomous','calibration','diagnostic'].includes(mode)||!['keyboard','gamepad'].includes(kind)||mode!=='autonomous'&&kind!=='gamepad')throw Error('Invalid safety gate mode');
    for(const [name,value] of Object.entries({mode,kind,calibration,clock,leaseMs}))Object.defineProperty(this,name,{value,enumerable:true});this.#epoch=0;this.#armed=false;this.#history=[];this.#context=null;this.#key=null;this.#last=null;this.#lease=new DecisionLease({leaseMs,clock});
  }
  preflight(){if(this.mode==='autonomous'){if(!isCalibrationEvidence(this.calibration))return result(false,'verified_calibration_bundle_required');if(this.calibration.profile.actuator_kind!==this.kind)return result(false,'calibration_input_backend_mismatch');}return result(true,'preflight_ready');}
  revoke(reason){this.#armed=false;this.#epoch++;this.#history=[];this.fault=reason;}
  observe(context){
    try{
      const o=context.observation;const age=validateObservation(o,{clock:this.clock});
      const key=JSON.stringify([o.generation,observationGeometry(o),context.vehicle_id,context.camera_profile]);
      if(this.#key!==null&&key!==this.#key){this.revoke('context_changed');this.#last=null;}
      if(this.#last&&(o.sequence<this.#last.sequence||o.sequence>this.#last.sequence&&o.capture_start_ms<=this.#last.capture_start_ms))throw Error('Non-increasing gate observation');
      const state=structuredClone(context.state);
      if(state?.time_ms!==o.capture_start_ms||state?.speed?.time_ms!==o.capture_start_ms)throw Error('Vehicle state belongs to another frame');
      const signature=JSON.stringify(state);
      if(this.#last&&o.sequence===this.#last.sequence&&(o.capture_start_ms!==this.#last.capture_start_ms||signature!==this.#last.signature))throw Error('Observation identity changed');
      const packet={...o,road:{...o.road},hud:{...o.hud,hud:{...o.hud.hud}},minimap:{...o.minimap,region:{...o.minimap.region}}};
      this.#context={...context,observation:packet,state,metric:structuredClone(context.metric),heading:structuredClone(context.heading),identity:structuredClone(context.identity),navigation:structuredClone(context.navigation),status:{...context.status}};
      if(!this.#last||o.sequence!==this.#last.sequence){
        this.#history.push({sequence:o.sequence,start_ms:o.capture_start_ms,end_ms:o.capture_end_ms,age_ms:age,state});this.#history=this.#history.slice(-3);
      }
      this.#key=key;this.#last={sequence:o.sequence,capture_start_ms:o.capture_start_ms,signature};
      const verdict=this.evaluate({startup:!this.#armed});
      if(this.#armed&&!verdict.allowed)this.revoke(verdict.reason);
      return verdict;
    }catch(error){this.#context=null;this.#last=null;this.revoke(error.message);return result(false,error.message);}
  }
  evaluate({startup=false}={}){
    const preflight=this.preflight();if(!preflight.allowed)return preflight;
    const c=this.#context;if(!c)return result(false,'observation_required');
    if(this.#armed&&this.clock()-this.#armedAt>(this.mode==='calibration'?2500:this.mode==='diagnostic'?1000:15000))return result(false,'bounded_session_expired');
    const o=c.observation;let age;
    try{age=validateObservation(o,{clock:this.clock});}catch(error){return result(false,error.message);}
    const status=c.status;
    if(status?.target_found!==true||status.foreground!==true||typeof status.busy!=='boolean'||status.generation!==o.generation||status.busy&&!(this.#armed&&status.input_owner===this.kind)||status.input_owner&&status.input_owner!==this.kind)return result(false,'focus_or_owner_changed');
    if(status.ownership_supported!==true||status.decision_deadline_supported!==true||status.drive_safety_supported!==true)return result(false,'modern_input_bridge_required');
    if(!['rear','hood'].includes(c.camera_profile)||typeof c.vehicle_id!=='string'||!c.vehicle_id)return result(false,'explicit_vehicle_and_camera_profile_required');
    const s=c.state;
    if(s?.speed?.valid!==true||!Number.isFinite(s.speed.kmh)||s.speed.kmh<0||s?.gear?.valid!==true||typeof s.gear.value!=='string'||!/^[1-8]$/.test(s.gear.value))return result(false,'forward_vehicle_state_required');
    if(startup){const ready=calibrationReadiness(this.#history,{latestAgeMs:age});if(!ready.ready)return result(false,ready.reason);}
    if(this.mode==='diagnostic')return s.speed.kmh<=1?result(true,'stationary_zero_pedal_diagnostic'):result(false,'diagnostic_vehicle_moving');
    if(this.mode==='calibration')return s.speed.kmh<=12?result(true,'bounded_operator_calibration'):result(false,'calibration_speed_limit');
    const calibration=this.calibration;
    if([s.speed.source,s.gear.source].some(x=>typeof x==='string'&&x.startsWith('operator')))return result(false,'operator_labels_are_not_autonomous_state');
    if(c.vehicle_id!==calibration.profile.vehicle_id||c.camera_profile!==calibration.profile.camera_profile||observationGeometry(o)!==calibration.profile.observation_geometry)return result(false,'calibration_profile_mismatch');
    if(c.identity?.verified!==true||c.identity.vehicle_id!==c.vehicle_id||!matches(c.identity.source,o)||c.heading?.verified!==true||!Number.isFinite(c.heading.relative_yaw_rad)||Math.abs(c.heading.relative_yaw_rad)>.15||!matches(c.heading.source,o))return result(false,'current_vehicle_heading_unverified');
    if(s.speed.kmh>calibration.maxSpeedKmh)return result(false,'outside_calibrated_speed_range');
    const n=c.navigation;
    if(n?.valid!==true||!['user','planner','gps'].includes(n.source)||!['lane_follow','straight','left','right'].includes(n.intent)||!Number.isSafeInteger(n.issued_ms)||!Number.isSafeInteger(n.expires_ms)||n.issued_ms<0||n.expires_ms<=n.issued_ms||n.issued_ms>o.capture_start_ms||n.expires_ms<o.capture_end_ms||n.expires_ms<=o.capture_start_ms+age)return result(false,'navigation_unknown_or_expired');
    if(!c.metric||!matches(c.metric.source,o))return result(false,'current_metric_state_required');
    if(!Number.isFinite(c.metric.road_confidence)||c.metric.road_confidence<0||c.metric.road_confidence>1||!Array.isArray(c.metric.paths)||c.metric.paths.length>64||!Array.isArray(c.metric.obstacles)||c.metric.obstacles.length>256||c.metric.obstacles.some(x=>!x||![x.distance_m,x.closing_mps,x.lateral_m].every(Number.isFinite)||x.distance_m<0))return result(false,'invalid_metric_state');
    const sensors={...c.metric,time_ms:o.capture_start_ms,frame_age_ms:age,camera_calibrated:true,speed_valid:true,speed_mps:s.speed.kmh/3.6,max_speed_mps:calibration.maxSpeedKmh/3.6,braking_mps2:calibration.brakingMps2};
    try{const verdict=new Controller().update(sensors);return verdict.state==='FOLLOW'?result(true,'calibrated_current_observation'):result(false,verdict.reason);}catch{return result(false,'invalid_metric_state');}
  }
  arm(){this.#armed=false;const verdict=this.evaluate({startup:true});if(!verdict.allowed){this.revoke(verdict.reason);throw Error('DriveSafetyGate: '+verdict.reason);}this.#epoch++;this.#armed=true;this.#armedAt=this.clock();this.fault=null;this.#lease=new DecisionLease({leaseMs:this.leaseMs,clock:this.clock});return this.#mint('startup');}
  authorize(command){
    if(!this.#armed)throw Error('DriveSafetyGate: explicit arm required');
    const verdict=this.evaluate();let reason=verdict.allowed?'invalid_control_command':verdict.reason;
    let valid=verdict.allowed&&commandValid(command)&&(!('duration_ms' in command)||Number.isInteger(command.duration_ms)&&command.duration_ms>=20&&command.duration_ms<=this.leaseMs);
    if(valid&&this.mode==='diagnostic'){valid=command.throttle===0&&command.brake===0&&Math.abs(command.steer)<=.4;reason='diagnostic_pedals_or_steer_limit';}
    if(valid&&this.mode==='calibration'){valid=command.throttle<=.5&&command.brake<=.45&&Math.abs(command.steer)<=.35&&(command.brake===0||this.#context.state.speed.kmh>1);reason='calibration_command_limit';}
    if(valid&&this.mode==='autonomous'){
      const c=this.#context,cal=this.calibration,proposal=new Controller().update({...c.metric,time_ms:c.observation.capture_start_ms,frame_age_ms:frameAge(c.observation.road,this.clock()),camera_calibrated:true,speed_valid:true,speed_mps:c.state.speed.kmh/3.6,max_speed_mps:cal.maxSpeedKmh/3.6,braking_mps2:cal.brakingMps2});
      valid=command.throttle<=Math.min(cal.maxThrottle,proposal.throttle)+1e-12&&command.brake<=cal.maxBrake&&Math.abs(command.steer)<=cal.maxSteer&&(command.brake===0||c.state.speed.kmh>1);reason='autonomous_command_limit';
    }
    if(!valid){this.revoke(reason);throw Error('DriveSafetyGate: '+reason);}
    return this.#mint('command',command);
  }
  #mint(scope,command){
    const o=this.#context.observation,age=Math.max(...['road','hud','minimap'].map(k=>frameAge(o[k],this.clock())));
    this.#lease.update({...o,age_ms:age});const source=this.#lease.wireSource();
    const budget=this.mode==='calibration'?2500:this.mode==='diagnostic'?1000:15000;
    const expires=Math.min(this.#lease.expires,this.#armedAt+budget);source.decision_expires_ms=Math.min(source.decision_expires_ms,Math.floor(o.capture_start_ms+age+Math.max(0,expires-this.clock())));
    const token=Object.freeze({type:'DriveSafetyGatePermit'});
    permits.set(token,{gate:this,epoch:this.#epoch,scope,source,command:commandKey(command),expires});return token;
  }
}
