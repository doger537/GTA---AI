import {spawn} from 'node:child_process';import {createInterface} from 'node:readline';import {fileURLToPath} from 'node:url';
import {DecisionLease} from './decision-lease.mjs';
import {assertDrivePermit,inspectDrivePermit,revokeDrivePermit} from '../control/drive-safety-gate.mjs';
const usedStartups=new WeakSet();
export class GamepadWorker{
  constructor({device='mock',targetPid=null,authorization=null,connectionFile=fileURLToPath(new URL('../../apps/gta-control/connection.json',import.meta.url)),python=fileURLToPath(new URL('../../training/training-env/Scripts/python.exe',import.meta.url))}={}){
    if(!['mock','vgamepad'].includes(device)||device==='vgamepad'&&(!Number.isInteger(targetPid)||targetPid<=0))throw Error('Device and explicit GTA pid required');
    const permit=device==='vgamepad'?assertDrivePermit(authorization,{scope:'startup',kind:'gamepad'}):null;this.authorization=authorization;this.purpose=permit?.mode;
    this.device=device;this.pending=null;this.fault=null;
    this.ready=new Promise((resolve,reject)=>{this.readyResolve=resolve;this.readyReject=reject;});
    this.child=spawn(python,[fileURLToPath(new URL('./gamepad_backend.py',import.meta.url)),'--device',device,...(targetPid?['--target-pid',String(targetPid)]:[]),...(device==='vgamepad'?['--connection',connectionFile,'--purpose',this.purpose]:[])],{windowsHide:true,stdio:['pipe','pipe','pipe']});
    this.stderr='';this.child.stderr.on('data',b=>{this.stderr=(this.stderr+b.toString()).slice(-2000);});
    this.child.on('error',e=>this.fail(e));this.child.on('exit',code=>this.fail(Error(`Gamepad worker exited (${code}): ${this.stderr.trim().split('\n').at(-1)??''}`)));
    this.child.stdin.on('error',e=>this.fail(e));
    this.lines=createInterface({input:this.child.stdout});this.lines.on('line',line=>{
      let r;try{r=JSON.parse(line);}catch{return this.fail(Error('Invalid gamepad response'));}
      if(r.event==='ready')this.readyResolve(r);
      else if(r.event==='fault')this.fail(Error(r.error??'Gamepad fault'));
      else if(this.pending){const {resolve,reject,timer}=this.pending;this.pending=null;clearTimeout(timer);if(r.ok)resolve(r);else{revokeDrivePermit(this.lastAuthorization??this.authorization);reject(Error(r.error));}}
    });
    if(permit)this.child.stdin.write(JSON.stringify({op:'prepare',authorization:permit})+'\n');
  }
  fail(e){revokeDrivePermit(this.lastAuthorization??this.authorization);this.fault=e;this.readyReject(e);if(this.pending){clearTimeout(this.pending.timer);this.pending.reject(e);this.pending=null;}}
  async call(op,command,source,authorization){await this.ready;if(this.fault)throw this.fault;if(this.pending)throw Error('Concurrent gamepad request');if(op==='command'&&this.device!=='mock'&&!source)throw Error('Source-timed gamepad command required');
    let permit;
    if(this.device!=='mock'){
      if(op==='arm'){this.authorization=authorization??this.authorization;permit=assertDrivePermit(this.authorization,{scope:'startup',kind:'gamepad',mode:this.purpose});if(usedStartups.has(this.authorization))throw Error('DriveSafetyGate startup permit already used');usedStartups.add(this.authorization);}
      if(op==='command'){permit=assertDrivePermit(authorization,{kind:'gamepad',mode:this.purpose,command,source});this.lastAuthorization=authorization;this.lastCommand={...command};this.lastSource={...source};}
      if(op==='pause_pulse')permit=assertDrivePermit(this.lastAuthorization,{kind:'gamepad',mode:'diagnostic',command:this.lastCommand,source:this.lastSource});
    }
    return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{revokeDrivePermit(this.lastAuthorization??this.authorization);this.pending=null;this.child.stdin.end();reject(Error('Gamepad response timeout'));},1000);this.pending={resolve,reject,timer};this.child.stdin.write(JSON.stringify({op,...(command?{command}:{}),...(source?{source}:{}),...(permit?{authorization:permit}:{})})+'\n');
  });}
  async close(){try{if(!this.fault)await this.call('stop');}finally{revokeDrivePermit(this.lastAuthorization??this.authorization);this.child.stdin.end();this.lines.close();}}
}
export class AnalogActuator{
  constructor(worker,{bridge=null,startupAuthorization=null,leaseMs=250,clock=()=>performance.now()}={}){
    if(!Number.isInteger(leaseMs)||leaseMs<20||leaseMs>250||worker.device!=='mock'&&!bridge)throw Error('Real gamepad requires bridge stop/focus monitoring');
    Object.assign(this,{worker,bridge,startupAuthorization,leaseMs,clock});this.lease=new DecisionLease({leaseMs,clock});this.running=false;this.command=null;this.task=null;this.fault=null;
  }
  update(c,source,authorization){if(!c||![c.steer,c.throttle,c.brake].every(Number.isFinite)||Math.abs(c.steer)>1||c.throttle<0||c.throttle>1||c.brake<0||c.brake>1||c.throttle>0&&c.brake>0)throw Error('Invalid analog command');if(this.worker.device!=='mock')assertDrivePermit(authorization,{kind:'gamepad',command:c,source});this.authorization=authorization;this.lease.update(source);this.source=this.lease.wireSource();if(this.worker.device!=='mock')this.source.decision_expires_ms=Math.min(this.source.decision_expires_ms,inspectDrivePermit(authorization).source.decision_expires_ms);this.command={steer:c.steer,throttle:c.throttle,brake:c.brake};}
  start(){if(this.running||this.fault)throw Error('Explicit new actuator/session required');this.running=true;this.task=this.loop();return this.task;}
  async loop(){try{
    if(this.bridge){const s=await this.bridge.status();if(!s.foreground||s.busy||s.generation!==this.lease.generation)throw Error('GTA focus/session required; disable other actuators');this.generation=s.generation;}
    await this.worker.call('arm',undefined,undefined,this.startupAuthorization);
    while(this.running){
      if(this.bridge){const s=await this.bridge.status();if(!s.foreground||s.busy||s.generation!==this.generation)throw Error('Bridge interrupted analog control');}
      const remaining=this.lease.remaining();if(!this.command||remaining<20)throw Error('Control heartbeat expired');
      await this.worker.call('command',{...this.command,duration_ms:Math.min(this.leaseMs,remaining)},this.source,this.authorization);await new Promise(r=>setTimeout(r,40));
    }
  }catch(e){revokeDrivePermit(this.authorization);this.fault=e.message;}finally{this.running=false;try{await this.worker.call('stop');}catch{}}}
  async stop(){this.running=false;revokeDrivePermit(this.authorization);await this.task;}
}
