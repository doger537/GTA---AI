import {spawn} from 'node:child_process';import {createInterface} from 'node:readline';import {fileURLToPath} from 'node:url';
export class GamepadWorker{
  constructor({device='mock',targetPid=null,python=fileURLToPath(new URL('./training-env/Scripts/python.exe',import.meta.url))}={}){
    if(!['mock','vgamepad'].includes(device)||device==='vgamepad'&&(!Number.isInteger(targetPid)||targetPid<=0))throw Error('Device and explicit GTA pid required');
    this.device=device;this.pending=null;this.fault=null;
    this.ready=new Promise((resolve,reject)=>{this.readyResolve=resolve;this.readyReject=reject;});
    this.child=spawn(python,[fileURLToPath(new URL('./gamepad_backend.py',import.meta.url)),'--device',device,...(targetPid?['--target-pid',String(targetPid)]:[])],{windowsHide:true,stdio:['pipe','pipe','pipe']});
    this.stderr='';this.child.stderr.on('data',b=>{this.stderr=(this.stderr+b.toString()).slice(-2000);});
    this.child.on('error',e=>this.fail(e));this.child.on('exit',code=>this.fail(Error(`Gamepad worker exited (${code}): ${this.stderr.trim().split('\n').at(-1)??''}`)));
    this.lines=createInterface({input:this.child.stdout});this.lines.on('line',line=>{
      let r;try{r=JSON.parse(line);}catch{return this.fail(Error('Invalid gamepad response'));}
      if(r.event==='ready')this.readyResolve(r);
      else if(r.event==='fault')this.fail(Error(r.error??'Gamepad fault'));
      else if(this.pending){const {resolve,reject,timer}=this.pending;this.pending=null;clearTimeout(timer);r.ok?resolve(r):reject(Error(r.error));}
    });
  }
  fail(e){this.fault=e;this.readyReject(e);if(this.pending){clearTimeout(this.pending.timer);this.pending.reject(e);this.pending=null;}}
  async call(op,command){await this.ready;if(this.fault)throw this.fault;if(this.pending)throw Error('Concurrent gamepad request');return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{this.pending=null;this.child.stdin.end();reject(Error('Gamepad response timeout'));},1000);this.pending={resolve,reject,timer};this.child.stdin.write(JSON.stringify({op,...(command?{command}:{})})+'\n');
  });}
  async close(){try{if(!this.fault)await this.call('stop');}finally{this.child.stdin.end();this.lines.close();}}
}
export class AnalogActuator{
  constructor(worker,{bridge=null,leaseMs=250,clock=()=>performance.now()}={}){
    if(!Number.isInteger(leaseMs)||leaseMs<20||leaseMs>250||worker.device!=='mock'&&!bridge)throw Error('Real gamepad requires bridge stop/focus monitoring');
    Object.assign(this,{worker,bridge,leaseMs,clock});this.running=false;this.command=null;this.expires=0;this.task=null;this.fault=null;
  }
  update(c){if(!c||![c.steer,c.throttle,c.brake].every(Number.isFinite)||Math.abs(c.steer)>1||c.throttle<0||c.throttle>1||c.brake<0||c.brake>1||c.throttle>0&&c.brake>0)throw Error('Invalid analog command');this.command={steer:c.steer,throttle:c.throttle,brake:c.brake};this.expires=this.clock()+this.leaseMs;}
  start(){if(this.running)throw Error('Already running');this.running=true;this.task=this.loop();return this.task;}
  async loop(){try{
    if(this.bridge){const s=await this.bridge.status();if(!s.foreground||s.busy)throw Error('GTA focus required; disable other actuators');this.generation=s.generation;}
    await this.worker.call('arm');
    while(this.running){
      if(this.bridge){const s=await this.bridge.status();if(!s.foreground||s.busy||s.generation!==this.generation)throw Error('Bridge interrupted analog control');}
      const remaining=Math.floor(this.expires-this.clock());if(!this.command||remaining<20)throw Error('Control heartbeat expired');
      await this.worker.call('command',{...this.command,duration_ms:Math.min(this.leaseMs,remaining)});await new Promise(r=>setTimeout(r,40));
    }
  }catch(e){this.fault=e.message;}finally{this.running=false;try{await this.worker.call('stop');}catch{}}}
  async stop(){this.running=false;await this.task;}
}
