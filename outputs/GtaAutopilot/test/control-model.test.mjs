import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as tf from '@tensorflow/tfjs';
import {encodeControls,decodeControls,classBalance,createControlModel} from '../control-model.mjs';
import {saveModel,loadModel} from '../bc-model.mjs';
import {mkdtemp} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {MOTION_INPUT} from '../control-vision.mjs';
test('All supported keyboard combinations roundtrip through categorical classes',()=>{
  for(let s=0;s<3;s++)for(let p=0;p<3;p++)for(let h=0;h<2;h++){
    const groups=[s,p,h].map((n,i)=>Array.from({length:[3,3,2][i]},(_,j)=>Number(j===n)));
    assert.deepEqual(encodeControls(decodeControls(groups)),[s,p,h]);
  }
  assert.throws(()=>encodeControls([1,0,1,0,0,0]));assert.throws(()=>encodeControls([0,1,0,1,0,0]));
});
test('Even ambiguous softmax scores decode to a single steering and pedal state',()=>{
  const y=decodeControls([[.1,.45,.45],[.1,.45,.45],[.5,.5]]);assert.equal(y[1]+y[3],1);assert.equal(y[0]+y[2],1);assert.equal(y[5],0);
  assert.throws(()=>decodeControls([[NaN,0,1],[1,0,0],[1,0]]));
});
test('Balance weights do not reward classes absent from training',()=>{
  const b=classBalance([0,0,0,1],3);assert.equal(b.weights[2],0);assert.ok(b.weights[1]>b.weights[0]);assert.ok(Math.abs(b.counts.reduce((s,n,i)=>s+n*b.weights[i],0)/4-1)<1e-6);
});
test('Three-head model trains and preserves each head after checkpoint reload',async()=>{
  await tf.setBackend('cpu');
  for(const input of [{width:80,height:45,channels:12},MOTION_INPUT]){
  const m=createControlModel(42,input);m.compile({optimizer:'adam',loss:['categoricalCrossentropy','categoricalCrossentropy','categoricalCrossentropy']});
  const x=tf.zeros([1,input.height,input.width,input.channels]),ys=[tf.tensor2d([[1,0,0]]),tf.tensor2d([[0,1,0]]),tf.tensor2d([[1,0]])];
  const loss=await m.trainOnBatch(x,ys);assert.ok(loss.every(Number.isFinite));
  const dir=await mkdtemp(path.join(os.tmpdir(),'gta-control-test-'));await saveModel(m,dir);const loaded=await loadModel(dir),a=m.predict(x),b=loaded.predict(x);
  for(let i=0;i<3;i++){const aa=await a[i].data(),bb=await b[i].data();assert.ok(aa.every((v,j)=>Math.abs(v-bb[j])<1e-6));}
  [x,...ys,...a,...b].forEach(t=>t.dispose());m.dispose();loaded.dispose();
  }
});
