// Sustained-stop evidence from an observation timeline. Evidence only: this
// module never sends input, never recommends braking and never reuses an
// unreadable frame as zero. "Input released" is not "vehicle stopped".
export const STOP_SCOPE='Stop evidence from a series of speed observations only; no input, no brake recommendation, no distance or gear-change confirmation';

const number=(x,min,max)=>Number.isFinite(x)&&x>=min&&x<=max;

function result(state,reason,{evidence=null,speed=null,gear=null,zeroFrames=0,zeroSince=null,zeroSpan=null,motionAfterStop=false,creep=false,release=false}={}){
  return {state,stop_confirmed:state==='stopped',pedal_release_allowed:release,reason,
    motion_after_stop:motionAfterStop,creep_detected:creep,
    zero_frames:zeroFrames,zero_since_ms:zeroSince,zero_span_ms:zeroSpan,
    speed,gear,evidence,scope:STOP_SCOPE};
}

// A zero-speed reading alone is not a stop: the same capture must not be counted
// twice, an unrelated frame timestamp must not be attached, and a gap breaks the
// run instead of bridging it.
export class StopConfirmation {
  #last=null; #watermark=null; #zeroFrames=0; #zeroSince=null; #stopped=false; #movedAfterStop=false; #generation=null; #generationChanged=false;
  constructor({minZeroFrames=3,maxSpeedKmh=1,restartSpeedKmh=2,maxAgeMs=450,maxCaptureMs=450,maxGapMs=250}={}){
    if(!Number.isInteger(minZeroFrames)||minZeroFrames<2||minZeroFrames>30)throw Error('minZeroFrames must be an integer 2..30');
    if(!number(maxSpeedKmh,0,2))throw Error('maxSpeedKmh must be 0..2 km/h');
    if(!number(restartSpeedKmh,maxSpeedKmh,10))throw Error('restartSpeedKmh must be between maxSpeedKmh and 10 km/h');
    if(!number(maxAgeMs,1,450)||!number(maxCaptureMs,1,450)||!number(maxGapMs,1,450))throw Error('Limits must stay inside the 450 ms observation budget');
    Object.assign(this,{minZeroFrames,maxSpeedKmh,restartSpeedKmh,maxAgeMs,maxCaptureMs,maxGapMs});
    this.reset('not_started');
  }
  get stopped(){return this.#stopped;}
  reset(reason='reset'){this.#generation=null;this.#generationChanged=false;this.#last=null;this.#watermark=null;this.#zeroFrames=0;this.#zeroSince=null;this.#stopped=false;this.#movedAfterStop=false;this.last_reset=reason;return this;}
  update(frame){
    const f=frame??{},speed=f.speed,gear=f.gear;
    const evidence={sequence:f.sequence,capture_start_ms:f.capture_start_ms,capture_end_ms:f.capture_end_ms,age_ms:f.age_ms};
    const gearInfo=gear?{valid:gear.valid===true,value:typeof gear.value==='string'?gear.value:null}:null;
    // Rejected frames still advance the chronology watermark, so a resent or older
    // capture can never be taken as a fresh frame after a rejection.
    const fail=reason=>{this.#last=null;this.#zeroFrames=0;this.#zeroSince=null;this.#stopped=false;this.#movedAfterStop=false;this.last_reset=reason;return result('unknown',reason,{evidence,gear:gearInfo});};
    if(!Number.isSafeInteger(f.generation)||f.generation<0)return fail('invalid_generation');
    if(this.#generation!==null&&f.generation!==this.#generation)this.#generationChanged=true;
    if(this.#generationChanged)return fail('generation_changed');
    this.#generation=f.generation;
    if(!Number.isSafeInteger(f.sequence)||f.sequence<1)return fail('invalid_sequence');
    if(!Number.isFinite(f.capture_start_ms)||!Number.isFinite(f.capture_end_ms)||f.capture_start_ms<0||f.capture_end_ms<f.capture_start_ms||f.capture_end_ms-f.capture_start_ms>this.maxCaptureMs)return fail('invalid_capture_interval');
    // Re-sending the same capture (or an older one) must not extend a stop run.
    if(this.#watermark&&(f.sequence<=this.#watermark.sequence||f.capture_start_ms<=this.#watermark.start))return fail('non_increasing_timeline');
    this.#watermark={sequence:f.sequence,start:f.capture_start_ms};
    if(f.age_ms<f.capture_end_ms-f.capture_start_ms)return fail('invalid_observation_age');
    if(!number(f.age_ms,0,this.maxAgeMs))return fail('stale_observation');
    const gap=this.#last?f.capture_start_ms-this.#last.start:null;

    const speedInfo=speed&&Number.isFinite(speed.kmh)?{valid:speed.valid===true,kmh:speed.kmh,time_ms:speed.time_ms}:null;
    const unusable=speed?.valid!==true||!number(speed.kmh,0,200)?(speed?.rejection_reason??'speed_unknown')
      :speed.time_ms!==f.capture_start_ms?'state_frame_mismatch':null;
    // An unreadable/unattached frame breaks the run; it never stays "unknown but still stopped".
    if(unusable){
      const lostMotion=this.#stopped;
      this.#zeroFrames=0;this.#zeroSince=null;this.#stopped=false;
      this.#last={sequence:f.sequence,start:f.capture_start_ms};
      return result('unknown',unusable,{evidence,speed:speedInfo,gear:gearInfo,motionAfterStop:lostMotion});
    }
    const broken=gap!==null&&gap>this.maxGapMs;
    if(broken){this.#zeroFrames=0;this.#zeroSince=null;}
    const wasStopped=this.#stopped&&!broken;
    const zero=speed.kmh<=this.maxSpeedKmh;
    let motionAfterStop=false;
    if(zero){
      this.#zeroFrames+=1;
      if(this.#zeroSince===null)this.#zeroSince=f.capture_start_ms;
    }else{
      motionAfterStop=wasStopped||this.#movedAfterStop;
      this.#movedAfterStop=wasStopped||this.#movedAfterStop&&speed.kmh<=this.restartSpeedKmh;
      this.#zeroFrames=0;this.#zeroSince=null;
    }
    if(zero&&this.#zeroFrames>=this.minZeroFrames)this.#movedAfterStop=false;
    this.#stopped=zero&&this.#zeroFrames>=this.minZeroFrames;
    this.#last={sequence:f.sequence,start:f.capture_start_ms};
    const creep=motionAfterStop&&speed.kmh<=this.restartSpeedKmh;
    const forward=gearInfo?.valid===true&&/^[1-8]$/.test(gearInfo.value);
    // Release of the pedal is only ever argued from current forward-gear zero evidence.
    const release=this.#stopped&&forward&&!motionAfterStop;
    const state=motionAfterStop?'moving':this.#stopped?'stopped':zero?'stopped_unconfirmed':'moving';
    const reason=motionAfterStop?(creep?'creep_after_stop':'motion_after_stop')
      :this.#stopped&&!forward?(gearInfo?.value==='R'?'reverse_gear':gearInfo?.valid?'neutral_or_unsupported_gear':'gear_not_confirmed')
      :this.#stopped?'confirmed_stop'
      :zero?(broken?'observation_gap':'stop_not_yet_confirmed')
      :broken?'observation_gap':'vehicle_moving';
    return result(state,reason,{evidence,speed:speedInfo,gear:gearInfo,zeroFrames:this.#zeroFrames,
      zeroSince:this.#zeroSince,zeroSpan:zero?f.capture_start_ms-this.#zeroSince:null,motionAfterStop,creep,release});
  }
}
