// Own the synchronous native ONNX call outside the control/event-loop thread.
import {parentPort,workerData} from 'node:worker_threads';
import * as ort from 'onnxruntime-node';
let session;
try{
  session=await ort.InferenceSession.create(workerData.model,workerData.options);
  parentPort.postMessage({event:'ready',inputNames:session.inputNames,outputNames:session.outputNames});
}catch(e){parentPort.postMessage({event:'startup_error',error:e.message});parentPort.close();}
if(session)parentPort.on('message',async message=>{
  try{
    if(message.op==='release'){await session.release();parentPort.postMessage({id:message.id,ok:true});parentPort.close();return;}
    if(message.op!=='run')throw Error('Unknown inference worker operation');
    const feeds=Object.fromEntries(Object.entries(message.feeds).map(([name,t])=>[name,new ort.Tensor(t.type,t.data,t.dims)]));
    const start=performance.now(),out=await session.run(feeds),run_ms=performance.now()-start;
    const values=Object.fromEntries(Object.entries(out).map(([name,t])=>[name,{type:t.type,dims:t.dims,data:t.data}]));
    // Opt-in: relinquish CPU output buffers after this response. Inputs remain
    // cloned and owned by the caller; no scheduling or GPU-I/O changes here.
    const transfers=workerData.transferOutputs?[...new Set(Object.values(values).map(t=>t.data.buffer))]:[];
    parentPort.postMessage({id:message.id,ok:true,values,run_ms},transfers);
  }catch(e){parentPort.postMessage({id:message.id,ok:false,error:e.message});}
});
