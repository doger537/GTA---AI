// Bounded diagnostic, not a trained-model driving mode. Requires user-prepared stationary car.
import {GamepadWorker} from './analog-actuator.mjs';import {connect} from '../GtaControl/bridge-client.mjs';import {mkdir,writeFile} from 'node:fs/promises';
const pid=Number(process.argv.find(a=>a.startsWith('--pid='))?.split('=')[1]);if(!Number.isInteger(pid)||pid<=0)throw Error('Use explicit --pid=GTA_PROCESS_ID');
const drive=process.argv.includes('--pedals'),client=await connect(),initial=await client.status();
const calibration=process.argv.includes('--calibration');
const movement=process.argv.includes('--movement');
const turn=process.argv.find(a=>a.startsWith('--turn='))?.split('=')[1]??'straight';if(!['straight','left','right'].includes(turn))throw Error('Turn straight, left or right');
if(!initial.target_found||!initial.foreground||initial.busy)throw Error('Focused GTA required; other actuators must be disabled');
const worker=new GamepadWorker({device:'vgamepad',targetPid:pid}),root=new URL(`./runs/analog/live-${new Date().toISOString().replaceAll(':','-')}/`,import.meta.url),events=[];await mkdir(root,{recursive:true});
async function checkBridge(){const s=await client.status();if(!s.foreground||s.busy||s.generation!==initial.generation)throw Error('User stop/focus change; test aborted');}
async function capture(name){const f=await client.frame();await writeFile(new URL(name+'.jpg',root),f.bytes);events.push({event:'frame',name,sequence:f.sequence});}
async function phase(name,command,duration){
  await checkBridge();await worker.call('arm');const start=performance.now();
  try{while(performance.now()-start<duration){await checkBridge();const s=await worker.call('command',{...command,duration_ms:200});events.push({event:name,ms:performance.now()-start,status:s});await new Promise(r=>setTimeout(r,40));}}
  finally{events.push({event:name+'-stop',status:await worker.call('stop')});}
  await capture(name);
}
let error=null;
try{
  const ready=await worker.ready;events.push({event:'ready',ready});await capture('before');
  if(drive){await phase('weak-gas',{steer:turn==='left'?-.35:turn==='right'?.35:0,throttle:movement?.45:calibration?.35:.15,brake:0},movement?1200:calibration?600:300);await phase('short-brake',{steer:0,throttle:0,brake:calibration||movement?.45:.3},calibration||movement?250:160);}
  else{await phase('right-stick',{steer:calibration?.4:.2,throttle:0,brake:0},400);await phase('left-stick',{steer:calibration?-.4:-.2,throttle:0,brake:0},400);}
  events.push({event:'final-neutral',status:await worker.call('status')});
}catch(e){error=e.message;process.exitCode=1;}
finally{try{await worker.close();}finally{client.close();}await writeFile(new URL('report.json',root),JSON.stringify({pid,pedals_test:drive,error,scope:'Real virtual gamepad and bounded manual test; no trained driving model',events},null,2));console.log(JSON.stringify({report:root.pathname,error,events:events.length}));}
