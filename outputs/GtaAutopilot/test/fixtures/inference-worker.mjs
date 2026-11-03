import {parentPort,workerData} from 'node:worker_threads';
const mode=workerData.model;
if(mode==='startup_error'){parentPort.postMessage({event:'startup_error',error:'synthetic startup failure'});parentPort.close();}
else{
  parentPort.postMessage({event:'ready',inputNames:['x'],outputNames:['y']});
  parentPort.on('message',m=>{
    if(m.op==='release'){parentPort.postMessage({id:m.id,ok:true});parentPort.close();return;}
    if(mode==='hang')return;
    if(mode==='crash')process.exit(17);
    if(mode==='error'){parentPort.postMessage({id:m.id,ok:false,error:'synthetic inference failure'});return;}
    const start=performance.timeOrigin+performance.now();
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,80);
    const values={y:{type:'float32',dims:[1],data:Float32Array.from([m.feeds.x.data.reduce((a,b)=>a+b,0)])},interval:{type:'float64',dims:[2],data:Float64Array.from([start,performance.timeOrigin+performance.now()])}};
    parentPort.postMessage({id:m.id,ok:true,values,run_ms:80});
  });
}
