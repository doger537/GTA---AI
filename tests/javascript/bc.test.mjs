import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as tf from '@tensorflow/tfjs';
import {temporalSplit,separateSessionSplit,packHistory,metrics,INPUT} from '../../training/bc-data.mjs';
test('Separate-session split permits matching basenames but rejects session reuse and mixed records',()=>{
  const a=Array.from({length:40},()=>({source_session:'a',frames:['000.jpg']})),b=Array.from({length:20},()=>({source_session:'b',frames:['000.jpg']}));
  assert.equal(separateSessionSplit(a,b,'a','b').train.length,40);
  assert.throws(()=>separateSessionSplit(a,b,'a','a'));
  assert.throws(()=>separateSessionSplit(a,[...b,{source_session:'a'}],'a','b'));
});
import {createModel,saveModel,loadModel} from '../../training/bc-model.mjs';
test('Temporal split excludes gap and prevents overlapping image histories',()=>{
  const rows=Array.from({length:100},(_,i)=>({time_ms:i*100,frames:Array.from({length:4},(_,j)=>`${i-j}.jpg`)}));
  const s=temporalSplit(rows);assert.ok(s.omitted>0);assert.ok(s.train.at(-1).time_ms<s.validation[0].time_ms-1000);
  rows[0].frames.push('shared.jpg');rows.at(-1).frames.push('shared.jpg');assert.throws(()=>temporalSplit(rows),/Shared image/);
});
test('Stacked channels preserve chronological RGB order and normalization',()=>{
  const out=packHistory([Buffer.from([0,127.5,255]),Buffer.from([255,0,0]),Buffer.from([0,255,0]),Buffer.from([0,0,255])],1,1);
  assert.equal(out.length,12);assert.equal(out[0],-1);assert.equal(out[2],1);assert.deepEqual([...out.slice(9)],[-1,-1,1]);
  assert.throws(()=>packHistory([],1,1));
});
test('Metrics expose rare-class failure and mark unsupported recall as unavailable',()=>{
  const r=metrics([[1,0],[0,0]],[[.9,.8],[.9,.1]],['w','s']);assert.equal(r.exact_match,0);assert.equal(r.per_key[0].fp,1);assert.equal(r.per_key[1].f1,null);assert.equal(r.per_key[1].fp,1);
  assert.throws(()=>metrics([[0]],[[NaN]],['w']),/Invalid/);
});
test('CNN trains a batch and serialization preserves all six output probabilities',async()=>{
  await tf.setBackend('cpu');const model=createModel();model.compile({optimizer:'adam',loss:'binaryCrossentropy'});
  const x=tf.zeros([1,INPUT.height,INPUT.width,INPUT.channels]),y=tf.tensor2d([[1,0,0,0,0,0]]);
  const loss=await model.trainOnBatch(x,y);assert.ok(Number.isFinite(loss));
  const root=await mkdtemp(path.join(os.tmpdir(),'gta-bc-test-'));await saveModel(model,root);const loaded=await loadModel(root);
  const a=model.predict(x),b=loaded.predict(x),aa=await a.data(),bb=await b.data();assert.equal(aa.length,6);assert.ok(aa.every((v,i)=>Math.abs(v-bb[i])<1e-6));
  [a,b,x,y].forEach(t=>t.dispose());model.dispose();loaded.dispose();
});
