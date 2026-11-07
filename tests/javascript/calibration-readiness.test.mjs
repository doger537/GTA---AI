import {test} from 'node:test';import {strict as assert} from 'node:assert';import {calibrationReadiness} from '../../packages/control/calibration-readiness.mjs';
const frame=(i,gear='1',kmh=0)=>({sequence:i+1,start_ms:1000+i*200,end_ms:1020+i*200,age_ms:120,state:{time_ms:1000+i*200,speed:{valid:true,kmh,time_ms:1000+i*200},gear:{valid:true,value:gear}}});
const frames=()=>[0,1,2].map(i=>frame(i));const gate=rows=>calibrationReadiness(rows,{latestAgeMs:150});
test('calibration requires three fresh unique stationary frames with coherent state',()=>{
 assert.equal(gate(frames()).ready,true);assert.equal(gate([frame(0)]).reason,'need_three_observations');
 assert.equal(gate([frame(0),frame(0),frame(0)]).reason,'non_increasing_observations');
 assert.equal(gate([frame(0),frame(2),frame(1)]).ready,false);
 const duplicateTime=frames();duplicateTime[1].start_ms=duplicateTime[0].start_ms;assert.equal(gate(duplicateTime).reason,'non_increasing_observations');
});
test('a fresh latest frame cannot rescue stale history or an observation gap',()=>{
 const rows=frames();rows[0].age_ms=700;assert.equal(gate(rows).reason,'historical_observation_stale');
 assert.equal(gate([frame(0),frame(1),frame(5)]).reason,'observation_gap');
 for(const latestAgeMs of [451,NaN,Infinity,-1])assert.equal(calibrationReadiness(frames(),{latestAgeMs}).reason,'latest_observation_stale');
 const slow=frames();slow[1].end_ms=slow[1].start_ms+451;assert.equal(gate(slow).ready,false);
});
test('OCR from another capture, unreadable speed and negative/malformed timeline forbid startup',()=>{
 for(const mutate of [r=>r.state.time_ms--,r=>r.state.speed.time_ms--,r=>r.state.speed.valid=false,r=>r.state.speed.kmh=NaN,r=>r.state.speed.kmh=-1,r=>r.age_ms=NaN,r=>r.sequence=NaN,r=>r.end_ms=r.start_ms-1]){const rows=frames();mutate(rows[1]);assert.equal(gate(rows).ready,false);}
});
test('moving, neutral, unreadable and changing gears do not count as stable startup',()=>{
 assert.equal(gate([frame(0),frame(1,'1',2),frame(2)]).reason,'vehicle_not_stationary');
 for(const gear of ['N','0','9','unknown'])assert.equal(gate([frame(0,gear),frame(1,gear),frame(2,gear)]).reason,'gear_not_supported');
 assert.equal(gate([frame(0,'R'),frame(1,'1'),frame(2,'1')]).reason,'gear_not_stable');
 const unknown=frames();unknown[1].state.gear.valid=false;assert.equal(gate(unknown).reason,'vehicle_state_unknown');
});
test('three stable R readings and explicit stationary operator labels retain their meaning',()=>{
 assert.equal(gate([0,1,2].map(i=>frame(i,'R'))).ready,true);
 const rows=frames();for(const r of rows)r.state.gear.source='operator_visual_stationary_only';assert.equal(gate(rows).ready,true);
 // A bad middle reading must age out through new captures, never be filtered away.
 const bad=frame(2);bad.state.speed.valid=false;assert.equal(gate([frame(0),frame(1),bad,frame(3)]).ready,false);
 assert.equal(gate([bad,frame(3),frame(4),frame(5)]).ready,true);
});
