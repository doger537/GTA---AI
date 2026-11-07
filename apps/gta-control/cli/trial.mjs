// Shadow only until calibrated geometry and exclusive input ownership are integrated.
import {mkdir,writeFile} from 'node:fs/promises';
import {connect,frameAge} from '../../../packages/protocols/bridge-client.mjs';
import {Perception} from '../../../packages/perception/perception.mjs';import {VehicleStateReader} from '../../../packages/perception/vehicle-state.mjs';import {hudProfile} from '../../../packages/perception/hud-profile.mjs';
import {roadGeometry,guidanceGate} from '../../../packages/navigation/road-guidance.mjs';import {navigationAtFrame} from '../../../packages/navigation/navigation-context.mjs';
if(process.argv.includes('--drive'))throw Error('Live trial disabled: calibrated drive gate and exclusive input ownership are not implemented. Use shadow mode.');
const seconds=Number(process.argv.find(x=>x.startsWith('--seconds='))?.split('=')[1]??8);
if(!Number.isFinite(seconds)||seconds<1||seconds>15)throw Error('Trial duration must be1..15 seconds');
let client,vision,reader,error=null;const records=[],root=new URL('../../../experiments/runs/',import.meta.url);
try{
 client=await connect();const initial=await client.status();if(!initial.foreground||initial.busy)throw Error('Focused idle GTA required for passive capture');
 const check=async()=>{const s=await client.status();if(!s.foreground||s.busy||s.generation!==initial.generation)throw Error('Focus/control generation changed');};
 const first=await client.observation(),geometry=JSON.stringify(first.hud.hud);reader=await VehicleStateReader.create(hudProfile(first.hud.hud));vision=await Perception.load({cameraProfile:process.argv.includes('--rear-view-confirmed')?'rear':'unknown'});
 let last=-1;const start=performance.now();
 while(performance.now()-start<seconds*1000){
  await check();const begin=performance.now(),o=await client.observation();if(o.generation!==initial.generation||JSON.stringify(o.hud.hud)!==geometry)throw Error('Observation configuration changed');
  if(o.sequence<=last)throw Error('Non-increasing observation');last=o.sequence;
  const [p,state]=await Promise.all([vision.analyze(o.road.bytes),reader.read(o.hud.bytes,o.capture_start_ms)]);
  const navigation=navigationAtFrame(await client.navigation(),o.capture_start_ms,o.capture_end_ms),path=roadGeometry(p.semantic,navigation.valid?navigation.intent:'unknown'),age_ms=frameAge(o.road);
  const gate=guidanceGate({navigation,state,geometry:path,age_ms});await check();
  records.push({sequence:o.sequence,generation:o.generation,capture_start_ms:o.capture_start_ms,capture_end_ms:o.capture_end_ms,state,geometry:path,navigation,gate,age_ms,cycle_ms:performance.now()-begin,actuation:false});
 }
}catch(e){error=e.message;process.exitCode=1;}finally{
 client?.close();if(reader)await reader.close();if(vision)await Promise.all([vision.session.release(),vision.semantic.session.release()]);
 await mkdir(root,{recursive:true});await writeFile(new URL('trial-latest.json',root),JSON.stringify({mode:'shadow_only',drive:false,actuation:false,error,records},null,2));
}
console.log(JSON.stringify({mode:'shadow_only',samples:records.length,error,actuation:false}));
