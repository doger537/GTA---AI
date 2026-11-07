import {test} from 'node:test';import assert from 'node:assert/strict';
import {ObservationStream,validateObservation} from '../../packages/protocols/observation-stream.mjs';
import {ObservationAnalyzer} from '../../packages/perception/observation-analysis.mjs';
import {OperatorSession} from '../../packages/control/operator-session.mjs';
import {observation,status,state} from './fixtures/synthetic-observation.mjs';

test('one observation supplies all components; no frame/hud fallback is requested',async()=>{
 let calls=0;const o=observation(),client={status:async()=>status(),observation:async()=>{calls++;return o;},frame:()=>{throw Error('No legacy frame');},hud:()=>{throw Error('No separate HUD');}};
 const stream=new ObservationStream(client,{clock:()=>0});assert.equal(await stream.read(),o);assert.equal(calls,1);
 await assert.rejects(stream.read(),/Non-increasing/);await assert.rejects(stream.read(),/latched/);
});

test('mixed sequence, generation, timestamps, old age and invalid geometry are rejected',()=>{
 const changes=[o=>{o.hud.sequence++;},o=>{o.minimap.generation++;},o=>{o.road.capture_start_ms--;},o=>{o.road.frame_age_ms=451;},o=>{o.hud.hud.left=-1;},o=>{o.minimap.region.width=5000;},o=>{o.capture_skew_ms=1;},o=>{o.source='separate_captures';}];
 for(const change of changes){const o=observation();change(o);assert.throws(()=>validateObservation(o,{clock:()=>0}));}
});

test('focus/generation/owner changes during capture stop the session',async()=>{
 for(const mutate of [s=>{s.foreground=false;},s=>{s.generation++;},s=>{s.input_owner='gamepad';}]){
  let calls=0;const client={status:async()=>{const s=status();if(calls++)mutate(s);return s;},observation:async()=>observation()};
  await assert.rejects(new ObservationStream(client,{clock:()=>0}).read());
 }
 const busy={...status(),busy:true,input_owner:null};await assert.rejects(new ObservationStream({status:async()=>busy},{clock:()=>0}).read(),/idle/);
});

test('native OCR receives HUD bytes and exact capture time while vision receives road bytes',async()=>{
 const o=observation(),seen=[];
 const analyzer=new ObservationAnalyzer({clock:()=>0,readerFactory:async()=>({read:async(bytes,time)=>{seen.push(['hud',bytes,time]);return state(o);},close:async()=>{}})});
 try{const result=await analyzer.analyze(o,{analyze:async bytes=>{seen.push(['road',bytes]);return {confidence:.9};}});assert.equal(seen[0][1]===o.road.bytes||seen[1][1]===o.road.bytes,true);assert.ok(seen.some(x=>x[0]==='hud'&&x[1]===o.hud.bytes&&x[2]===o.capture_start_ms));assert.equal(result.vision.source.sequence,o.sequence);}finally{await analyzer.close();}
});

test('OCR returned for an older capture cannot be attached to a fresh packet',async()=>{
 const o=observation(),analyzer=new ObservationAnalyzer({clock:()=>0,readerFactory:async()=>({read:async()=>({...state(o),time_ms:o.capture_start_ms-1}),close:async()=>{}})});
 try{await assert.rejects(analyzer.readState(o),/another frame timestamp/);}finally{await analyzer.close();}
});

test('operator preparation replaces an OCR-cold-start stale frame with three fresh observations',async()=>{
 let now=0,sequence=0;const client={status:async()=>status(),observation:async()=>observation(++sequence,{received:now})};
 const analyzer={readState:async o=>{if(o.sequence===1)now+=600;return state(o);},close:async()=>{}};
 const session=new OperatorSession(client,{vehicle_id:'synthetic-unit-car',camera_profile:'rear',clock:()=>now,analyzer});
 try{const permit=await session.prepare();assert.ok(permit);assert.equal(sequence,4);}finally{await session.close();}
});
