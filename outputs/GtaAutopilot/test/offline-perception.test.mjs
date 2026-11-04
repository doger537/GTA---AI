import{test}from'node:test';
import assert from'node:assert/strict';
import{readFile}from'node:fs/promises';
import sharp from'sharp';
import{loadDigitModel,decodeDigitModel,extractHudDigits,matchHudDigits,confirmDigitModel}from'../hud-digit-model.mjs';
import{hudProfile}from'../hud-profile.mjs';
import{speedTimingCheck}from'../speed-reader.mjs';
import{visibleRoadReachability}from'../road-topology.mjs';
import{connectedRoadGeometry,corridorSafeGrid}from'../road-corridor.mjs';
import{guidanceGate}from'../road-guidance.mjs';
const rawCrop=async file=>sharp(await readFile(new URL('../fixtures/segmented-speed/'+file,import.meta.url))).removeAlpha().raw().toBuffer({resolveWithObject:true});

test('Frozen digit model fits earlier frames only, covers ten classes, and rejects damaged model data',async()=>{
 const json=JSON.parse(await readFile(new URL('../config/hud-digit-prototypes.json',import.meta.url))),model=decodeDigitModel(json);
 assert.equal(new Set(model.prototypes.map(p=>p.digit)).size,10);assert.equal(model.training.max_frame,399);assert.equal(model.training.check_min_frame,466);
 assert.ok(model.prototypes.every(p=>Number(p.file.slice(0,6))<=399));
 assert.throws(()=>decodeDigitModel({...json,prototypes:json.prototypes.filter(p=>p.digit!=='7')}));
 assert.throws(()=>decodeDigitModel({...json,prototypes:[{...json.prototypes[0],vector:'AAAA'},...json.prototypes.slice(1)]}));
 assert.throws(()=>decodeDigitModel({...json,min_margin:0}));assert.throws(()=>decodeDigitModel({...json,version:2}));
});
test('Digit model requires complete native glyphs and abstains on incompatible geometry and touching characters',async()=>{
 const model=await loadDigitModel();
 for(const[file,text]of [['000044.png','33'],['000088.png','105'],['000866.png','72']]){const {data,info}=await rawCrop(file),match=matchHudDigits(data,info.width,info.height,model);assert.equal(match.valid,true,file);assert.equal(match.text,text);assert.ok(match.digits.every(d=>d.score>=.90&&d.margin>=.08));}
 const {data,info}=await rawCrop('000777.png');assert.equal(matchHudDigits(data,info.width,info.height,model).valid,false);
 assert.equal(matchHudDigits(data,info.width+1,info.height,model).reason,'unsupported_native_geometry');
 assert.equal(extractHudDigits(Buffer.alloc(data.length),info.width,info.height),null);
 assert.equal(extractHudDigits(data.subarray(3),info.width,info.height),null);
});
test('An equally matching different digit class forces abstention, even for an exact prototype',async()=>{
 const model=await loadDigitModel(),{data,info}=await rawCrop('000044.png');
 const ambiguous={...model,prototypes:model.prototypes.flatMap(p=>p.digit==='3'?[p,{...p,digit:'9'}]:[p])};
 assert.equal(matchHudDigits(data,info.width,info.height,ambiguous).valid,false);
});
test('Digit similarity cannot become speed without an exact confident OCR reading',()=>{
 const shape={valid:true,text:'75',digits:[{score:.98,margin:.2}]};
 for(const views of [[],[{text:'15',confidence:99}],[{text:'75',confidence:74}],[{text:'75',confidence:NaN}]])assert.equal(confirmDigitModel(shape,views).valid,false);
 assert.equal(confirmDigitModel(shape,[{text:'75',confidence:75}]).valid,true);
 assert.equal(confirmDigitModel({...shape,valid:false},[{text:'75',confidence:99}]).valid,false);
});
test('Experimental digit model is opt-in and cannot change a normal live HUD profile',async()=>{
 const geometry=JSON.parse(await readFile(new URL('../fixtures/native-hud/geometry.json',import.meta.url)));
 assert.equal(hudProfile(geometry).speed.native_digit_confirmation,false);
 assert.equal(hudProfile(geometry,{digitModel:true}).speed.native_digit_confirmation,true);
 assert.throws(()=>hudProfile(geometry,{digitModel:'true'}));
});
test('Timing diagnostics retain the old jump bound and reject non-increasing or invalid capture times',()=>{
 const previous={kmh:80,time_ms:1000};
 const braking=speedTimingCheck(66,1140,previous);assert.equal(braking.valid,false);assert.equal(braking.reason,'temporal_speed_jump');assert.equal(braking.change_kmh,14);assert.equal(braking.limit_kmh,8);
 assert.equal(speedTimingCheck(72,1140,previous).valid,true);assert.equal(speedTimingCheck(69,1400,previous).valid,true);
 assert.equal(speedTimingCheck(80,1000,previous).reason,'non_increasing_capture_time');assert.equal(speedTimingCheck(80,NaN,previous).valid,false);
 assert.equal(speedTimingCheck(1,3100,previous).valid,true);assert.equal(speedTimingCheck(1,0,null).valid,true);
});
const scene=()=>{const w=100,h=100,road=new Uint8Array(w*h),obstacle=new Uint8Array(w*h);for(let y=25;y<56;y++)for(let x=20;x<80;x++)road[y*w+x]=1;return {gridWidth:w,gridHeight:h,road,obstacle};};
test('Topological detour finds connected visible road that cannot support the constrained steering geometry',()=>{
 const p=scene();for(let x=44;x<80;x++)p.obstacle[48*100+x]=1;
 assert.equal(connectedRoadGeometry(p,'lane_follow').valid,false);
 const q=visibleRoadReachability(p),{safe}=corridorSafeGrid(p);assert.equal(q.reachable,true);assert.ok(q.visible_span>=.10);assert.equal(q.valid,undefined);assert.equal(q.drive_allowed,false);
 for(const point of q.points)assert.equal(safe[Math.floor(point.y*100)*100+Math.floor(point.x*100)],1);
 for(let i=1;i<q.points.length;i++){const a=q.points[i-1],b=q.points[i];assert.ok(Math.abs(Math.abs(a.x-b.x)+Math.abs(a.y-b.y)-.01)<1e-8);}
 const gate=guidanceGate({navigation:{valid:true,intent:'lane_follow'},state:{speed:{valid:true,kmh:10},gear:{valid:true,value:'1'}},geometry:q,age_ms:100});assert.equal(gate.allow_shadow_proposal,false);
});
test('Topological search rejects a complete barrier, missing origin and disconnected islands',()=>{
 const p=scene();for(let x=0;x<100;x++)p.obstacle[48*100+x]=1;assert.equal(visibleRoadReachability(p).reachable,false);
 p.road.fill(0);assert.equal(visibleRoadReachability(p).reason,'projected_seed_not_on_road');
 for(let y=49;y<56;y++)for(let x=44;x<57;x++)p.road[y*100+x]=1;
 for(let y=25;y<45;y++)for(let x=30;x<70;x++)p.road[y*100+x]=1;p.obstacle.fill(0);
 assert.equal(visibleRoadReachability(p).reachable,false);assert.equal(visibleRoadReachability({}).reachable,false);
});
