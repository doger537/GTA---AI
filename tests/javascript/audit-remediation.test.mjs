import {test} from 'node:test';import {strict as assert} from 'node:assert';import {execFile} from 'node:child_process';import {promisify} from 'node:util';
import {DecisionLease} from '../../packages/actuation/decision-lease.mjs';import {Controller} from '../../packages/control/controller.mjs';
const source=(sequence=1)=>({sequence,generation:2,capture_start_ms:1000+sequence*100,age_ms:400});
test('decision expiry is limited by original freshness and same-frame heartbeat cannot renew it',()=>{
 let now=0;const l=new DecisionLease({clock:()=>now});l.update(source());assert.equal(l.remaining(),50);now=30;l.update({...source(),age_ms:0});assert.equal(l.remaining(),20);now=51;assert.ok(l.remaining()<0);l.update({...source(2),age_ms:100});assert.equal(l.remaining(),250);
 assert.throws(()=>l.update(source()),/order/);assert.throws(()=>l.update({...source(3),generation:3}),/session/);assert.throws(()=>l.update({...source(3),age_ms:451}),/fresh/);assert.throws(()=>new DecisionLease({leaseMs:650}),/Lease/);
});
test('NaN timestamp cannot poison the next metric-controller steering value',()=>{
 const c=new Controller(),s={time_ms:1000,frame_age_ms:100,camera_calibrated:true,speed_valid:true,speed_mps:2,road_confidence:1,braking_mps2:4,paths:[{clearance_m:40,offset_m:1,heading_error_rad:.1,curvature:0,confidence:1}],obstacles:[]};
 c.update(s);assert.equal(c.update({...s,time_ms:NaN}).state,'STOP');const next=c.update({...s,time_ms:1100});assert.equal(next.state,'FOLLOW');assert.ok([next.steer,next.brake,next.throttle].every(Number.isFinite));assert.equal(c.update({...s,time_ms:1100}).reason,'non_increasing_capture_time');
});
test('legacy --drive refuses before connecting, capturing or creating actuators',async()=>{
 await assert.rejects(promisify(execFile)(process.execPath,['apps/gta-control/cli/trial.mjs','--drive','--rear-view-confirmed'],{cwd:new URL('../../',import.meta.url),windowsHide:true}),e=>{assert.match(e.stderr,/Live trial disabled/);assert.doesNotMatch(e.stderr,/ENOENT|ECONNREFUSED/);return true;});
});

test('capture-clock wire deadline is fixed at decision creation across repeated frame updates',()=>{
 let now=0;const lease=new DecisionLease({clock:()=>now});
 assert.throws(()=>lease.wireSource(),/source required/);
 lease.update({sequence:1,generation:7,capture_start_ms:1000,age_ms:100});
 assert.deepEqual(lease.wireSource(),{sequence:1,generation:7,capture_start_ms:1000,decision_expires_ms:1350});
 now=100;lease.update({sequence:1,generation:7,capture_start_ms:1000,age_ms:200});
 assert.equal(lease.wireSource().decision_expires_ms,1350);
 const copy=lease.wireSource();copy.decision_expires_ms=999999;assert.equal(lease.wireSource().decision_expires_ms,1350);
 lease.update({sequence:2,generation:7,capture_start_ms:1100,age_ms:120});assert.equal(lease.wireSource().decision_expires_ms,1470);
});

test('wire deadline cannot outlive the original 450ms capture freshness limit',()=>{
 const lease=new DecisionLease({leaseMs:250,clock:()=>0});lease.update({sequence:1,generation:7,capture_start_ms:1000,age_ms:430});
 assert.equal(lease.remaining(),20);assert.equal(lease.wireSource().decision_expires_ms,1450);
});
