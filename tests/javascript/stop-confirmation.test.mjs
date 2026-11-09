import {test} from 'node:test';import {strict as assert} from 'node:assert';
import {StopConfirmation} from '../../packages/perception/stop-confirmation.mjs';

// Synthetic timelines only. No GTA frame, no calibration and no input.
let clock=0,ticks=0;
const frame=({kmh=0,gear='2',age=50,span=10,gap=100,invalid=null,timeOffset=0}={})=>{
  clock+=gap;const start=clock;
  const speed=invalid?{valid:false,kmh:null,time_ms:start,rejection_reason:invalid}:{valid:true,kmh,time_ms:start+timeOffset};
  return {sequence:++ticks,generation:1,capture_start_ms:start,capture_end_ms:start+span,age_ms:age,speed,gear:{valid:gear!=='?',value:gear==='?'?null:gear}};
};
const fresh=opts=>{clock=0;return new StopConfirmation(opts);};

test('a stop needs several fresh forward-gear zeros and never one dash',()=>{
 const s=fresh();
 assert.equal(s.update(frame({kmh:0})).state,'stopped_unconfirmed');
 assert.equal(s.update(frame({kmh:0})).state,'stopped_unconfirmed');
 const third=s.update(frame({kmh:0}));
 assert.equal(third.state,'stopped');assert.equal(third.stop_confirmed,true);assert.equal(third.pedal_release_allowed,true);
 assert.equal(third.zero_frames,3);assert.equal(third.zero_span_ms,200);assert.equal(third.reason,'confirmed_stop');
 // One verified dash frame is a stop; an unverified one is not.
 const dashed=fresh();for(let i=0;i<3;i++)dashed.update(frame({invalid:'unverified_zero_dash'}));
 assert.equal(dashed.update(frame({invalid:'unverified_zero_dash'})).state,'unknown');
 assert.equal(dashed.stopped,false);
});

test('unreadable speed resets the run instead of carrying the previous zero',()=>{
 const s=fresh();s.update(frame({kmh:0}));s.update(frame({kmh:0}));
 const lost=s.update(frame({invalid:'ocr_unconfirmed'}));
 assert.equal(lost.state,'unknown');assert.equal(lost.reason,'ocr_unconfirmed');assert.equal(lost.stop_confirmed,false);
 assert.equal(s.update(frame({kmh:0})).zero_frames,1);
 assert.equal(s.update(frame({kmh:0})).state,'stopped_unconfirmed');
});

test('resent or out-of-order captures cannot extend a stop',()=>{
 const s=fresh();s.update(frame({kmh:0}));s.update(frame({kmh:0}));
 const last=frame({kmh:0});s.update(last);const replay=s.update({...last,sequence:last.sequence-1});
 assert.equal(replay.state,'unknown');assert.equal(replay.reason,'non_increasing_timeline');
 assert.equal(s.stopped,false);
 // A newer sequence number cannot make an older capture new again.
 const older={...last,sequence:last.sequence+1,capture_start_ms:last.capture_start_ms-10,capture_end_ms:last.capture_end_ms-10,speed:{...last.speed,time_ms:last.speed.time_ms-10}};
 assert.equal(s.update(older).reason,'non_increasing_timeline');
});

test('a gap over 250 ms breaks the run; stale or long captures are unknown',()=>{
 const s=fresh();s.update(frame({kmh:0}));s.update(frame({kmh:0}));
 const gapped=s.update(frame({kmh:0,gap:400}));
 assert.equal(gapped.state,'stopped_unconfirmed');assert.equal(gapped.zero_frames,1);assert.equal(gapped.reason,'observation_gap');
 assert.equal(fresh().update(frame({age:451})).reason,'stale_observation');
 assert.equal(fresh().update(frame({span:460})).reason,'invalid_capture_interval');
 assert.equal(fresh().update({...frame(),sequence:0}).reason,'invalid_sequence');
 assert.equal(fresh().update(frame({timeOffset:1})).reason,'state_frame_mismatch');
});

test('motion after a confirmed stop is reported, and creep is separated from real driving',()=>{
 const s=fresh();for(let i=0;i<3;i++)s.update(frame({kmh:0}));
 // 0..1 km/h counts as stationary; creep is the narrow 1..2 km/h band.
 const creep=s.update(frame({kmh:2}));
 assert.equal(creep.state,'moving');assert.equal(creep.motion_after_stop,true);assert.equal(creep.creep_detected,true);
 assert.equal(creep.reason,'creep_after_stop');assert.equal(creep.pedal_release_allowed,false);
 assert.equal(creep.stop_confirmed,false);
 const drive=fresh();for(let i=0;i<3;i++)drive.update(frame({kmh:0}));
 const moving=drive.update(frame({kmh:9}));
 assert.equal(moving.creep_detected,false);assert.equal(moving.reason,'motion_after_stop');
});

test('reverse or neutral at zero never authorizes pedal release',()=>{
 for(const gear of ['R','N','?']){
  const s=fresh();let r;for(let i=0;i<3;i++)r=s.update(frame({kmh:0,gear}));
  assert.equal(r.stop_confirmed,true,'geometry of motion is still stopped for '+gear);
  assert.equal(r.pedal_release_allowed,false);
  assert.equal(r.reason,gear==='R'?'reverse_gear':gear==='N'?'neutral_or_unsupported_gear':'gear_not_confirmed');
 }
 const s=fresh();s.update(frame({kmh:0}));s.update(frame({kmh:0}));
 const slower=fresh({minZeroFrames:4});
 slower.update(frame({kmh:0}));slower.update(frame({kmh:0}));slower.update(frame({kmh:0}));
 assert.equal(slower.update(frame({kmh:0})).zero_frames,4);
});

test('generation changes latch and stale captures cannot be replayed as fresh',()=>{
 const s=fresh();for(let i=0;i<3;i++)s.update(frame());const stale=frame({age:451});s.update(stale);
 assert.equal(s.update({...stale,age_ms:50}).reason,'non_increasing_timeline');
 const changed={...frame(),generation:2};assert.equal(s.update(changed).reason,'generation_changed');
 assert.equal(s.update(frame()).reason,'generation_changed');s.reset();assert.equal(s.update(changed).state,'stopped_unconfirmed');
 assert.equal(s.update({...frame(),generation:undefined}).reason,'invalid_generation');
});
