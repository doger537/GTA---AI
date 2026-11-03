import {test} from 'node:test';import assert from 'node:assert/strict';import {recordingCrop} from '../recording-camera.mjs';import {controlVision} from '../control-vision.mjs';import {GamepadWorker,AnalogActuator} from '../analog-actuator.mjs';
import {calibrationCommand} from '../calibration-policy.mjs';
import {hudProfile} from '../hud-profile.mjs';import {VehicleStateReader} from '../vehicle-state.mjs';import {readFile} from 'node:fs/promises';import {GtaClient} from '../../GtaControl/bridge-client.mjs';
import sharp from 'sharp';import {sevenGlyph,confirmSingleGlyph} from '../single-glyph-speed.mjs';
const hudGeometry=JSON.parse(await readFile(new URL('../fixtures/native-hud/geometry.json',import.meta.url)));
const observationResponse=()=>({bytes:Buffer.from([1,2,3,4,5,6]),headers:{'content-type':'application/octet-stream','x-observation-version':'1','x-road-bytes':'2','x-hud-bytes':'3','x-minimap-bytes':'1','x-generation':'4','x-frame-sequence':'8','x-capture-start-ms':'100','x-capture-end-ms':'110','x-frame-age-ms':'20','x-minimap-left':'0','x-minimap-top':'700','x-minimap-width':'400','x-minimap-height':'200',...Object.fromEntries(Object.entries(hudGeometry).map(([k,v])=>['x-hud-'+k.replaceAll('_','-'),String(v)]))},roundtrip_ms:25,delivery_ms:1,received_at_ms:200});
test('Single-capture client splits payload without losing common timeline, geometry or generation',async()=>{
  const client=new GtaClient({url:'http://127.0.0.1',token:'test'});client.request=async()=>observationResponse();
  try{const r=await client.observation();assert.deepEqual([...r.road.bytes],[1,2]);assert.deepEqual([...r.hud.bytes],[3,4,5]);assert.deepEqual([...r.minimap.bytes],[6]);assert.equal(r.capture_skew_ms,0);assert.equal(r.generation,4);assert.deepEqual(r.hud.hud,hudGeometry);for(const p of [r.road,r.hud,r.minimap]){assert.equal(p.sequence,r.sequence);assert.equal(p.capture_start_ms,100);assert.equal(p.capture_end_ms,110);}}finally{client.close();}
});
test('Malformed or truncated observation packets fail rather than mixing frames',async()=>{
  const client=new GtaClient({url:'http://127.0.0.1',token:'test'});
  try{for(const patch of [{'x-road-bytes':'3'},{'x-observation-version':'2'},{'x-capture-end-ms':'90'},{'x-generation':'NaN'},{'x-hud-left':'-1'},{'x-minimap-width':'99999'}]){client.request=async()=>{const r=observationResponse();Object.assign(r.headers,patch);return r;};await assert.rejects(client.observation());}}finally{client.close();}
});
async function reviewedSevenSource(){const bytes=await readFile(new URL('../fixtures/native-hud/seven.png',import.meta.url)),p=hudProfile(hudGeometry).speed;const roi={left:Math.round(p.left*hudGeometry.width),top:Math.round(p.top*hudGeometry.height),width:Math.round(p.width*hudGeometry.width),height:Math.round(p.height*hudGeometry.height)};return {...roi,raw:await sharp(bytes).extract(roi).removeAlpha().toColourspace('srgb').raw().toBuffer()};}
test('Seven structure rejects blank, vertical one, dash and duplicated multi-digit ink',async()=>{
  const {raw,width,height}=await reviewedSevenSource();assert.ok(sevenGlyph(raw,width,height));assert.equal(sevenGlyph(Buffer.alloc(raw.length),width,height),null);
  for(const [w,h]of [[2,24],[12,2]]){const b=Buffer.alloc(raw.length);for(let y=5;y<5+h;y++)for(let x=10;x<10+w;x++)b.fill(255,(y*width+x)*3,(y*width+x+1)*3);assert.equal(sevenGlyph(b,width,height),null);}
  const double=Buffer.from(raw);for(let y=0;y<height;y++)for(let x=25;x<width;x++)for(let c=0;c<3;c++)double[(y*width+x-25)*3+c]=raw[(y*width+x)*3+c];assert.equal(sevenGlyph(double,width,height),null);
});
test('Glyph fallback restores worker settings and rejects contradictory or weak renderings',async()=>{
  const {raw,width,height}=await reviewedSevenSource();for(const outputs of [[['7',93],['1',90]],[['7',93],['7',74]]]){const params=[],worker={setParameters:async p=>params.push(p),recognize:async()=>{const [text,confidence]=outputs.shift();return {data:{text,confidence}};}};assert.equal((await confirmSingleGlyph(worker,raw,width,height)).valid,false);assert.equal(params.at(-1).tessedit_char_whitelist,'0123456789.-');}
  const params=[],worker={setParameters:async p=>params.push(p),recognize:async()=>{throw Error('OCR failed');}};await assert.rejects(confirmSingleGlyph(worker,raw,width,height));assert.equal(params.at(-1).tessedit_pageseg_mode,'7');
});
test('Native HUD geometry maps full-client gauge coordinates into the crop and rejects invalid bounds',()=>{
  const p=hudProfile(hudGeometry);assert.ok(p.speed.left>0&&p.speed.left+p.speed.width<1);assert.ok(p.gear.top+p.gear.height<1);
  assert.equal(Math.round(p.gear.left*hudGeometry.width)+hudGeometry.left,Math.round(.8640625*hudGeometry.full_width));
  assert.throws(()=>hudProfile({...hudGeometry,left:-1}));assert.throws(()=>hudProfile({...hudGeometry,width:1}));
});
test('HUD client preserves PNG format and capture timing headers',async()=>{
  const c=new GtaClient({url:'http://127.0.0.1',token:'test'});c.request=async()=>({bytes:Buffer.alloc(1),headers:{'content-type':'image/png','x-frame-sequence':'3','x-capture-start-ms':'100','x-capture-end-ms':'110','x-frame-age-ms':'12',...Object.fromEntries(Object.entries(hudGeometry).map(([k,v])=>['x-hud-'+k.replaceAll('_','-'),String(v)]))},roundtrip_ms:14,delivery_ms:1,received_at_ms:200});
  try{const r=await c.hud();assert.equal(r.mimeType,'image/png');assert.equal(r.capture_start_ms,100);assert.equal(r.capture_end_ms,110);assert.deepEqual(r.hud,hudGeometry);}finally{c.close();}
});
test('Native HUD reads the reviewed zero and five; a digit is not accepted as zero',async()=>{
  const reader=await VehicleStateReader.create(hudProfile(hudGeometry));
  try{for(const [file,value] of [['zero.png',0],['five.png',5]]){reader.speed.previous=null;const s=await reader.read(await readFile(new URL('../fixtures/native-hud/'+file,import.meta.url)),100);assert.equal(s.speed.valid,true);assert.equal(s.speed.kmh,value);}}
  finally{await reader.close();}
});
test('Reviewed native seven is confirmed by OCR and structure, never converted to zero',async()=>{
  const reader=await VehicleStateReader.create(hudProfile(hudGeometry));try{const s=await reader.read(await readFile(new URL('../fixtures/native-hud/seven.png',import.meta.url)),100);assert.equal(s.speed.valid,true);assert.equal(s.speed.kmh,7);assert.equal(s.speed.glyph_confirmation.candidates.length,2);assert.ok(s.speed.glyph_confirmation.candidates.every(c=>c.confidence>=75));}finally{await reader.close();}
});
const obs=(kmh=0,gear='1')=>({speed:{valid:true,kmh},gear:{valid:true,value:gear}});
test('Calibration never accelerates from stale or unreadable measurements',()=>{
  for(const change of [{age_ms:451},{observation:{speed:{valid:false},gear:{valid:true,value:'1'}}},{elapsed_ms:NaN},{throttle:.9}])assert.equal(calibrationCommand({elapsed_ms:0,observation:obs(),age_ms:100,...change}).done,true);
});
test('Calibration releases brake at stationary speed and never brakes a reversing car with LT',()=>{
  const p=calibrationCommand({elapsed_ms:1000,observation:obs(),age_ms:100});assert.equal(p.reason,'stationary_observed');assert.equal(p.command.brake,0);
  for(const speed of [2,20]){const r=calibrationCommand({elapsed_ms:1000,observation:obs(speed,'R'),age_ms:100});assert.equal(r.done,true);assert.equal(r.command.brake,0);}
});
test('Once braking begins the calibration policy does not return to gas before stopping',()=>{
  const r=calibrationCommand({elapsed_ms:300,observation:obs(6),age_ms:100,braking:true});assert.equal(r.command.throttle,0);assert.ok(r.command.brake>0);
});
test('Calibration bounds overspeed braking and limits its total braking interval',()=>{
  const p=calibrationCommand({elapsed_ms:100,observation:obs(13),age_ms:100});assert.equal(p.stop_after_ms,250);assert.equal(p.command.throttle,0);
  assert.equal(calibrationCommand({elapsed_ms:2000,observation:obs(3),age_ms:100}).reason,'braking_time_limit');
});
test('Hood crop scales with resolution and the old crop stays byte-for-byte compatible',()=>{
  assert.deepEqual(recordingCrop('hood',1280,720),{left:0,top:300,width:1280,height:320});
  assert.deepEqual(recordingCrop('hood',1280,668),{left:0,top:278,width:1280,height:297});
  assert.deepEqual(recordingCrop('unknown',1280,668),{left:0,top:133,width:1280,height:367});assert.throws(()=>recordingCrop('sideways',1280,720));
});
test('PilotNet history has the declared dimensions, channel order and one normalization',()=>{
  const v=controlVision('pilotnet-gray-v1'),frames=[0,64,128,255].map(n=>Buffer.alloc(200*66,n)),packed=v.pack(frames);
  assert.deepEqual(v.input,{width:200,height:66,history:4,channels:4});assert.equal(packed.length,200*66*4);
  assert.equal(packed[0],-1);assert.equal(packed[3],1);assert.ok(Math.abs(packed[1]-(64/127.5-1))<1e-6);assert.throws(()=>v.pack(frames.slice(1)));
});
test('Analog contract rejects conflicting pedals, out-of-range values and unmonitored real devices',()=>{
  assert.throws(()=>new AnalogActuator({device:'vgamepad'}));const a=new AnalogActuator({device:'mock'});
  for(const c of [{steer:NaN,throttle:0,brake:0},{steer:2,throttle:0,brake:0},{steer:0,throttle:.1,brake:.1}])assert.throws(()=>a.update(c));
});
test('Bridge stop generation prevents the next analog command',async()=>{
  const calls=[],worker={device:'mock',call:async(op,c)=>{calls.push({op,c});return {ok:true};}};let n=0;
  const bridge={status:async()=>({foreground:true,busy:false,generation:++n<3?7:8})};
  const a=new AnalogActuator(worker,{bridge});a.update({steer:.1,throttle:0,brake:0});await a.start();
  assert.equal(a.fault,'Bridge interrupted analog control');assert.deepEqual(calls.map(c=>c.op),['arm','command','stop']);
});
test('A stale perception command cannot be renewed by the analog loop',async()=>{
  const calls=[],worker={device:'mock',call:async op=>calls.push(op)};let now=0;const a=new AnalogActuator(worker,{clock:()=>now});a.update({steer:0,throttle:.2,brake:0});now=300;await a.start();assert.equal(a.fault,'Control heartbeat expired');assert.deepEqual(calls,['arm','stop']);
});
test('Actual Python mock worker handshakes and returns neutral state on stop',async()=>{
  const w=new GamepadWorker();try{assert.equal((await w.ready).physical_device,false);await w.call('arm');await w.call('command',{steer:.3,throttle:0,brake:0,duration_ms:250});const s=await w.call('stop');assert.equal(s.active,false);assert.deepEqual(s.values,{steer:0,throttle:0,brake:0});}finally{await w.close();}
});
