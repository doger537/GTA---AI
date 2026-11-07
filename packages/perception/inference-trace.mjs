// Optional profiler instrumentation only; no production scheduling changes.
export function traceInferenceSession(trace, session, name) {
  trace.wrap(session, 'run', `${name}.total`);
  const original=session.request;
  session.request=async function(op,...args) {
    const events=trace.events,start=performance.now(),origin=trace.start;
    let succeeded=false;
    try { const result=await original.call(this,op,...args);succeeded=true;return result; }
    finally {
      if(events&&op==='run')events.push({stage:`${name}.rpc`,start_ms:start-origin,end_ms:performance.now()-origin,ok:succeeded,...(succeeded?{native_ms:this.lastRun?.worker_ms,roundtrip_ms:this.lastRun?.roundtrip_ms}:{})});
    }
  };
  trace.restore.push(()=>{session.request=original;});
}
export function inferenceParts(events,name) {
  const total=events.find(e=>e.stage===`${name}.total`),rpc=events.find(e=>e.stage===`${name}.rpc`);
  if(!total||!rpc?.ok)return null;
  return {total_ms:total.end_ms-total.start_ms,admission_ms:rpc.start_ms-total.start_ms,rpc_ms:rpc.end_ms-rpc.start_ms,native_ms:rpc.native_ms,transport_and_dispatch_ms:rpc.end_ms-rpc.start_ms-rpc.native_ms};
}
