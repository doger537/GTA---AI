// Read-only capture benchmark. Does not import any actuator or send commands.
import {mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {connect,frameAge} from '../../packages/protocols/bridge-client.mjs';
const count=Number(process.argv.find(x=>x.startsWith('--frames='))?.split('=')[1]??24);
if(!Number.isInteger(count)||count<1||count>200)throw Error('frames must be 1..200');
const root=new URL(`../runs/latency-capture/${new Date().toISOString().replaceAll(':','-')}/`,import.meta.url);
await mkdir(root,{recursive:true});
const client=await connect(),rows=[];let error=null;
try{
  const initial=await client.status();if(!initial.foreground||initial.busy)throw Error('GTA must be focused and idle');
  for(let i=0;i<count;i++){
    const status=await client.status();if(!status.foreground||status.busy||status.generation!==initial.generation)throw Error('Focus or control state changed');
    const start=performance.now(),observation=await client.observation(),frame=observation.road,hud=observation.hud;
    if(observation.generation!==initial.generation)throw Error('Capture generation changed');
    const acquisition_ms=performance.now()-start;
    const file=String(i).padStart(4,'0');
    const info=f=>({sequence:f.sequence,capture_start_ms:f.capture_start_ms,capture_end_ms:f.capture_end_ms,capture_ms:f.capture_end_ms-f.capture_start_ms,roundtrip_ms:f.roundtrip_ms,frame_age_ms:frameAge(f),bytes:f.bytes.length});
    rows.push({file,acquisition_ms,frame:info(frame),hud:{...info(hud),geometry:hud.hud},capture_skew_ms:Math.abs(frame.capture_start_ms-hud.capture_start_ms)});
    await Promise.all([writeFile(new URL(file+'.jpg',root),frame.bytes),writeFile(new URL(file+'.png',root),hud.bytes)]);
    await new Promise(r=>setTimeout(r,80));
  }
}catch(e){error=e.message;process.exitCode=1;}finally{client.close();}
await writeFile(new URL('capture.json',root),JSON.stringify({scope:'Read-only live captures; JPEG and native HUD derive from one source capture.',source:'single_capture',game_input_sent:false,error,rows},null,2));
console.log(JSON.stringify({root:fileURLToPath(root),frames:rows.length,error}));
