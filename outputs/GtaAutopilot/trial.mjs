import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {connect,frameAge} from '../GtaControl/bridge-client.mjs';
import {Perception} from './perception.mjs';
import {SpeedReader} from './speed-reader.mjs';
import {VisualFollower} from './visual-follower.mjs';
import {LiveActuator} from './live-actuator.mjs';
const drive=process.argv.includes('--drive'),seconds=Number(process.argv.find(x=>x.startsWith('--seconds='))?.split('=')[1]??8);
if(!Number.isFinite(seconds)||seconds<1||seconds>15)throw Error('Trial duration must be 1..15 seconds');
if(drive&&!process.argv.includes('--rear-view-confirmed'))throw Error('Drive requires manual confirmation of fixed rear camera and driver seat');
const config=JSON.parse(await readFile(new URL('./screen-config.json',import.meta.url),'utf8'));
const client=await connect(),vision=await Perception.load({cameraProfile:'rear'}),speedReader=await SpeedReader.create(config.speed_roi),follower=new VisualFollower(),actuator=new LiveActuator(client,{leaseMs:650});
const root=new URL('./runs/',import.meta.url);await mkdir(root,{recursive:true});
let start=performance.now(),last=-1,ready=0,everStarted=false,preview=null,trialError=null;const records=[];
try{
  while(performance.now()-start<seconds*1000){
    const begin=performance.now(),frame=await client.frame();if(frame.sequence===last)continue;last=frame.sequence;
    const [p,speed]=await Promise.all([vision.analyze(frame.bytes),speedReader.read(frame.bytes,performance.now())]);
    // Server frame age already includes time spent waiting for a capture.
    // Add only response delivery and processing since receipt, not the whole request twice.
    const ageMs=frameAge(frame);
    const decision=follower.update({vision:p,speed,ageMs,timeMs:performance.now(),profile:'rear'});
    ready=decision.state==='FOLLOW'&&speed.kmh<=1?ready+1:0;
    records.push({sequence:frame.sequence,speed,decision,age_ms:Math.round(ageMs),cycle_ms:Math.round(performance.now()-begin),road_fraction:p.road_fraction,rows:p.rows});
    if(drive){
      if(actuator.fault)throw Error(actuator.fault);
      if(!actuator.running&&ready>=3){actuator.update(decision);actuator.start();everStarted=true;}
      else if(actuator.running)actuator.update(decision);
      // Once started, any STOP ends this bounded trial instead of auto-restarting.
      if(actuator.running&&decision.state==='STOP')break;
    }
    preview={bytes:frame.bytes,p};
  }
}catch(error){trialError=String(error.message??error);}finally{
  if(drive&&everStarted){const interrupted=actuator.fault?.includes('interrupted');try{await actuator.stop();}catch{};if(!interrupted)try{const s=await client.status();if(s.foreground)await client.action({keys:['space'],duration_ms:1200});}catch{}}
  client.close();await speedReader.close();if(preview){await writeFile(new URL('trial-raw.jpg',root),preview.bytes);await writeFile(new URL('trial-latest.jpg',root),await vision.overlay(preview.bytes,preview.p));}await writeFile(new URL('trial-latest.json',root),JSON.stringify({drive,actuator_started:everStarted,trial_error:trialError,actuator_fault:actuator.fault,actions:actuator.actions,scope:'low-speed road-following trial; no GPS planner; no metric braking calibration',records},null,2));
}
console.log(JSON.stringify({drive,actuator_started:everStarted,samples:records.length,ready_samples:records.filter(x=>x.decision.state==='FOLLOW').length,reasons:[...new Set(records.map(x=>x.decision.reason).filter(Boolean))],actuator_fault:actuator.fault,trial_error:trialError}));
if(trialError)process.exitCode=1;
