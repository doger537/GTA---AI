import {Worker} from 'node:worker_threads';
import * as ort from 'onnxruntime-node';
// DirectML jobs share the GPU with GTA. Serial admission avoids competing model
// submissions while leaving the main thread available to OCR and stop timers.
let dmlTail=Promise.resolve();
async function serialDml(run){const previous=dmlTail;let release;dmlTail=new Promise(resolve=>{release=resolve;});await previous;try{return await run();}finally{release();}}
export class WorkerInferenceSession {
  static async create(model,options,{workerURL=new URL('./inference-worker.mjs',import.meta.url),timeoutMs=30000}={}){
    const session=new WorkerInferenceSession(model,options,workerURL,timeoutMs);
    try{await session.ready;return session;}catch(e){await session.worker.terminate();throw e;}
  }
  constructor(model,options,workerURL,timeoutMs){
    this.worker=new Worker(workerURL,{workerData:{model,options},execArgv:[]});
    this.timeoutMs=timeoutMs;this.pending=null;this.sequence=0;this.closed=false;this.closing=false;this.fault=null;
    this.serialize=options.executionProviders?.some(p=>(typeof p==='string'?p:p.name)==='dml');this.running=false;
    this.ready=new Promise((resolve,reject)=>{this.readyResolve=resolve;this.readyReject=reject;});
    this.startupTimer=setTimeout(()=>this.fail(Error('Inference worker startup timeout')),timeoutMs);
    this.worker.on('message',m=>{
      if(m.event==='ready'){clearTimeout(this.startupTimer);this.inputNames=m.inputNames;this.outputNames=m.outputNames;this.worker.unref();this.readyResolve();return;}
      if(m.event==='startup_error'){this.fail(Error(m.error));return;}
      if(!this.pending||this.pending.id!==m.id){this.fail(Error('Unexpected inference response'));return;}
      const pending=this.pending;this.pending=null;clearTimeout(pending.timer);this.worker.unref();
      if(m.ok){this.lastRun={worker_ms:m.run_ms,roundtrip_ms:performance.now()-pending.start};pending.resolve(m.values);}else pending.reject(Error(m.error));
    });
    this.worker.on('error',e=>this.fail(e));
    this.worker.on('exit',code=>{if(!this.closed)this.fail(Error(`Inference worker exited (${code})`));});
  }
  fail(error){
    if(this.fault||this.closed)return;this.fault=error;clearTimeout(this.startupTimer);this.readyReject(error);
    if(this.pending){clearTimeout(this.pending.timer);this.pending.reject(error);this.pending=null;}
    void this.worker.terminate();
  }
  request(op,feeds){
    if(this.fault)throw this.fault;if(this.closed)throw Error('Inference session closed');if(this.pending)throw Error('Concurrent inference request; no frame queue allowed');
    return new Promise((resolve,reject)=>{
      const id=++this.sequence,start=performance.now(),timer=setTimeout(()=>this.fail(Error('Inference response timeout')),this.timeoutMs);
      this.pending={id,resolve,reject,timer,start};
      this.worker.ref();
      try{this.worker.postMessage({id,op,...(feeds?{feeds}:{})});}catch(e){clearTimeout(timer);this.pending=null;this.worker.unref();reject(e);}
    });
  }
  async run(feeds){
    if(this.closing)throw Error('Inference session closing');if(this.running)throw Error('Concurrent inference request; no frame queue allowed');this.running=true;
    try{await this.ready;
      const values=Object.fromEntries(Object.entries(feeds).map(([name,t])=>{
        if(!ArrayBuffer.isView(t.data)||!Array.isArray(t.dims))throw Error('Worker inference requires CPU numeric tensors');
        return [name,{type:t.type,dims:t.dims,data:t.data}];
      }));
      const run=()=>{if(this.closing)throw Error('Inference session closing');return this.request('run',values);};
      return await (this.serialize?serialDml(run):run());
    }finally{this.running=false;}
  }
  async release(){
    if(this.releasePromise)return this.releasePromise;
    this.closing=true;
    this.releasePromise=(async()=>{
      try{await this.ready.catch(()=>{});if(!this.fault&&!this.pending&&!this.running)await this.request('release');}
      finally{this.closed=true;clearTimeout(this.startupTimer);if(this.pending){clearTimeout(this.pending.timer);this.pending.reject(Error('Inference session released'));this.pending=null;}await this.worker.terminate();}
    })();return this.releasePromise;
  }
}
export function createInferenceSession(model,options,{mode='worker'}={}){
  if(mode==='worker')return WorkerInferenceSession.create(model,options);
  if(mode==='inline')return ort.InferenceSession.create(model,options);
  throw Error('Inference mode must be worker or inline');
}
