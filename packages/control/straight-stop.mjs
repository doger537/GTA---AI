// Straight drive -> stop skill. One pure decision function shared by offline
// replay and (later) the guarded live path. It proposes commands; the
// DriveSafetyGate and the calibrated envelope remain the only thing that can
// authorize real input, and this module never sends anything.
import {StopConfirmation} from '../perception/stop-confirmation.mjs';

const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const NEUTRAL=Object.freeze({steer:0,throttle:0,brake:0});
const FORWARD=/^[1-8]$/;

export const STRAIGHT_STOP_SCOPE='Image-space straight corridor with a bounded stop; no metric clearance, no lane ownership, no GPS intent, no actuator dispatch';

export class StraightStopSkill {
  constructor({targetKmh=8,maxKmh=12,maxLateralError=0.16,calibration=null,recoverFrames=3,minRoadFraction=0.18,minRows=3,stopOptions={}}={}){
    if(!Number.isFinite(targetKmh)||targetKmh<1||targetKmh>12)throw Error('targetKmh must be 1..12');
    if(!Number.isFinite(maxKmh)||maxKmh<targetKmh||maxKmh>12)throw Error('maxKmh must be between targetKmh and 12');
    if(!Number.isFinite(maxLateralError)||maxLateralError<=0||maxLateralError>0.3)throw Error('maxLateralError must be (0,0.3]');
    if(!Number.isInteger(recoverFrames)||recoverFrames<1||recoverFrames>10)throw Error('recoverFrames must be an integer 1..10');
    if(calibration!==null&&(!Number.isFinite(calibration.maxThrottle)||!Number.isFinite(calibration.maxBrake)||!Number.isFinite(calibration.maxSteer)))throw Error('Calibration envelope needs maxThrottle/maxBrake/maxSteer');
    Object.assign(this,{targetKmh,maxKmh,maxLateralError,calibration,recoverFrames,minRoadFraction,minRows});
    this.stop=new StopConfirmation(stopOptions);
    this.reset();
  }
  reset(){this.steer=0;this.lastStart=null;this.lastSequence=null;this.lastUpdate=null;this.fault=null;this.validRun=0;this.state='READY';this.stop.reset('skill_reset');}
  get calibrationBound(){return this.calibration!==null;}

