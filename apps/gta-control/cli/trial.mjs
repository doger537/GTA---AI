// The live path is conditional on the same gate used by actual actuators.
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {connect,frameAge} from '../../../packages/protocols/bridge-client.mjs';
import {Perception} from '../../../packages/perception/perception.mjs';
import {ObservationStream} from '../../../packages/protocols/observation-stream.mjs';
import {ObservationAnalyzer,observationContext} from '../../../packages/perception/observation-analysis.mjs';
import {DriveSafetyGate} from '../../../packages/control/drive-safety-gate.mjs';
import {loadCalibrationEvidence} from '../../../packages/control/calibration-evidence.mjs';
import {Controller} from '../../../packages/control/controller.mjs';
import {LiveActuator} from '../../../packages/actuation/live-actuator.mjs';
import {roadGeometry,guidanceGate} from '../../../packages/navigation/road-guidance.mjs';
const drive=process.argv.includes('--drive'),arg=name=>process.argv.find(x=>x.startsWith('--'+name+'='))?.slice(name.length+3);
const settings=JSON.parse(await readFile(new URL('../../../configs/drive-safety.json',import.meta.url),'utf8')),calibrationFile=arg('calibration')??settings.calibration_bundle;
if(drive&&!calibrationFile)throw Error('Live trial disabled: verified calibration bundle required by DriveSafetyGate');
const calibration=drive?await loadCalibrationEvidence(calibrationFile):null,safety=new DriveSafetyGate({kind:'keyboard',calibration}),controller=new Controller();
if(drive&&!safety.preflight().allowed)throw Error('Live trial disabled: '+safety.preflight().reason);
const seconds=Number(process.argv.find(x=>x.startsWith('--seconds='))?.split('=')[1]??8);
if(!Number.isFinite(seconds)||seconds<1||seconds>15)throw Error('Trial duration must be1..15 seconds');
let client,vision,actuator,error=null;const analyzer=new ObservationAnalyzer(),records=[],root=new URL('../../../experiments/runs/',import.meta.url);let applied=0;
try{
 client=await connect();const stream=new ObservationStream(client,{ownerKind:drive?'keyboard':null});vision=await Perception.load({cameraProfile:process.argv.includes('--rear-view-confirmed')?'rear':'unknown'});
 const start=performance.now();
 while(performance.now()-start<seconds*1000){
  const begin=performance.now(),o=await stream.read(),{vision:p,state}=await analyzer.analyze(o,vision);
  // No pixel corridor is promoted to metres or verified vehicle heading here.
  const context=observationContext(o,state,stream.status,{vehicle_id:arg('vehicle-profile')??settings.vehicle_id,camera_profile:arg('camera')??settings.camera_profile}),navigation=context.navigation,path=roadGeometry(p.semantic,navigation.valid?navigation.intent:'unknown'),age_ms=frameAge(o.road);
  const gate=guidanceGate({navigation,state,geometry:path,age_ms}),verdict=safety.observe(context);
  records.push({sequence:o.sequence,generation:o.generation,capture_start_ms:o.capture_start_ms,capture_end_ms:o.capture_end_ms,state,geometry:path,navigation,gate,safety:verdict,age_ms,cycle_ms:performance.now()-begin,actuation:false});
  if(drive){
    if(!verdict.allowed){if(verdict.reason==='need_three_observations')continue;throw Error('DriveSafetyGate: '+verdict.reason);}
    if(!safety.armed)safety.arm();
    const command=controller.update({...context.metric,time_ms:o.capture_start_ms,frame_age_ms:age_ms,camera_calibrated:true,speed_valid:true,speed_mps:state.speed.kmh/3.6,max_speed_mps:calibration.maxSpeedKmh/3.6,braking_mps2:calibration.brakingMps2}),authorization=safety.authorize(command);
    actuator??=new LiveActuator(client);actuator.update(command,{...o,age_ms},authorization);if(!actuator.running){actuator.start();actuator.task.catch(()=>{});}applied++;records.at(-1).command_proposed=true;
    if(actuator.fault)throw Error(actuator.fault);
  }
 }
}catch(e){error=e.message;process.exitCode=1;}finally{
 if(actuator)await actuator.stop();client?.close();await analyzer.close();if(vision)await Promise.all([vision.session.release(),vision.semantic.session.release()]);
 const acknowledgements=actuator?.actions??[];for(const row of records){row.acknowledged_requests=acknowledgements.filter(a=>a.sequence===row.sequence&&a.generation===row.generation).length;row.actuation=row.acknowledged_requests>0;}
 await mkdir(root,{recursive:true});await writeFile(new URL('trial-latest.json',root),JSON.stringify({mode:drive?'guarded_trial':'shadow_only',drive,command_proposals:applied,acknowledged_requests:acknowledgements.length,actuation:acknowledgements.length>0,driving_verified:false,error,records},null,2));
}
console.log(JSON.stringify({mode:drive?'guarded_trial':'shadow_only',samples:records.length,error,command_proposals:applied,acknowledged_requests:actuator?.actions.length??0,driving_verified:false}));
