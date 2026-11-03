import {test} from 'node:test';import assert from 'node:assert/strict';
import {connectRecordingBridge} from '../recording-bridge.mjs';
const ready=()=>({status:async()=>({busy:false,hold_supported:true,keys:['w']}),close(){}});
const refused=()=>Object.assign(Error('Connection refused'),{code:'ECONNREFUSED'});
test('A running bridge is reused without launching another process',async()=>{
  const client=ready();let launched=0;assert.equal(await connectRecordingBridge({connectClient:async()=>client,launch:async()=>launched++}),client);assert.equal(launched,0);
});
test('Stopped bridge is started once and connection config is reread until ready',async()=>{
  let calls=0,launched=0,closed=0;const client=ready();
  const result=await connectRecordingBridge({connectClient:async()=>{calls++;if(calls<3)return {status:async()=>{throw refused();},close(){closed++;}};return client;},launch:async()=>{launched++;},pause:async()=>{},notify:()=>{}});
  assert.equal(result,client);assert.equal(launched,1);assert.equal(closed,2);assert.equal(calls,3);
});
test('Authorization/version errors do not spawn duplicates or pretend recording started',async()=>{
  let launches=0;await assert.rejects(connectRecordingBridge({connectClient:async()=>({status:async()=>{throw Error('HTTP 401');},close(){}}),launch:async()=>launches++}),/401/);assert.equal(launches,0);
});
test('Failed startup terminates clearly and cancellation prevents a launch',async()=>{
  const options={connectClient:async()=>{throw refused();},launch:async()=>{},pause:async()=>{},notify:()=>{},attempts:2};
  await assert.rejects(connectRecordingBridge(options),/Запись не началась/);
  await assert.rejects(connectRecordingBridge({...options,isCancelled:()=>true}),/отменён/);
});
