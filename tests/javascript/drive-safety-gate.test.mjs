import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';import {createHash} from 'node:crypto';
import {DriveSafetyGate,assertDrivePermit,inspectDrivePermit} from '../../packages/control/drive-safety-gate.mjs';
import {loadCalibrationEvidence} from '../../packages/control/calibration-evidence.mjs';
import {GtaClient} from '../../packages/protocols/bridge-client.mjs';
import {LiveActuator} from '../../packages/actuation/live-actuator.mjs';
import {GamepadWorker} from '../../packages/actuation/analog-actuator.mjs';
import {CautiousDriver} from '../../packages/actuation/cautious-driver.mjs';
import {observation,context,profile,source} from './fixtures/synthetic-observation.mjs';

const command={steer:0,throttle:.2,brake:0,duration_ms:200};
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
function prime(gate){for(let i=1;i<=3;i++)gate.observe(context(observation(i)));return gate.arm();}
async function syntheticBundle(t){
  const root=await mkdtemp(path.join(os.tmpdir(),'gta-drive-unit-'));
  t.after(async()=>{const relative=path.relative(os.tmpdir(),root);assert.ok(!relative.startsWith('..')&&!path.isAbsolute(relative)&&path.basename(root).startsWith('gta-drive-unit-'));await rm(root,{recursive:true,force:true});});
  const payload=Buffer.from('Explicitly synthetic unit-test source, no real calibration evidence.');await writeFile(path.join(root,'synthetic-source.txt'),payload);
  const reports={};
  for(const kind of ['camera','speed','braking','steering','vehicle']){
    const report={kind,scope:'synthetic-unit-test-only',validation_passed:true,...profile(),development_sessions:['synthetic-dev'],validation_sessions:['synthetic-held-out'],source_files:[{file:'synthetic-source.txt',sha256:hash(payload)}],heading_verified:true,metric_scale_verified:true,identity_verified:true,samples:20,false_stops:0,reverse_confusions:0,min_kmh:0,max_kmh:12,p95_error_kmh:1,repetitions:5,deceleration_mps2:4,measured_distance_verified:true,brake_command:.45,max_throttle_tested:.35,max_abs_steer:.3,repetitions_per_direction:5,response_verified:true};
    const bytes=Buffer.from(JSON.stringify(report));await writeFile(path.join(root,kind+'.json'),bytes);reports[kind]={file:kind+'.json',sha256:hash(bytes)};
  }
  const model=Buffer.from('synthetic-unit-model-manifest');await writeFile(path.join(root,'models.json'),model);
  const manifest={schema_version:1,status:'verified',scope:'synthetic-unit-test-only',profile:profile(),model_manifest_sha256:hash(model),reports,max_speed_kmh:12};
  const file=path.join(root,'manifest.json');await writeFile(file,JSON.stringify(manifest));
  return {root,file,manifest,options:{modelManifest:path.join(root,'models.json')}};
}

test('default autonomous gate denies flags, missing evidence and pixel-only geometry',()=>{
  const gate=new DriveSafetyGate({clock:()=>0});for(let i=1;i<=3;i++)gate.observe(context(observation(i)));
  assert.equal(gate.preflight().allowed,false);assert.throws(()=>gate.arm(),/verified_calibration_bundle/);
  const pretend=new DriveSafetyGate({clock:()=>0,calibration:{verified:true,...profile()}});for(let i=1;i<=3;i++)pretend.observe(context(observation(i)));assert.throws(()=>pretend.arm(),/verified_calibration/);
});

test('verified calibration loader and gate positive path use explicitly synthetic fixtures only',async t=>{
  const fixture=await syntheticBundle(t),calibration=await loadCalibrationEvidence(fixture.file,fixture.options),gate=new DriveSafetyGate({clock:()=>0,calibration});
  prime(gate);const permit=gate.authorize(command),descriptor=inspectDrivePermit(permit);
  assert.equal(assertDrivePermit(permit,{kind:'gamepad',command,source:descriptor.source}).mode,'autonomous');
  assert.equal(descriptor.source.sequence,3);assert.ok(descriptor.source.decision_expires_ms<=observation(3).capture_start_ms+450);
  assert.equal(new DriveSafetyGate({kind:'keyboard',calibration,clock:()=>0}).preflight().allowed,false);
  assert.throws(()=>assertDrivePermit({...permit},{command,source:descriptor.source}),/permit missing/);
  assert.throws(()=>assertDrivePermit(permit,{command:{...command,throttle:.3},source:descriptor.source}),/command\/source mismatch/);
  assert.throws(()=>assertDrivePermit(permit,{command,source:{...descriptor.source,sequence:4}}),/command\/source mismatch/);
  assert.throws(()=>assertDrivePermit(permit,{kind:'keyboard',command,source:descriptor.source}),/permit missing/);
});

