// Real inference, read-only profiling. Never imports an actuator or sends commands.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';import {pathToFileURL} from 'node:url';import {createHash} from 'node:crypto';
import {connect,frameAge} from '../GtaControl/bridge-client.mjs';
import {LatencyTrace,stageSummary,percentiles} from './latency-trace.mjs';
import {monitorEventLoopDelay} from 'node:perf_hooks';
const arg=(name,fallback)=>process.argv.find(s=>s.startsWith('--'+name+'='))?.slice(name.length+3)??fallback;
const live=process.argv.includes('--live'),captureRoot=path.resolve(process.argv[2]??''),count=Number(arg('frames',16));
if(!Number.isInteger(count)||count<1||count>100)throw Error('frames must be 1..100');
const source=pathToFileURL(path.resolve(arg('source','.'))+path.sep);
const {Perception}=await import(new URL('perception.mjs',source)),{VehicleStateReader}=await import(new URL('vehicle-state.mjs',source)),{hudProfile}=await import(new URL('hud-profile.mjs',source)),{roadGeometry,guidanceGate}=await import(new URL('road-guidance.mjs',source));
const manifest=JSON.parse(await readFile(path.join(captureRoot,'capture.json'),'utf8'));
if(manifest.rows.length<count||manifest.rows.some(r=>!/^\d{4}$/.test(r.file)))throw Error('Insufficient or invalid capture manifest');
const output=path.resolve(arg('output',`runs/latency-2026-11-03/profile-${Date.now()}.json`));await mkdir(path.dirname(output),{recursive:true});
const trace=new LatencyTrace(),rows=[],startup=performance.now();let reader,vision,client,error=null;
const loopDelay=monitorEventLoopDelay({resolution:10});
const hash=values=>createHash('sha256').update(Buffer.from(values.buffer,values.byteOffset,values.byteLength)).digest('hex');
try{
  reader=await VehicleStateReader.create(hudProfile(manifest.rows[0].hud.geometry));
  vision=await Perception.load({cameraProfile:'rear'});
  trace.wrap(reader,'read','vehicle.total');trace.wrap(reader.speed,'read','speed.total');trace.wrap(reader.speed.worker,'recognize','speed.ocr');trace.wrap(reader.worker,'recognize','gear.ocr');
  trace.wrap(vision,'analyze','vision.total');trace.wrap(vision.session,'run','yolop.inference');trace.wrap(vision.semantic,'analyze','semantic.total');trace.wrap(vision.semantic.session,'run','semantic.inference');
  const startup_ms=performance.now()-startup;
  const loadSaved=async i=>{const item=manifest.rows[i];return {item,bytes:await readFile(path.join(captureRoot,item.file+'.jpg')),hudBytes:await readFile(path.join(captureRoot,item.file+'.png')),time_ms:item.hud.capture_start_ms};};
  // Warm up both OCR workers and both actual ONNX models; excluded from steady-state summary.
  const warm=await loadSaved(0);for(let i=0;i<2;i++){reader.speed.previous=null;await Promise.all([reader.read(warm.hudBytes,warm.time_ms),vision.analyze(warm.bytes)]);}
  let initial;
  if(live){client=await connect();initial=await client.status();if(!initial.foreground||initial.busy)throw Error('GTA must be focused and idle for live profile');}
  loopDelay.enable();
  for(let i=0;i<count;i++){
    let bytes,hudBytes,time_ms,frame,hud,item;
    if(live){const status=await client.status();if(!status.foreground||status.busy||status.generation!==initial.generation)throw Error('Focus or control state changed');}
    trace.begin();let t=performance.now();
    if(live){const observation=await client.observation();if(observation.generation!==initial.generation)throw Error('Capture generation changed');frame=observation.road;hud=observation.hud;bytes=frame.bytes;hudBytes=hud.bytes;time_ms=hud.capture_start_ms;
      if(JSON.stringify(hud.hud)!==JSON.stringify(manifest.rows[0].hud.geometry))throw Error('HUD geometry changed');
    }else{({bytes,hudBytes,time_ms,item}=await loadSaved(i));}
    const acquisition_ms=performance.now()-t;
    reader.speed.previous=null;
    const [state,p]=await Promise.all([reader.read(hudBytes,time_ms),vision.analyze(bytes)]);
    t=performance.now();const geometry=roadGeometry(p.semantic,'lane_follow');
    const age_ms=live?Math.max(frameAge(frame),frameAge(hud)):0;
    const decision=guidanceGate({navigation:{valid:true,intent:'lane_follow'},state,geometry,age_ms});
    const decision_ms=performance.now()-t,total_ms=performance.now()-trace.start,events=trace.end();
    rows.push({index:i,acquisition_ms,total_ms,decision_ms,age_ms,capture:live?{frame_ms:frame.capture_end_ms-frame.capture_start_ms,hud_ms:hud.capture_end_ms-hud.capture_start_ms,frame_roundtrip_ms:frame.roundtrip_ms,hud_roundtrip_ms:hud.roundtrip_ms,skew_ms:Math.abs(frame.capture_start_ms-hud.capture_start_ms),frame_age_at_decision_ms:frameAge(frame),hud_age_at_decision_ms:frameAge(hud)}:null,state,geometry,decision,output_digest:{road:hash(p.semantic.road),probability:hash(p.semantic.probability),labels:hash(p.semantic.labels),mask:hash(p.mask),lane:hash(p.lane),vehicles:p.vehicles,rows:p.rows,road_fraction:p.road_fraction},events});
  }
  loopDelay.disable();
  const summary={startup_ms,total_ms:percentiles(rows.map(r=>r.total_ms)),acquisition_ms:percentiles(rows.map(r=>r.acquisition_ms)),decision_ms:percentiles(rows.map(r=>r.decision_ms)),age_at_decision_ms:live?percentiles(rows.map(r=>r.age_ms)):null,event_loop_delay_ms:{p50:loopDelay.percentile(50)/1e6,p95:loopDelay.percentile(95)/1e6,max:loopDelay.max/1e6},stages_ms:stageSummary(rows)};
  await writeFile(output,JSON.stringify({scope:live?'Single-source live JPEG/HUD capture -> full OCR + real YOLOP640 and SegFormer512 inference -> image-space road gate. No actuator dispatch.':'Saved captured bytes -> full OCR + real YOLOP640 and SegFormer512 inference -> image-space road gate. Disk acquisition, not live latency.',source:source.href,captureRoot,provider_requested:'dml',warmup_frames:2,game_input_sent:false,driving_enabled:false,summary,rows},null,2));
  console.log(JSON.stringify({output,summary},null,2));
}catch(e){error=e.message;await writeFile(output,JSON.stringify({error,frames:rows.length,rows,game_input_sent:false},null,2));throw e;}
finally{loopDelay.disable();trace.close();client?.close();if(reader)await reader.close();if(vision){await vision.session.release();await vision.semantic.session.release();}}
