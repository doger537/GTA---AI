// Keyboard pulse-width modulation runs independently of perception. No braking
// between normal control samples. Short backend actions bound any lost request.
import {DecisionLease} from './decision-lease.mjs';
export class LiveActuator {
  constructor(client,{leaseMs=250,clock=()=>performance.now()}={}){this.client=client;this.lease=new DecisionLease({leaseMs,clock});this.clock=clock;this.command=null;this.running=false;this.fault=null;this.task=null;this.tick=0;this.actions=[];}
  update(command,source){
    if(!command||![command.throttle,command.brake,command.steer].every(Number.isFinite))throw Error('Invalid control command');
    this.lease.update(source);this.command={throttle:Math.max(0,Math.min(1,command.throttle)),brake:Math.max(0,Math.min(1,command.brake)),steer:Math.max(-1,Math.min(1,command.steer))};
  }
  start(){if(this.running||this.fault)throw Error('Explicit new actuator/session required');this.running=true;this.task=this.loop();return this.task;}
  async loop(){
    try{
      if(!this.client.hold||!this.client.armInput||!this.client.releaseInput)throw Error('Ownership-aware hold bridge required');
      const status=await this.client.status();if(!status.hold_supported||status.generation!==this.lease.generation)throw Error('Bridge session mismatch');this.generation=status.generation;
      const grant=await this.client.armInput('keyboard',this.generation);this.ownerId=grant.owner_id;
      if(!this.ownerId||grant.generation!==this.generation)throw Error('Input ownership grant mismatch');
      while(this.running){
        if(!this.command||this.lease.remaining()<20)throw Error('Control heartbeat expired');
        const c=this.command,phase=(this.tick++%10)/10,keys=[];
        if(c.brake>.05){if(phase<c.brake)keys.push('space');}
        else if(phase<c.throttle)keys.push('w');
        if(c.brake<.2 && phase<Math.abs(c.steer))keys.push(c.steer<0?'a':'d');
        const started=this.clock(),lease=Math.min(250,this.lease.remaining());if(lease<20)throw Error('Control heartbeat expired');
        try{await this.client.hold({keys,duration_ms:lease,generation:this.generation,owner_id:this.ownerId,observation_expires_ms:this.lease.captureDeadline});}
        catch(error){if(String(error).includes('HTTP 409'))throw Error('Input interrupted; explicit restart required');throw error;}
        await new Promise(resolve=>setTimeout(resolve,50));
        this.actions.push({keys,mode:'hold',lease_ms:lease,roundtrip_ms:Math.round(this.clock()-started),interrupted:false});
      }
    }catch(error){this.fault=String(error.message??error);this.running=false;
      // Interruption may be a user's F8. Do not issue new inputs in that case.
      // Unknown/stale state never authorizes a new braking pulse either.
    }finally{this.running=false;try{if(this.ownerId)await this.client.releaseInput(this.ownerId);}catch{}}
  }
  async stop(){this.running=false;try{if(this.ownerId)await this.client.releaseInput(this.ownerId);}catch{}if(this.task)await this.task;}
}
