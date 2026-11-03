// Mock device only; no GTA commands and no driver installation.
import {GamepadWorker,AnalogActuator} from './analog-actuator.mjs';import {writeFile,mkdir} from 'node:fs/promises';
const worker=new GamepadWorker(),actuator=new AnalogActuator(worker),samples=[];
try{
  const ready=await worker.ready;actuator.update({steer:.5,throttle:.3,brake:0});actuator.start();
  // Keep heartbeat for 600ms, then intentionally stop refreshing it.
  const start=performance.now();while(performance.now()-start<600){actuator.update({steer:.5,throttle:.3,brake:0});await new Promise(r=>setTimeout(r,40));}
  await actuator.task;const after=await worker.call('status');samples.push({event:'expired',fault:actuator.fault,after});
  await worker.call('arm');await worker.call('command',{steer:-.5,throttle:0,brake:.4,duration_ms:250});await new Promise(r=>setTimeout(r,100));samples.push({event:'brake',status:await worker.call('status')});await worker.call('stop');samples.push({event:'stopped',status:await worker.call('status')});
  const report={ready,scope:'Mock vgamepad API only; physical driver absent, no GTA input',samples};await mkdir(new URL('./runs/analog/',import.meta.url),{recursive:true});await writeFile(new URL('./runs/analog/smoke.json',import.meta.url),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}finally{await actuator.stop();await worker.close();}