  // frame: {sequence,capture_start_ms,capture_end_ms,age_ms,state:{speed,gear},vision,stop_requested}
  update(frame){
    const f=frame??{};
    const result=(state,reason,extra={})=>{
      const command=extra.command??NEUTRAL;
      this.state=state;
      return {state,reason,command,
        actuation_allowed:state!=='FAULT'&&this.calibrationBound,
        stop_confirmed:state==='STOPPED',
        // Releasing the pedal is allowed by a confirmed stop on its own, not only
        // by the state; the command still needs the following decision.
        pedal_release_allowed:this.stop.stopped,
        calibration_bound:this.calibrationBound,
        lateral:extra.lateral??null,stop:extra.stop??null,
        evidence:{sequence:f.sequence,capture_start_ms:f.capture_start_ms,age_ms:f.age_ms},
        scope:STRAIGHT_STOP_SCOPE};
    };
    const speed=f.state?.speed,gear=f.state?.gear;

    // Chronology is required even while failing, so a resent frame cannot count
    // twice towards recovery.
    const timelineOk=Number.isSafeInteger(f.sequence)&&Number.isFinite(f.capture_start_ms)&&Number.isFinite(f.capture_end_ms)
      &&f.capture_start_ms>=0&&f.capture_end_ms>=f.capture_start_ms
      &&(this.lastStart===null||(f.sequence>this.lastSequence&&f.capture_start_ms>this.lastStart));
    if(!timelineOk){this.validRun=0;this.fault='invalid_or_repeated_timeline';return result('FAULT',this.fault);}
    this.lastSequence=f.sequence;this.lastStart=f.capture_start_ms;

    const stop=this.stop.update({sequence:f.sequence,capture_start_ms:f.capture_start_ms,capture_end_ms:f.capture_end_ms,age_ms:f.age_ms,speed,gear});

    const reject=reason=>{this.validRun=0;this.fault=reason;return result('FAULT',reason,{stop});};
    if(!Number.isFinite(f.age_ms)||f.age_ms<0||f.age_ms>450)return reject('stale_observation');
    if(f.capture_end_ms-f.capture_start_ms>450)return reject('observation_capture_too_long');
    if(speed?.valid!==true||!Number.isFinite(speed.kmh)||speed.kmh<0||speed.kmh>200)return reject(speed?.rejection_reason??'speed_unreadable');
    if(gear?.valid!==true||typeof gear.value!=='string')return reject('gear_unknown');
    if(gear.value==='R')return reject('reverse_not_supported');
    if(!FORWARD.test(gear.value))return reject('neutral_not_supported');
    const p=f.vision;
    if(!p||!Number.isFinite(p.road_fraction)||p.road_fraction<this.minRoadFraction)return reject('road_uncertain');
    if(!Array.isArray(p.rows)||p.rows.length<this.minRows)return reject('no_visible_corridor');

    // Same image-space corridor gate as the visual follower: stay near the
    // projected heading, never aim at the middle of all visible lanes.
    const rows=p.rows.filter(r=>r&&Number.isFinite(r.y)&&Number.isFinite(r.left)&&Number.isFinite(r.right)&&r.y<=.54&&r.right-r.left>=(r.y<=.48?.10:.16));
    if(rows.length<2)return reject('no_visible_corridor');
    const targets=rows.map(r=>{const margin=Math.min(.05,(r.right-r.left)*.2);return clamp(.5,r.left+margin,r.right-margin);});
    const target=targets.reduce((a,b)=>a+b,0)/targets.length;
    this.validRun+=1;
    const lateral={target_x:target,error:target-.5,rows:rows.length,vehicles:Array.isArray(p.vehicles)?p.vehicles.length:0};

    // Leaving a fault needs several consecutive valid frames, never the one good
    // frame that happened to arrive after the loss. Geometry problems are
    // re-evaluated on the current frame: a road that is visible again is visible.
    if(this.fault!==null&&this.validRun<this.recoverFrames
      &&!['large_heading_correction_required','connected_road_too_short','projected_heading_not_on_road','turn_branch_not_resolved','connected_road_unknown'].includes(this.fault))return result('FAULT',this.fault,{stop,lateral});

    if(Math.abs(target-.5)>this.maxLateralError)return reject('large_heading_correction_required');
    // The current frame is usable again: a stale lateral fault is not carried on.
    if(this.fault==='large_heading_correction_required')this.fault=null;

    const dt=this.lastUpdate===null?.1:clamp((f.capture_start_ms-this.lastUpdate)/1000,.05,.25);
    this.lastUpdate=f.capture_start_ms;
    const goal=clamp((target-.5)*2,-.3,.3);
    this.steer+=clamp(goal-this.steer,-.4*dt,.4*dt);
    const steer=this.calibrationBound?clamp(this.steer,-this.calibration.maxSteer,this.calibration.maxSteer):this.steer;

    // A stop requested and then verified is the end of the skill; this must be
    // checked before the pending braking branch or the pedal is never released.
    if(stop.state==='stopped')return result('STOPPED','stop_confirmed',{command:NEUTRAL,stop,lateral});
    if(stop.reason==='reverse_gear'||stop.reason==='neutral_or_unsupported_gear')return reject(stop.reason);

    const brakingRequested=Boolean(f.stop_requested)||speed.kmh>this.maxKmh;
    if(brakingRequested){
      if(!this.calibrationBound)return result('BRAKING','braking_requires_calibration',{command:{steer,throttle:0,brake:0},stop,lateral});
      const brake=clamp(speed.kmh>this.maxKmh?.45:this.calibration.maxBrake,0,this.calibration.maxBrake);
      return result('BRAKING',speed.kmh>this.maxKmh?'over_max_speed':'stop_requested',{command:{steer,throttle:0,brake},stop,lateral});
    }
    // A confirmed zero with no stop request is READY, not "follow".
    if(speed.kmh<=1&&stop.state!=='moving')return result('READY','stationary_ready',{command:NEUTRAL,stop,lateral});
    const error=this.targetKmh-speed.kmh;
    if(!this.calibrationBound)return result('ACCELERATE','proposal_only_calibration_missing',{command:{steer,throttle:clamp(error/8,.15,.45),brake:0},stop,lateral});
    const throttle=error>0.5?clamp(error/8,.15,this.calibration.maxThrottle):0;
    return result(throttle>0?'ACCELERATE':'HOLD','inside_envelope',{command:{steer,throttle,brake:0},stop,lateral});
  }
}
