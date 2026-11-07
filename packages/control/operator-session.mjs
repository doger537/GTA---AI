import {ObservationStream} from '../protocols/observation-stream.mjs';
import {ObservationAnalyzer,observationContext} from '../perception/observation-analysis.mjs';
import {DriveSafetyGate,inspectDrivePermit} from './drive-safety-gate.mjs';

// Operator modes use actual native HUD observations. They do not stand in for
// autonomous calibration evidence or manufacture a vehicle identity detector.
export class OperatorSession {
  constructor(client,{mode='diagnostic',vehicle_id,camera_profile,leaseMs=200,clock=()=>performance.now(),analyzer=null}={}){
    if(!vehicle_id||!['rear','hood'].includes(camera_profile))throw Error('Explicit --vehicle-profile=NAME and --camera=rear|hood required');
    this.client=client;this.clock=clock;this.profile={vehicle_id,camera_profile};this.stream=new ObservationStream(client,{ownerKind:'gamepad',clock});this.analyzer=analyzer??new ObservationAnalyzer({clock});this.gate=new DriveSafetyGate({mode,kind:'gamepad',leaseMs,clock});
  }
  async read(){const o=await this.stream.read(),state=await this.analyzer.readState(o);this.gate.observe(observationContext(o,state,this.stream.status,this.profile));this.latest={o,state};return this.latest;}
  async prepare(){const start=this.clock();let verdict;do{await this.read();verdict=this.gate.evaluate({startup:true});if(verdict.allowed)return this.gate.arm();}while(this.clock()-start<4000);throw Error('DriveSafetyGate preparation timed out: '+verdict.reason);}
  async command(worker,command){await this.read();const authorization=this.gate.authorize(command),source=inspectDrivePermit(authorization).source;return worker.call('command',command,source,authorization);}
  async close(){this.gate.revoke('operator_session_closed');await this.analyzer.close();}
}
