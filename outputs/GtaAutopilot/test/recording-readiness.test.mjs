import{test}from'node:test';import assert from'node:assert/strict';import{waitRecordingFocus,recordingReadiness}from'../recording-readiness.mjs';
const status=(foreground=true,generation=2)=>({foreground,generation,target_found:true,busy:false});
test('Startup tolerates transient focus loss but requires a stable interval',async()=>{
  let time=0,calls=0;const values=[status(),status(false),status(),status(),status(),status()];
  await waitRecordingFocus({status:async()=>{calls++;return values.shift()??status();}},2,{clock:()=>time,sleep:async ms=>{time+=ms;},stableMs:200});assert.equal(calls,5);
});
test('A real stop, busy input or cancellation never restarts the recording',async()=>{
  assert.throws(()=>recordingReadiness(status(true,3),2),/generation/);assert.throws(()=>recordingReadiness({...status(),busy:true},2),/active/);
  await assert.rejects(waitRecordingFocus({status:async()=>status(false,3)},2),/generation/);
  await assert.rejects(waitRecordingFocus({status:async()=>status()},2,{cancelled:()=>true}),/Cancelled/);
});
test('No stable focus produces a bounded timeout',async()=>{
  let time=0;await assert.rejects(waitRecordingFocus({status:async()=>status(false)},2,{clock:()=>time,sleep:async ms=>{time+=ms;},timeoutMs:200}),/timed out/);
});
