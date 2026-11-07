// Mock device only; no GTA commands and no driver installation.
import {GamepadWorker,AnalogActuator} from '../../../packages/actuation/analog-actuator.mjs';import {writeFile,mkdir} from 'node:fs/promises';
const worker=new GamepadWorker(),actuator=new AnalogActuator(worker),samples=[];
// Explicitly synthetic identities in this mock-only smoke test; not GTA frames.
let sequence=0;const syntheticSource=()=>({sequence:++sequence,generation:0,capture_start_ms:Math.floor(performance.now()),age_ms:0});
try{
  const ready=await worker.ready;actuator.update({steer:.5,throttle:.3,brake:0},syntheticSource());actuator.start();
  // Keep heartbeat for 600ms, then intentionally stop refreshing it.
  const start=performance.now();while(performance.now()-start<600){await new Promise(r=>setTimeout(r,40));actuator.update({steer:.5,throttle:.3,brake:0},syntheticSource());}
  await actuator.task;const after=await worker.call('status');samples.push({event:'expired',fault:actuator.fault,after});
  await worker.call('arm');await worker.call('command',{steer:-.5,throttle:0,brake:.4,duration_ms:250});await new Promise(r=>setTimeout(r,100));samples.push({event:'brake',status:await worker.call('status')});await worker.call('stop');samples.push({event:'stopped',status:await worker.call('status')});
  const report={ready,synthetic_source:true,scope:'Mock vgamepad API and synthetic source clock only; physical driver absent, no GTA input, not capture-clock validation',samples};await mkdir(new URL('../../../experiments/runs/analog/',import.meta.url),{recursive:true});await writeFile(new URL(`../../../experiments/runs/analog/smoke-${new Date().toISOString().replaceAll(':','-')}.json`,import.meta.url),JSON.stringify(report,null,2),{flag:'wx'});console.log(JSON.stringify(report,null,2));
}finally{await actuator.stop();await worker.close();}
