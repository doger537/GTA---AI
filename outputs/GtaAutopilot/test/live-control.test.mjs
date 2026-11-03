import {test} from 'node:test';
import assert from 'node:assert/strict';
import {LiveActuator} from '../live-actuator.mjs';
import {VisualFollower} from '../visual-follower.mjs';
import {detectZeroDash} from '../zero-dash.mjs';
import {frameAge} from '../../GtaControl/bridge-client.mjs';
test('Frame freshness includes delivery and inference but never double-counts request waiting',()=>{
  const f={frame_age_ms:120,delivery_ms:5,received_at_ms:1000,roundtrip_ms:400};
  assert.equal(frameAge(f,1200),325);assert.equal(frameAge({...f,received_at_ms:undefined},1200),Infinity);assert.equal(frameAge(f,900),Infinity);
});
test('Tiny zero dash is recognized; empty region, white background and vertical digit are not zero',()=>{
  const shape=(w,h)=>{const b=Buffer.alloc(32*23*3);for(let y=8;y<8+h;y++)for(let x=20;x<20+w;x++)b.fill(255,(y*32+x)*3,(y*32+x+1)*3);return b;};
  assert.equal(detectZeroDash(shape(4,2),32,23),true);assert.equal(detectZeroDash(shape(2,9),32,23),false);assert.equal(detectZeroDash(Buffer.alloc(32*23*3),32,23),false);assert.equal(detectZeroDash(Buffer.alloc(32*23*3,255),32,23),false);
});
const observation=()=>({profile:'rear',timeMs:1000,ageMs:150,speed:{valid:true,kmh:3},vision:{semantic:{},road_fraction:.6,rows:[{y:.48,left:.2,right:.8},{y:.54,left:.2,right:.8},{y:.60,left:.2,right:.8}],vehicles:[]}});
test('Missing speed, stale frames, wrong camera and uncertain road forbid acceleration',()=>{
  for(const change of [{speed:{valid:false}},{ageMs:900},{profile:'cockpit'},{vision:{semantic:{},rows:[],road_fraction:0}}])assert.equal(new VisualFollower().update({...observation(),...change}).throttle,0);
});
test('Free visible road can request low-speed movement; overspeed requests braking',()=>{
  const f=new VisualFollower();assert.ok(f.update(observation()).throttle>0);
  assert.ok(f.update({...observation(),timeMs:1100,speed:{valid:true,kmh:18}}).brake>0);
});
test('High-speed driving is outside the low-speed trial and cannot arm it',()=>{assert.equal(new VisualFollower().update({...observation(),speed:{valid:true,kmh:80}}).reason,'speed_outside_trial_range');});
test('Perspective permits a narrower distant corridor but rejects an excessively narrow one',()=>{
  const s=observation();s.vision.rows=[{y:.48,left:.375,right:.5},{y:.54,left:.297,right:.547},{y:.60,left:.188,right:.359}];
  assert.equal(new VisualFollower().update(s).state,'FOLLOW');
  s.vision.rows[0].right=.46;assert.equal(new VisualFollower().update(s).reason,'no_visible_corridor');
});
test('Approaching obstacle cancels acceleration',()=>{
  const f=new VisualFollower(),s=observation();s.vision.vehicles=[{x:.45,y:.4,w:.1,h:.08}];f.update(s);
  const b=observation();b.timeMs=1100;b.vision.vehicles=[{x:.43,y:.4,w:.14,h:.16}];assert.equal(f.update(b).reason,'possible_obstacle_or_low_ttc');
});
test('One missed object detection does not immediately permit acceleration',()=>{
  const f=new VisualFollower(),a=observation();a.vision.vehicles=[{x:.45,y:.4,w:.1,h:.15}];assert.equal(f.update(a).state,'STOP');
  assert.equal(f.update({...observation(),timeMs:1200}).state,'STOP');
  assert.equal(f.update({...observation(),timeMs:2200}).state,'FOLLOW');
});
test('Actuator heartbeat loss brakes once and stops sending throttle',async()=>{
  let now=0;const calls=[];
  const client={action:async p=>{calls.push(p);now+=p.duration_ms;return {interrupted:false};},status:async()=>({foreground:true}),stop:async()=>calls.push('stop')};
  const a=new LiveActuator(client,{clock:()=>now,leaseMs:100});a.update({throttle:1,brake:0,steer:0});await a.start();
  assert.equal(a.fault,'Control heartbeat expired');assert.deepEqual(calls.at(-2),{keys:['space'],duration_ms:1000});assert.equal(calls.at(-1),'stop');assert.equal(calls.filter(p=>p.keys?.includes('w')).length,3);
});
test('User input interruption latches fault and never sends later brake or throttle',async()=>{
  const calls=[];const a=new LiveActuator({action:async p=>{calls.push(p);return {interrupted:true};},stop:async()=>calls.push('stop')});
  a.update({throttle:1,brake:0,steer:0});await a.start();assert.equal(calls.length,2);assert.equal(calls.at(-1),'stop');assert.match(a.fault,/interrupted/);
});
test('Our own stop cancelling an in-flight action is a clean shutdown',async()=>{
  let finish;const a=new LiveActuator({action:()=>new Promise(resolve=>{finish=resolve;}),stop:async()=>finish({interrupted:true})});
  a.update({throttle:1,brake:0,steer:0});a.start();await a.stop();assert.equal(a.fault,null);
});
test('Continuous mode renews held keys using the current session generation',async()=>{
  let a;const calls=[];const client={status:async()=>({hold_supported:true,generation:12}),hold:async p=>{calls.push(p);a.running=false;},stop:async()=>{}};
  a=new LiveActuator(client);a.update({throttle:1,brake:0,steer:0});await a.start();
  assert.equal(calls.length,1);assert.deepEqual(calls[0].keys,['w']);assert.equal(calls[0].generation,12);assert.ok(calls[0].duration_ms<=500);assert.equal(a.fault,null);
});
test('A revoked hold session does not resume or send a later brake command',async()=>{
  let brakes=0;const a=new LiveActuator({status:async()=>({hold_supported:true,generation:12}),hold:async()=>{throw Error('GTA Control HTTP 409: Control session stopped');},action:async()=>{brakes++;},stop:async()=>{}});
  a.update({throttle:1,brake:0,steer:0});await a.start();assert.match(a.fault,/interrupted/);assert.equal(brakes,0);
});
