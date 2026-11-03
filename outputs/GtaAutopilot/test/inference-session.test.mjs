import {test} from 'node:test';import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';import * as ort from 'onnxruntime-node';
import {execFile} from 'node:child_process';import {promisify} from 'node:util';
import {WorkerInferenceSession,createInferenceSession} from '../inference-session.mjs';
const workerURL=new URL('./fixtures/inference-worker.mjs',import.meta.url),create=(mode='ok',provider='cpu')=>WorkerInferenceSession.create(mode,{executionProviders:[provider]},{workerURL});
const feed=()=>({x:{type:'float32',data:Float32Array.from([1,2,3,4]),dims:[4]}});

test('Blocking inference stays off the main loop and input ownership is preserved',async()=>{
  const session=await create(),input=feed();let heartbeat=false;
  try{const task=session.run(input);const timer=setTimeout(()=>{heartbeat=true;},10);const out=await task;clearTimeout(timer);
    assert.equal(heartbeat,true);assert.deepEqual([...out.y.data],[10]);assert.deepEqual([...input.x.data],[1,2,3,4]);assert.equal(input.x.data.byteLength,16);
  }finally{await session.release();}
});
test('Per-session overlapping frames are rejected instead of building a stale queue',async()=>{
  const session=await create();try{const first=session.run(feed());await assert.rejects(session.run(feed()),/Concurrent/);await first;}finally{await session.release();}
});
test('DirectML sessions admit GPU runs sequentially across workers',async()=>{
  const a=await create('ok','dml'),b=await create('ok','dml');
  try{const [x,y]=await Promise.all([a.run(feed()),b.run(feed())]);assert.ok(x.interval.data[1]<=y.interval.data[0]);}finally{await Promise.all([a.release(),b.release()]);}
});
test('Worker startup, inference and process errors reject without hanging',async()=>{
  await assert.rejects(create('startup_error'),/startup failure/);
  for(const mode of ['error','crash']){const session=await create(mode);try{await assert.rejects(session.run(feed()),mode==='error'?/inference failure/:/exited/);}finally{await session.release();}}
});
test('A missing response times out, invalidates the session and leaves no request pending',async()=>{
  const session=await create('hang');session.timeoutMs=40;
  try{await assert.rejects(session.run(feed()),/timeout/);await assert.rejects(session.run(feed()),/timeout/);assert.equal(session.pending,null);}finally{await session.release();}
});
test('Release cancels an outstanding request, is idempotent and refuses further runs',async()=>{
  const session=await create('hang'),run=session.run(feed()),rejected=assert.rejects(run,/released|closing/);
  await session.release();await rejected;await session.release();await assert.rejects(session.run(feed()),/closing/);
});
test('An idle worker does not keep an old single-shot entry point alive',async()=>{
  const moduleURL=new URL('../inference-session.mjs',import.meta.url).href;
  const code=`const {WorkerInferenceSession}=await import(${JSON.stringify(moduleURL)});await WorkerInferenceSession.create('ok',{executionProviders:['cpu']},{workerURL:new URL(${JSON.stringify(workerURL.href)})});console.log('done');`;
  const {stdout}=await promisify(execFile)(process.execPath,['--input-type=module','-e',code],{timeout:5000,windowsHide:true});assert.match(stdout,/done/);
});
test('The real ONNX CPU model gives identical typed outputs in inline and worker modes',async()=>{
  const model=fileURLToPath(new URL('../trained/geometry-guidance-v1/model.onnx',import.meta.url)),options={executionProviders:['cpu'],intraOpNumThreads:2};
  const inline=await createInferenceSession(model,options,{mode:'inline'}),worker=await createInferenceSession(model,options);
  try{const feeds={geometry_state:new ort.Tensor('float32',Float32Array.from([.1,-.2,.25,.03]),[1,4])},a=await inline.run(feeds),b=await worker.run(feeds);
    assert.deepEqual(Object.keys(a),Object.keys(b));for(const key of Object.keys(a)){assert.deepEqual(b[key].data,a[key].data);assert.deepEqual(b[key].dims,a[key].dims);assert.equal(b[key].type,a[key].type);}
  }finally{await Promise.all([inline.release(),worker.release()]);}
});
