import {test} from 'node:test';
import assert from 'node:assert/strict';
import {LiveActuator} from '../../packages/actuation/live-actuator.mjs';
import {VisualFollower} from '../../packages/control/visual-follower.mjs';
import {detectZeroDash} from '../../packages/perception/zero-dash.mjs';
import {frameAge} from '../../packages/protocols/bridge-client.mjs';
const commandSource=()=>({sequence:1,generation:12,capture_start_ms:1000,age_ms:100});
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
const ownedClient=c=>({...c,armInput:async()=>({owner_id:'keyboard-test',generation:12}),releaseInput:async()=>c.stop?.()});
test('Actuator heartbeat loss releases input without creating an unobserved brake pulse',async()=>{
  let now=0;const calls=[];
  const client={hold:async p=>{calls.push(p);now+=p.duration_ms;},status:async()=>({hold_supported:true,generation:12}),stop:async()=>calls.push('stop')};
  const a=new LiveActuator(ownedClient(client),{clock:()=>now,leaseMs:100});a.update({throttle:1,brake:0,steer:0},commandSource());await a.start();
  assert.equal(a.fault,'Control heartbeat expired');assert.equal(calls.at(-1),'stop');assert.equal(calls.filter(p=>p.keys?.includes('w')).length,1);assert.equal(calls.some(p=>p.keys?.includes('space')),false);
});
test('User input interruption latches fault and never sends later brake or throttle',async()=>{
  const calls=[];const a=new LiveActuator(ownedClient({status:async()=>({hold_supported:true,generation:12}),hold:async p=>{calls.push(p);throw Error('HTTP 409');},stop:async()=>calls.push('stop')}));
  a.update({throttle:1,brake:0,steer:0},commandSource());await a.start();assert.equal(calls.length,2);assert.equal(calls.at(-1),'stop');assert.match(a.fault,/interrupted/);
});
test('Our own stop cancelling an in-flight action is a clean shutdown',async()=>{
  let finish;const a=new LiveActuator(ownedClient({status:async()=>({hold_supported:true,generation:12}),hold:()=>new Promise(resolve=>{finish=resolve;}),stop:async()=>finish?.({interrupted:true})}));
  a.update({throttle:1,brake:0,steer:0},commandSource());a.start();await new Promise(r=>setImmediate(r));await a.stop();assert.equal(a.fault,null);
});
test('Continuous mode renews held keys using the current session generation',async()=>{
  let a;const calls=[];const client={status:async()=>({hold_supported:true,generation:12}),hold:async p=>{calls.push(p);a.running=false;},stop:async()=>{}};
  a=new LiveActuator(ownedClient(client));a.update({throttle:1,brake:0,steer:0},commandSource());await a.start();
  assert.equal(calls.length,1);assert.deepEqual(calls[0].keys,['w']);assert.equal(calls[0].generation,12);assert.equal(calls[0].owner_id,'keyboard-test');assert.ok(calls[0].duration_ms<=250);assert.equal(calls[0].observation_expires_ms,1450);assert.equal(a.fault,null);
});

test('A denied ownership grant never injects input or stops another owner',async()=>{
  let injected=0,stopped=0;
  const client={status:async()=>({hold_supported:true,generation:12}),armInput:async()=>{throw Error('Input already owned');},releaseInput:async()=>{stopped++;},hold:async()=>{injected++;},stop:async()=>{stopped++;}};
  const a=new LiveActuator(client);a.update({throttle:1,brake:0,steer:0},commandSource());await a.start();
  assert.match(a.fault,/already owned/);assert.equal(injected,0);assert.equal(stopped,0);
});

test('Stopping while arm is in flight releases its eventual grant without sending commands',async()=>{
  let finish,injected=0;const released=[];
  const client={status:async()=>({hold_supported:true,generation:12}),armInput:()=>new Promise(r=>{finish=r;}),releaseInput:async id=>released.push(id),hold:async()=>{injected++;}};
  const a=new LiveActuator(client);a.update({throttle:1,brake:0,steer:0},commandSource());a.start();await new Promise(r=>setImmediate(r));
  const stopped=a.stop();finish({owner_id:'late-grant',generation:12});await stopped;
  assert.equal(injected,0);assert.deepEqual(released,['late-grant']);
});

test('An old bridge cannot silently fall back to unowned keyboard actions',async()=>{
  let sent=0;const a=new LiveActuator({hold:async()=>{sent++;},action:async()=>{sent++;},stop:async()=>{sent++;}});
  a.update({throttle:1,brake:0,steer:0},commandSource());await a.start();assert.match(a.fault,/Ownership-aware/);assert.equal(sent,0);
});

test('hold acknowledgement retains the source actually sent when a newer command arrives during await',async()=>{
 let a;const c={status:async()=>({hold_supported:true,generation:12}),hold:async()=>{a.update({throttle:0,brake:0,steer:0},{...commandSource(),sequence:2,capture_start_ms:1100});a.running=false;},stop:async()=>{}};
 a=new LiveActuator(ownedClient(c));a.update({throttle:1,brake:0,steer:0},commandSource());await a.start();
 assert.equal(a.actions.length,1);assert.equal(a.actions[0].sequence,1);assert.equal(a.actions[0].capture_start_ms,1000);
});
test('A revoked hold session does not resume or send a later brake command',async()=>{
  let brakes=0;const a=new LiveActuator(ownedClient({status:async()=>({hold_supported:true,generation:12}),hold:async()=>{throw Error('GTA Control HTTP 409: Control session stopped');},action:async()=>{brakes++;},stop:async()=>{}}));
  a.update({throttle:1,brake:0,steer:0},commandSource());await a.start();assert.match(a.fault,/interrupted/);assert.equal(brakes,0);
});
