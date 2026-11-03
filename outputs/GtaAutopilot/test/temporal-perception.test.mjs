import {test} from 'node:test';import assert from 'node:assert/strict';import {TemporalPerception} from '../temporal-perception.mjs';
const path=(x=.5)=>({valid:true,near_offset:0,far_offset:0,points:[{x,y:.54},{x,y:.46},{x,y:.38}]});
const frame=(i,changes={})=>({sequence:i,capture_start_ms:i*100,capture_end_ms:i*100+20,age_ms:0,state:{gear:{valid:true,value:'2'},speed:{valid:true,kmh:30}},geometry:path(),...changes});
test('Current gear and road require consecutive observations; no driving is enabled',()=>{
  const f=new TemporalPerception(),a=f.update(frame(0)),b=f.update(frame(1)),c=f.update(frame(2));
  assert.equal(a.state.gear.valid,false);assert.equal(b.state.gear.valid,true);assert.equal(b.geometry.valid,false);assert.equal(c.geometry.valid,true);assert.equal(c.drive_allowed,false);
});
test('Unreadable current values immediately invalidate previously confirmed observations',()=>{
  const f=new TemporalPerception();for(let i=0;i<3;i++)f.update(frame(i));
  const out=f.update(frame(3,{state:{gear:{valid:false,value:null},speed:{valid:false}},geometry:{valid:false,reason:'occluded'}}));
  assert.equal(out.state.gear.valid,false);assert.equal(out.geometry.valid,false);assert.equal(out.geometry.reason,'occluded');
  assert.equal(f.update(frame(4)).state.gear.valid,false);assert.equal(f.update(frame(5)).geometry.valid,false);
});
test('A reverse observation never leaves an old forward gear active during confirmation',()=>{
  const f=new TemporalPerception();f.update(frame(0));f.update(frame(1));
  const reverse=i=>frame(i,{state:{gear:{valid:true,value:'R'},speed:{valid:true,kmh:2}}});
  const a=f.update(reverse(2));assert.equal(a.state.gear.valid,false);assert.equal(a.state.gear.observed,'R');assert.equal(f.update(reverse(3)).state.gear.value,'R');
});
test('Stale, repeated, backward and overly long captures clear confirmation',()=>{
  for(const change of [{age_ms:451},{sequence:1},{capture_start_ms:50},{capture_end_ms:900}]){
    const f=new TemporalPerception();f.update(frame(0));f.update(frame(1));const out=f.update(frame(2,change));assert.equal(out.geometry.valid,false);assert.equal(out.state.gear.valid,false);assert.equal(out.geometry.reason,'invalid_or_stale_timeline');assert.equal(f.update(frame(3)).state.gear.valid,false);
  }
});
test('A large capture gap restarts confirmation even for matching observations',()=>{
  const f=new TemporalPerception();for(let i=0;i<3;i++)f.update(frame(i));const out=f.update(frame(8));assert.equal(out.geometry.valid,false);assert.equal(out.state.gear.valid,false);assert.equal(out.diagnostics.reset_by_gap,true);
});
test('A jumping path restarts confirmation and output never averages outside the current path',()=>{
  const f=new TemporalPerception();for(let i=0;i<3;i++)f.update(frame(i));assert.equal(f.update(frame(3,{geometry:path(.7)})).geometry.valid,false);f.update(frame(4,{geometry:path(.7)}));const current=path(.7);const out=f.update(frame(5,{geometry:current}));assert.equal(out.geometry.valid,true);assert.deepEqual(out.geometry.points,current.points);
});
test('Differently sampled matching paths confirm; non-overlapping or malformed paths do not',()=>{
  const f=new TemporalPerception();f.update(frame(0));f.update(frame(1,{geometry:{...path(),points:[{x:.5,y:.53},{x:.5,y:.49},{x:.5,y:.37}]}}));assert.equal(f.update(frame(2)).geometry.valid,true);
  assert.equal(f.update(frame(3,{geometry:{...path(),points:[{x:.5,y:.35},{x:.5,y:.2}]}})).geometry.valid,false);
  assert.equal(f.update(frame(4,{geometry:{...path(),points:[{x:NaN,y:.54},{x:.5,y:.4}]}})).geometry.valid,false);
});
