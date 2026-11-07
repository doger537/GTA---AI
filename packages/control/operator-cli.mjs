import {mkdir,writeFile} from 'node:fs/promises';
import {connect} from '../protocols/bridge-client.mjs';
import {GamepadWorker} from '../actuation/analog-actuator.mjs';
import {OperatorSession} from './operator-session.mjs';

export function operatorOptions(args){
  const value=name=>args.find(a=>a.startsWith('--'+name+'='))?.slice(name.length+3);
  if(args.some(a=>['--pedals','--movement','--calibration'].includes(a)))throw Error('Legacy pedal diagnostics retired; use guarded calibrate-analog');
  const pid=Number(value('pid')??args.find(a=>/^\d+$/.test(a))),vehicle_id=value('vehicle-profile'),camera_profile=value('camera');
  if(!Number.isSafeInteger(pid)||pid<=0||!vehicle_id||!['rear','hood'].includes(camera_profile))throw Error('Explicit --pid=PID --vehicle-profile=NAME --camera=rear|hood required');
  return {pid,vehicle_id,camera_profile};
}

export async function runOperatorDiagnostic(kind,args){
  const options=operatorOptions(args),client=await connect(),session=new OperatorSession(client,{...options,mode:'diagnostic',leaseMs:kind==='watchdog'?180:200});
  const root=new URL('../../experiments/runs/analog/diagnostic-'+kind+'-'+new Date().toISOString().replaceAll(':','-')+'/',import.meta.url);
  const events=[];let worker,error=null;
  const capture=async name=>{const {o}=await session.read();await Promise.all([writeFile(new URL(name+'.jpg',root),o.road.bytes),writeFile(new URL(name+'-hud.png',root),o.hud.bytes),writeFile(new URL(name+'-map.png',root),o.minimap.bytes)]);events.push({event:'capture',name,sequence:o.sequence,generation:o.generation,capture_start_ms:o.capture_start_ms});};
  try{
    await mkdir(root,{recursive:true});const startup=await session.prepare();worker=new GamepadWorker({device:'vgamepad',targetPid:options.pid,authorization:startup});await worker.ready;
    if(kind==='steering'){
      for(const steer of [.2,-.2]){
        await worker.call('arm',undefined,undefined,await session.prepare());const start=performance.now();
        while(performance.now()-start<400){events.push({event:'steer',steer,status:await session.command(worker,{steer,throttle:0,brake:0,duration_ms:200})});await new Promise(r=>setTimeout(r,40));}
        await worker.call('stop');await capture(steer>0?'right':'left');
      }
    }else if(kind==='watchdog'){
      await worker.call('arm',undefined,undefined,await session.prepare());await session.command(worker,{steer:.3,throttle:0,brake:0,duration_ms:180});
      await new Promise(r=>setTimeout(r,60));const applied=await worker.call('status');if(!applied.active||!Number.isFinite(applied.xinput?.values?.left_x)||applied.xinput.values.left_x<=0)throw Error('No physical steering observed before expiry');events.push({event:'applied',status:applied});
      await new Promise(r=>setTimeout(r,240));const expired=await worker.call('status');
      if(expired.active||Object.values(expired.xinput.values).some(v=>v!==0))throw Error('Physical neutral not confirmed');events.push({event:'expired',status:expired});
    }else if(kind==='pause'){
      await capture('before');await worker.call('arm',undefined,undefined,await session.prepare());await session.command(worker,{steer:0,throttle:0,brake:0,duration_ms:200});await worker.call('pause_pulse');await worker.call('stop');await new Promise(r=>setTimeout(r,500));await capture('after');
    }else throw Error('Unknown guarded diagnostic');
  }catch(e){error=e.message;process.exitCode=1;}
  finally{try{await worker?.close();}finally{await session.close();client.close();}await mkdir(root,{recursive:true});await writeFile(new URL('report.json',root),JSON.stringify({mode:'diagnostic',vehicle_profile_source:'operator_declared',options,error,events,scope:'Explicit bounded zero-pedal diagnostic, actual native HUD startup checks; not autonomous driving.'},null,2),{flag:'wx'});}
  console.log(JSON.stringify({report:root.pathname,error,events:events.length}));
}