test('calibration provenance rejects tampering and overlapping validation sessions',async t=>{
  const fixture=await syntheticBundle(t);await writeFile(path.join(fixture.root,'synthetic-source.txt'),'tampered');
  await assert.rejects(loadCalibrationEvidence(fixture.file,fixture.options),/hash mismatch/);
  const other=await syntheticBundle(t),file=path.join(other.root,'speed.json'),report=JSON.parse(await readFile(file,'utf8'));report.validation_sessions=report.development_sessions;
  const bytes=Buffer.from(JSON.stringify(report));await writeFile(file,bytes);other.manifest.reports.speed.sha256=hash(bytes);await writeFile(other.file,JSON.stringify(other.manifest));
  await assert.rejects(loadCalibrationEvidence(other.file,other.options),/Independent matching speed/);
});

test('current profile, heading, navigation, metrics and obstacle checks are mandatory',async t=>{
  const fixture=await syntheticBundle(t),calibration=await loadCalibrationEvidence(fixture.file,fixture.options);
  const changes=[c=>{c.vehicle_id='other';},c=>{c.heading.verified=false;},c=>{c.heading.source.sequence--;},c=>{c.identity.verified='true';},c=>{c.navigation.intent='stop';},c=>{c.navigation.expires_ms=1;},c=>{c.metric.source.sequence--;},c=>{c.metric.paths=[];},c=>{c.metric.obstacles=[{distance_m:1,lateral_m:0,closing_mps:4}];},c=>{c.state.speed.kmh=13;},c=>{c.metric.obstacles=[null];}];
  for(const mutate of changes){const gate=new DriveSafetyGate({clock:()=>0,calibration});for(let i=1;i<=3;i++){const c=context(observation(i));mutate(c);gate.observe(c);}assert.equal(gate.evaluate().allowed,false);assert.throws(()=>gate.arm(),/DriveSafetyGate/);}
});

test('bounded diagnostics need three fresh stationary states and forbid pedals',()=>{
  const gate=new DriveSafetyGate({mode:'diagnostic',clock:()=>0});gate.observe(context(observation(1)));assert.throws(()=>gate.arm(),/three_observations/);
  gate.observe(context(observation(2)));gate.observe(context(observation(3)));gate.observe(context(observation(4)));const startup=gate.arm();assert.equal(inspectDrivePermit(startup).scope,'startup');
  assert.throws(()=>gate.authorize(command),/diagnostic_pedals/);assert.equal(gate.armed,false);
  const reverse=new DriveSafetyGate({mode:'calibration',clock:()=>0});for(let i=1;i<=3;i++){const c=context(observation(i));c.state.gear.value='R';reverse.observe(c);}assert.throws(()=>reverse.arm(),/forward_vehicle_state/);
});

test('new unreadable observation revokes an earlier permit and cannot silently re-arm',()=>{
  const gate=new DriveSafetyGate({mode:'calibration',clock:()=>0});prime(gate);const permit=gate.authorize(command),source=inspectDrivePermit(permit).source;
  const bad=context(observation(4));bad.state.speed.valid=false;gate.observe(bad);assert.throws(()=>assertDrivePermit(permit,{command,source}),/revoked/);
  for(let i=5;i<=7;i++)gate.observe(context(observation(i)));assert.throws(()=>gate.authorize(command),/explicit arm/);gate.arm();assert.ok(gate.authorize(command));
});

test('clock expiry, NaN clock and geometry changes invalidate permits',()=>{
  let now=0;const gate=new DriveSafetyGate({mode:'calibration',clock:()=>now});prime(gate);const permit=gate.authorize(command),source=inspectDrivePermit(permit).source;
  now=251;assert.throws(()=>assertDrivePermit(permit,{command,source}),/expired/);now=NaN;assert.throws(()=>assertDrivePermit(permit,{command,source}),/expired/);
  const other=new DriveSafetyGate({mode:'calibration',clock:()=>0});prime(other);const p=other.authorize(command);const changed=context(observation(4));changed.observation.minimap.region.width=499;other.observe(changed);assert.throws(()=>assertDrivePermit(p,{command,source:inspectDrivePermit(p).source}),/revoked/);
});

