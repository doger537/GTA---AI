import {test} from 'node:test';import {strict as assert} from 'node:assert';
import {StraightStopSkill} from '../../packages/control/straight-stop.mjs';

const calibration={maxThrottle:.35,maxBrake:.35,maxSteer:.3};
const rows=[{y:.48,left:.3,right:.7,center:.5},{y:.54,left:.28,right:.72,center:.5},{y:.60,left:.3,right:.7,center:.5}];
let tick=0;
const frame=(overrides={})=>{
  tick+=1;
  const {kmh=5,gear='2',age=100,vision,stop_requested=false,sequence=tick,start=1000+tick*100,span=10}=overrides;
  return {sequence,capture_start_ms:start,capture_end_ms:start+span,age_ms:age,
    state:{speed:{valid:true,kmh,time_ms:start},gear:{valid:true,value:gear}},
    vision:vision===undefined?{road_fraction:.4,rows,vehicles:[]}:vision,stop_requested};
};
const skill=options=>{tick=0;return new StraightStopSkill(options);};

test('without calibration the skill only proposes and never authorizes actuation',()=>{
 const s=skill(),r=s.update(frame({kmh:3}));
 assert.equal(r.state,'ACCELERATE');assert.equal(r.reason,'proposal_only_calibration_missing');
 assert.equal(r.actuation_allowed,false);assert.ok(r.command.throttle>0);
 assert.equal(r.scope.includes('no actuator dispatch'),true);
});

test('with calibration it drives, keeps the envelope and stops on request',()=>{
 const s=skill({calibration});
 const drive=s.update(frame({kmh:3}));
 assert.equal(drive.state,'ACCELERATE');assert.equal(drive.actuation_allowed,true);
 assert.ok(drive.command.throttle<=calibration.maxThrottle);assert.ok(Math.abs(drive.command.steer)<=calibration.maxSteer);
 const brake=s.update(frame({kmh:6,stop_requested:true}));
 assert.equal(brake.state,'BRAKING');assert.ok(brake.command.brake<=calibration.maxBrake);assert.equal(brake.command.throttle,0);
 const over=s.update(frame({kmh:13}));
 assert.equal(over.reason,'over_max_speed');assert.ok(over.command.brake>0);
});

test('a confirmed stop is the only state that allows releasing the pedal',()=>{
 const s=skill({calibration});
 const sixth=s.update(frame({kmh:6,stop_requested:true}));
 assert.equal(sixth.state,'BRAKING');
 const second=s.update(frame({kmh:0,stop_requested:true}));
 assert.equal(second.state,'BRAKING');assert.equal(second.stop_confirmed,false);
 const third=s.update(frame({kmh:0,stop_requested:true}));
 const fourthStop=s.update(frame({kmh:0,stop_requested:true}));
 assert.equal(third.state,'BRAKING');
 assert.equal(fourthStop.state,'STOPPED');
 assert.equal(fourthStop.stop_confirmed,true);assert.equal(fourthStop.pedal_release_allowed,true);
 assert.deepEqual(fourthStop.command,{steer:0,throttle:0,brake:0});
 const moved=s.update(frame({kmh:2}));
 assert.notEqual(moved.state,'STOPPED');assert.equal(moved.pedal_release_allowed,false);
});

test('each lost input is an explicit refusal with no gas',()=>{
 const cases=[[frame({age:451}),'stale_observation'],[frame({kmh:NaN}),'speed_unreadable'],
  [frame({gear:'R'}),'reverse_not_supported'],[frame({gear:'N'}),'neutral_not_supported'],
  [frame({vision:{road_fraction:.05,rows,vehicles:[]}}),'road_uncertain'],
  [frame({vision:{road_fraction:.4,rows:[],vehicles:[]}}),'no_visible_corridor'],
  [frame({vision:{road_fraction:.4,rows:[{y:.48,left:.7,right:.99,center:.85},{y:.54,left:.7,right:.99,center:.85},{y:.60,left:.7,right:.99,center:.85}],vehicles:[]}}),'large_heading_correction_required'],
  [frame({span:460}),'observation_capture_too_long']];
 for(const [input,reason] of cases){
  const s=skill({calibration}),r=s.update(input);
  assert.equal(r.state,'FAULT',reason);assert.equal(r.reason,reason);
  assert.equal(r.command.throttle,0);assert.equal(r.stop_confirmed,false);
 }
});

test('recovery needs several consecutive valid frames, not one lucky frame',()=>{
 const s=skill({calibration,recoverFrames:3});
 s.update(frame({kmh:3}));
 assert.equal(s.update(frame({vision:null})).state,'FAULT');
 assert.equal(s.update(frame({kmh:3})).state,'FAULT');
 assert.equal(s.update(frame({kmh:3})).state,'FAULT');
 const healed=s.update(frame({kmh:3}));
 assert.notEqual(healed.state,'FAULT');
});

test('resent or reordered frames cannot extend or reset anything',()=>{
 const s=skill({calibration});
 const first=frame({kmh:3});s.update(first);
 const replay=s.update({...first});
 assert.equal(replay.state,'FAULT');assert.equal(replay.reason,'invalid_or_repeated_timeline');
 const older=s.update(frame({kmh:3,start:first.capture_start_ms-10}));
 assert.equal(older.reason,'invalid_or_repeated_timeline');assert.equal(older.command.throttle,0);
});
