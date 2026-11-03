// Keyboard pulse-width modulation runs independently of perception. No braking
// between normal control samples. Short backend actions bound any lost request.
export class LiveActuator {
  constructor(client,{leaseMs=500,clock=()=>performance.now()}={}){this.client=client;this.leaseMs=leaseMs;this.clock=clock;this.command=null;this.expires=0;this.running=false;this.fault=null;this.task=null;this.tick=0;this.actions=[];}
  update(command){
    if(!command||![command.throttle,command.brake,command.steer].every(Number.isFinite))throw Error('Invalid control command');
    this.command={throttle:Math.max(0,Math.min(1,command.throttle)),brake:Math.max(0,Math.min(1,command.brake)),steer:Math.max(-1,Math.min(1,command.steer))};this.expires=this.clock()+this.leaseMs;
  }
  start(){if(this.running)throw Error('Actuator already running');this.running=true;this.task=this.loop();return this.task;}
  async loop(){
    try{
      if(this.client.hold){const status=await this.client.status();if(!status.hold_supported)throw Error('Bridge upgrade required for continuous control');this.generation=status.generation;}
      while(this.running){
        if(!this.command||this.clock()>this.expires)throw Error('Control heartbeat expired');
        const c=this.command,phase=(this.tick++%10)/10,keys=[];
        if(c.brake>.05){if(phase<c.brake)keys.push('space');}
        else if(phase<c.throttle)keys.push('w');
        if(c.brake<.2 && phase<Math.abs(c.steer))keys.push(c.steer<0?'a':'d');
        const started=this.clock();let result,lease;
        if(this.client.hold){
          lease=Math.max(20,Math.min(500,Math.floor(this.expires-started)));
          try{await this.client.hold({keys,duration_ms:lease,generation:this.generation});}
          catch(error){if(String(error).includes('HTTP 409'))throw Error('Input interrupted; explicit restart required');throw error;}
          result={interrupted:false};
          await new Promise(resolve=>setTimeout(resolve,50));
        }else result=await this.client.action({keys,duration_ms:50});
        this.actions.push({keys,mode:this.client.hold?'hold':'action',...(lease?{lease_ms:lease}:{requested_ms:50}),elapsed_ms:result.elapsed_ms,roundtrip_ms:Math.round(this.clock()-started),interrupted:result.interrupted});
        // /stop cancels an in-flight action during our own shutdown as well.
        if(result.interrupted&&this.running)throw Error('Input interrupted; explicit restart required');
      }
    }catch(error){this.fault=String(error.message??error);this.running=false;
      // Interruption may be a user's F8. Do not issue new inputs in that case.
      if(this.fault==='Control heartbeat expired'){
        try{const s=await this.client.status();if(s.foreground)await this.client.action({keys:['space'],duration_ms:1000});}catch{}
      }
    }finally{this.running=false;try{await this.client.stop();}catch{}}
  }
  async stop(){this.running=false;await this.client.stop();if(this.task)await this.task;}
}