test('real actuator and gamepad construction cannot accept a boolean or forged permit',()=>{
  const client=new GtaClient({url:'http://127.0.0.1:1',token:'unit-test-only'});let requests=0;client.request=()=>{requests++;throw Error('Must not connect');};
  try{const actuator=new LiveActuator(client);assert.throws(()=>actuator.update(command,{...source(observation(1)),age_ms:100},{allowed:true}),/DriveSafetyGate/);assert.equal(requests,0);}finally{client.close();}
  assert.throws(()=>new GamepadWorker({device:'vgamepad',targetPid:123,python:'must-not-spawn',authorization:{allowed:true}}),/DriveSafetyGate/);
});

test('retired cautious driver never creates a blind brake or any input request',async()=>{
  let inputs=0;const driver=new CautiousDriver({action:async()=>inputs++,step:async()=>inputs++,stop:async()=>{}});
  await assert.rejects(driver.arm(),/retired/);await assert.rejects(driver.tick(),/retired/);assert.equal(inputs,0);await driver.stop();
});

test('gate phase and mode cannot be changed by setting flags and mint is private',()=>{
 const gate=new DriveSafetyGate({mode:'calibration',clock:()=>0});
 assert.throws(()=>{gate.armed=true;},TypeError);assert.throws(()=>{gate.mode='autonomous';},TypeError);assert.equal(gate.mint,undefined);
 assert.throws(()=>gate.authorize(command),/explicit arm/);
});

test('caller mutation cannot refresh the stored packet or change checked vehicle state',()=>{
 let now=0;const gate=new DriveSafetyGate({mode:'calibration',clock:()=>now});let last;
 for(let i=1;i<=3;i++){last=context(observation(i));gate.observe(last);}gate.arm();
 last.state.speed.valid=false;for(const key of ['road','hud','minimap'])last.observation[key].received_at_ms=1000;
 assert.ok(gate.authorize(command));now=500;assert.equal(gate.evaluate().allowed,false);
});

test('diagnostic permit cannot run beyond its bounded session even with fresh frames',()=>{
 let now=0;const gate=new DriveSafetyGate({mode:'diagnostic',clock:()=>now});prime(gate);
 now=950;gate.observe(context(observation(4,{received:now})));const c={steer:.2,throttle:0,brake:0,duration_ms:200},p=gate.authorize(c),tag=inspectDrivePermit(p).source;
 now=1001;assert.throws(()=>assertDrivePermit(p,{command:c,source:tag}),/expired/);
});

test('a physical worker startup permit is consumed once before writing arm',async()=>{
 const gate=new DriveSafetyGate({mode:'calibration',clock:()=>0}),startup=prime(gate);const worker=Object.create(GamepadWorker.prototype);
 Object.assign(worker,{ready:Promise.resolve(),device:'vgamepad',purpose:'calibration',authorization:startup,pending:null,fault:null});let writes=0;
 worker.child={stdin:{write:()=>{writes++;const p=worker.pending;worker.pending=null;clearTimeout(p.timer);p.resolve({ok:true});}}};
 await worker.call('arm');await assert.rejects(worker.call('arm'),/already used/);assert.equal(writes,1);gate.revoke('test_done');
});

test('autonomous commands respect measured input limits and do not accelerate at the calibrated speed cap',async t=>{
 const fixture=await syntheticBundle(t),calibration=await loadCalibrationEvidence(fixture.file,fixture.options);
 for(const c of [{steer:.4,throttle:0,brake:0},{steer:0,throttle:.4,brake:0},{steer:0,throttle:0,brake:.1}]){
  const gate=new DriveSafetyGate({clock:()=>0,calibration});prime(gate);assert.throws(()=>gate.authorize(c),/autonomous_command_limit/);
 }
 const gate=new DriveSafetyGate({clock:()=>0,calibration});prime(gate);const c=context(observation(4));c.state.speed.kmh=12;gate.observe(c);
 assert.ok(gate.authorize({steer:0,throttle:0,brake:0}));assert.throws(()=>gate.authorize(command),/autonomous_command_limit/);
});
