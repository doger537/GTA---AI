import {test} from 'node:test';import assert from 'node:assert/strict';
import {navigationAtFrame,annotationAtFrame} from '../navigation-context.mjs';
import {roadGeometry,guidanceGate,steeringFeatures} from '../road-guidance.mjs';
import {classifySAction,VehicleStateReader,GAUGE_PROFILE} from '../vehicle-state.mjs';
import {agreeSpeedViews} from '../padded-speed.mjs';
import {confirmGear,matchGearGlyph,loadGearTemplates,gearGlyph} from '../gear-shape.mjs';
import {roadGeometry as oldRoadGeometry} from '../road-guidance-v1.mjs';
import sharp from 'sharp';
import {mergeRoadViews} from '../road-consensus.mjs';
import {SemanticRoad} from '../semantic-road.mjs';
import {readFile} from 'node:fs/promises';
import * as ort from 'onnxruntime-node';import {fileURLToPath} from 'node:url';
const state=(gear='2',kmh=30,t=0)=>({time_ms:t,gear:{valid:true,value:gear},speed:{valid:true,kmh}});
test('Navigation must be explicit and cover the entire capture; keys cannot invent it',()=>{
  assert.equal(navigationAtFrame({keys:['a']},0,100).valid,false);
  const n={valid:true,intent:'left',source:'planner',issued_ms:0,expires_ms:100};
  assert.equal(navigationAtFrame(n,0,100).valid,true);assert.equal(navigationAtFrame(n,0,101).valid,false);assert.equal(navigationAtFrame({...n,issued_ms:1},0,100).valid,false);
  assert.equal(annotationAtFrame({session:'a',intervals:[]},'b',0,1).valid,false);
  const annotations={session:'a',intervals:[{start_ms:0,end_ms:100,intent:'right'}]};
  assert.equal(annotationAtFrame(annotations,'a',10,90).intent,'right');
  assert.equal(annotationAtFrame(annotations,'a',90,110).valid,false);
  assert.equal(annotationAtFrame({...annotations,intervals:[...annotations.intervals,...annotations.intervals]},'a',10,90).valid,false);
});
test('S audit distinguishes observed reverse, forward speed drop and unknown observations',()=>{
  assert.equal(classifySAction(state('R',20)).label,'reverse');assert.equal(classifySAction(state('2',0)).label,'stationary_s');
  assert.equal(classifySAction(state(),state('3',60,0),state('2',30,1000)).label,'observed_deceleration_with_s');
  assert.equal(classifySAction({gear:{valid:false},speed:{valid:true,kmh:20}}).label,'unknown');
});
test('A cached speed result must belong to the same capture and is not read twice',async()=>{
  const reader=await VehicleStateReader.create(),bytes=await readFile(new URL('../recordings/2026-11-02T07-43-54-725Z/000747.jpg',import.meta.url)),speed={valid:true,kmh:64,time_ms:123};
  try{await assert.rejects(()=>reader.read(bytes,124,{speedResult:speed}));reader.speed.read=async()=>{throw Error('Duplicate OCR');};const state=await reader.read(bytes,123,{speedResult:speed});assert.equal(state.speed,speed);assert.equal(state.gear.value,'2');}finally{await reader.close();}
});
test('Unknown or reverse state, expired images and unresolved road never allow driving',()=>{
  const good={navigation:{valid:true,intent:'lane_follow'},state:state(),geometry:{valid:true},age_ms:100};
  assert.equal(guidanceGate(good).allow_shadow_proposal,true);assert.equal(guidanceGate(good).drive_allowed,false);
  for(const change of [{navigation:{valid:false}},{navigation:{valid:true,intent:'invalid'}},{state:state('R')},{state:state('2',150)},{age_ms:600},{geometry:{valid:false}}])assert.equal(guidanceGate({...good,...change}).allow_shadow_proposal,false);
});
test('Road selection rejects hidden headings, obstacles and an unproven turn branch',()=>{
  const p={gridWidth:100,gridHeight:100,road:new Uint8Array(10000),obstacle:new Uint8Array(10000)};
  assert.equal(roadGeometry(p,'lane_follow').valid,false);
  for(let y=25;y<55;y++)for(let x=30;x<70;x++)p.road[y*100+x]=1;
  assert.equal(roadGeometry(p,'lane_follow').valid,true);assert.equal(roadGeometry(p,'left').reason,'turn_branch_not_resolved');
  p.obstacle[44*100+50]=1;const detour=roadGeometry(p,'lane_follow');assert.equal(detour.valid,true);
  assert.ok(detour.points.every(q=>Math.abs(Math.floor(q.y*100)-44)>1||Math.abs(Math.floor(q.x*100)-50)>1));
  for(let x=0;x<100;x++)p.obstacle[44*100+x]=1;
  assert.equal(roadGeometry(p,'lane_follow').valid,false);
});
test('Synthetic geometric steering has correct signs and reduces error in its toy dynamics',async()=>{
  const session=await ort.InferenceSession.create(fileURLToPath(new URL('../trained/geometry-guidance-v1/model.onnx',import.meta.url)),{executionProviders:['cpu']});
  try{for(const initial of [-.5,.5]){let error=initial;for(let i=0;i<35;i++){const f=steeringFeatures({valid:true,near_offset:error,far_offset:error,curvature:0},state('2',30));const p=await session.run({geometry_state:new ort.Tensor('float32',Float32Array.from(f),[1,4])});error-=p.steer.data[0]*.1;}assert.ok(Math.abs(error)<.08);}}finally{await session.release();}
});
test('HUD regression: measured 64/gear 2 reads; the known 75-as-15 failure is not accepted',async()=>{
  const reader=await VehicleStateReader.create({...GAUGE_PROFILE,speed:{...GAUGE_PROFILE.speed,padded_consensus:true}});
  try{const good=await reader.read(await readFile(new URL('../recordings/2026-11-02T07-43-54-725Z/000747.jpg',import.meta.url)),0);assert.equal(good.speed.kmh,64);assert.equal(good.gear.value,'2');
    reader.speed.previous=null;const bad=await reader.read(await readFile(new URL('../recordings/2026-11-02T07-43-54-725Z/001086.jpg',import.meta.url)),1000);assert.ok(!bad.speed.valid||bad.speed.kmh===75);
  }finally{await reader.close();}
});
test('Speed voting requires distinct processing families and rejects conflicting supported numbers',()=>{
  const c=(family,text='75',confidence=90)=>({family,text,confidence});
  assert.equal(agreeSpeedViews([c('gray'),c('cyan')]).text,'75');
  assert.equal(agreeSpeedViews([c('mask'),c('mask')]).valid,false);
  assert.equal(agreeSpeedViews([c('gray'),c('cyan','15')]).valid,false);
  assert.equal(agreeSpeedViews([c('gray'),c('mask'),c('cyan','15'),c('gray','15')]).valid,false);
  assert.equal(agreeSpeedViews([c('gray'),c('cyan','75',NaN)]).valid,false);
  assert.equal(agreeSpeedViews([c('gray','201'),c('cyan','201')]).valid,false);
});
test('Padded speed view recovers a manually labelled 25 and preserves an unresolved 119',async()=>{
  const reader=await VehicleStateReader.create({...GAUGE_PROFILE,speed:{...GAUGE_PROFILE.speed,padded_consensus:true}});
  try{const s=await reader.read(await readFile(new URL('../recordings/2026-11-02T07-43-54-725Z/000205.jpg',import.meta.url)),0);assert.equal(s.speed.valid,true);assert.equal(s.speed.kmh,25);reader.speed.previous=null;const unknown=await reader.read(await readFile(new URL('../recordings/2026-11-02T07-43-54-725Z/000140.jpg',import.meta.url)),1000);assert.equal(unknown.speed.valid,false);}finally{await reader.close();}
});
test('Gear shape confirms only the same OCR symbol and never replaces confident OCR',()=>{
  const low={valid:false,text:'R',value:null,confidence:50},shape={valid:true,value:'R',score:.98,margin:.2};
  assert.equal(confirmGear(low,shape).value,'R');assert.equal(confirmGear({...low,text:'3'},shape).valid,false);
  const good={valid:true,text:'3',value:'3',confidence:89};assert.deepEqual(confirmGear(good,{...shape,value:'1'}),good);
  assert.equal(confirmGear({...low,text:''},shape).valid,false);
});
test('Blank and ambiguous gear shapes remain unknown',async()=>{
  const templates=await loadGearTemplates(),t=templates[0],glyph=Buffer.from(t.glyph,'base64');
  assert.equal(matchGearGlyph(glyph,[t,{...t,id:'other',gear:t.gear==='1'?'2':'1'}]).valid,false);
  const image=await sharp({create:{width:1280,height:668,channels:3,background:'black'}}).jpeg().toBuffer();
  assert.equal(await gearGlyph(image,GAUGE_PROFILE.gear),null);
});
test('Shape-assisted HUD reads reverse and gear 1, and preserves the known 3-versus-1 regression',async()=>{
  const reader=await VehicleStateReader.create({...GAUGE_PROFILE,gear:{...GAUGE_PROFILE.gear,shape_confirmation:true}});
  try{for(const [session,file,expected] of [['2026-11-01T17-32-01-342Z','000013.jpg','R'],['2026-11-01T17-32-01-342Z','000044.jpg','R'],['2026-11-02T07-43-54-725Z','000205.jpg','1'],['2026-11-02T07-43-54-725Z','000985.jpg','3']]){
    const s=await reader.read(await readFile(new URL(`../recordings/${session}/${file}`,import.meta.url)),0);assert.equal(s.gear.valid,true);assert.equal(s.gear.value,expected);
  }}finally{await reader.close();}
});
test('Connected corridor follows a curved mask that cannot support the old straight segment',()=>{
  const p={gridWidth:100,gridHeight:100,road:new Uint8Array(10000),obstacle:new Uint8Array(10000)};
  for(let y=28;y<56;y++){const cx=50+8*Math.sin((.54-y/100)*10);for(let x=0;x<100;x++)if(Math.abs(x-cx)<4)p.road[y*100+x]=1;}
  assert.equal(oldRoadGeometry(p,'lane_follow').valid,false);const g=roadGeometry(p,'lane_follow');assert.equal(g.valid,true);
  for(const q of g.points)assert.equal(p.road[Math.floor(q.y*100)*100+Math.floor(q.x*100)],1);
  for(let i=1;i<g.points.length;i++)assert.ok(Math.abs(g.points[i].x-g.points[i-1].x)<=.010001);
});
test('Disconnected road patches, narrow strips and unsupported navigation do not become a corridor',()=>{
  const p={gridWidth:100,gridHeight:100,road:new Uint8Array(10000),obstacle:new Uint8Array(10000)};
  for(let y=30;y<55;y++)for(let x=30;x<70;x++)if(y<44||y>46)p.road[y*100+x]=1;
  assert.equal(roadGeometry(p,'lane_follow').valid,false);
  p.road.fill(0);for(let y=20;y<60;y++)p.road[y*100+50]=1;assert.equal(roadGeometry(p,'lane_follow').valid,false);
  assert.equal(roadGeometry(p,'unknown').valid,false);assert.equal(roadGeometry(p,'right').valid,false);
});
test('Mirror consensus intersects road, unions obstacles, and rejects incompatible grids',()=>{
  const p={gridWidth:2,gridHeight:1,road:Uint8Array.from([1,1]),rawRoad:Uint8Array.from([1,1]),obstacle:Uint8Array.from([0,0]),inference_ms:10};
  const q={...p,road:Uint8Array.from([1,0]),obstacle:Uint8Array.from([0,1]),inference_ms:12};
  const r=mergeRoadViews(p,q);assert.deepEqual([...r.road],[1,0]);assert.deepEqual([...r.obstacle],[0,1]);assert.equal(r.inference_ms,22);assert.deepEqual([...p.road],[1,1]);
  assert.throws(()=>mergeRoadViews(p,{...q,gridWidth:3}));
});
test('Mirrored semantic logits return to original image coordinates',async()=>{
  const inputs=[],session={run:async t=>{inputs.push([...t.pixel_values.data]);const data=new Float32Array(19*8).fill(-20);for(let y=0;y<2;y++)for(let x=0;x<4;x++)data[(x<2?0:2)*8+y*4+x]=20;return {logits:{dims:[1,19,2,4],data}};}};
  const raw=Buffer.alloc(4*4*3);for(let y=0;y<4;y++)for(let x=0;x<2;x++)raw.fill(255,(y*4+x)*3,(y*4+x)*3+3);
  const bytes=await sharp(raw,{raw:{width:4,height:4,channels:3}}).png().toBuffer(),s=new SemanticRoad(session,4,{});
  const a=await s.analyze(bytes),b=await s.analyze(bytes,{horizontalFlip:true});
  assert.deepEqual([...a.labels],[0,0,2,2,0,0,2,2]);assert.deepEqual([...b.labels],[2,2,0,0,2,2,0,0]);assert.ok(inputs[0][0]>inputs[0][3]);assert.ok(inputs[1][0]<inputs[1][3]);
});
