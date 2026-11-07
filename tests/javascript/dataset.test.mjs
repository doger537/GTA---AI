import {test} from 'node:test';
import assert from 'node:assert/strict';
import {prepareExamples,validateTimeline} from '../../training/dataset.mjs';
const frames=()=>Array.from({length:6},(_,i)=>({file:`${i}.jpg`,capture_start_ms:100+i*100,capture_end_ms:150+i*100,keys_before:[],keys_after:[],label_stable:true}));
const options={trimStartMs:0,history:1,input:{started_ms:0,initial_keys:[]},endMs:1000};
test('A press and release inside capture is rejected even when both snapshots are empty',()=>{
  const events=[{sequence:1,time_ms:120,key:'a',down:true},{sequence:2,time_ms:140,key:'a',down:false}];
  const r=prepareExamples(frames(),{...options,events});assert.equal(r.rejected.event_near_capture,1);assert.equal(r.examples.length,5);
});
test('Event state must agree with image snapshots',()=>{
  const r=prepareExamples(frames(),{...options,input:{started_ms:0,initial_keys:['w']}});assert.equal(r.examples.length,0);assert.equal(r.rejected.event_snapshot_mismatch,6);
});
test('Initial held key, key release, and combined controls reconstruct correctly',()=>{
  const f=frames();f[0].keys_before=f[0].keys_after=['w','a'];
  const events=[{sequence:1,time_ms:50,key:'a',down:true},{sequence:2,time_ms:180,key:'a',down:false},{sequence:3,time_ms:180,key:'w',down:false}];
  const r=prepareExamples(f,{...options,input:{started_ms:0,initial_keys:['w']},events});assert.deepEqual(r.examples[0].targets,[1,1,0,0,0,0]);assert.deepEqual(r.examples[1].keys,[]);
});
test('Event gaps and time reversal fail validation',()=>{
  assert.throws(()=>validateTimeline([{sequence:2,time_ms:10,key:'w',down:true}],0));
  assert.throws(()=>validateTimeline([{sequence:1,time_ms:-1,key:'w',down:true}],0));
});
test('Temporal history cannot cross long missing-frame gaps',()=>{
  const f=frames();for(let i=3;i<f.length;i++){f[i].capture_start_ms+=1000;f[i].capture_end_ms+=1000;}
  const r=prepareExamples(f,{trimStartMs:0});assert.equal(r.examples.length,0);assert.equal(r.rejected.history_gap,3);
});
test('Incomplete event coverage and ambiguous legacy labels are excluded',()=>{
  assert.ok(prepareExamples(frames(),{...options,endMs:350}).rejected.outside_event_coverage);
  const f=frames();f[4].label_stable=false;const r=prepareExamples(f,{trimStartMs:0});assert.equal(r.examples.length,2);assert.equal(r.rejected.ambiguous_snapshot,1);assert.equal(r.examples[0].label_source,'legacy_snapshots_provisional');
});
