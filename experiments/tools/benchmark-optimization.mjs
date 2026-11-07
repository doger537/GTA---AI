// Offline differential checks against the source snapshot. No GTA/bridge imports.
import assert from 'node:assert/strict';import {readFile,writeFile,readdir} from 'node:fs/promises';import {createHash} from 'node:crypto';
import {connectedRoadGeometry as road} from '../../packages/perception/road-corridor.mjs';import {SemanticRoad} from '../../packages/perception/semantic-road.mjs';import {Perception} from '../../packages/perception/perception.mjs';import {gearGlyph,matchGearGlyph,loadGearTemplates} from '../../packages/perception/gear-shape.mjs';import {VehicleStateReader,GAUGE_PROFILE} from '../../packages/perception/vehicle-state.mjs';import {hudProfile} from '../../packages/perception/hud-profile.mjs';import {packGray} from '../../packages/perception/control-vision.mjs';import {packHistory} from '../../training/bc-data.mjs';
const base='../runs/optimization-2026-11-02/baseline/';const oldRoad=(await import(base+'road-corridor.mjs')).connectedRoadGeometry,OldSemantic=(await import(base+'semantic-road.mjs')).SemanticRoad,OldPerception=(await import(base+'perception.mjs')).Perception,oldGear=await import(base+'gear-shape.mjs'),OldState=(await import(base+'vehicle-state.mjs')).VehicleStateReader,oldGray=(await import(base+'control-vision.mjs')).packGray,oldRGB=(await import(base+'bc-data.mjs')).packHistory;
const digest=a=>createHash('sha256').update(Buffer.from(a.buffer,a.byteOffset,a.byteLength)).digest('hex');
let seed=123;const random=()=>{seed=(1664525*seed+1013904223)>>>0;return seed/4294967296;};
function median(x){return [...x].sort((a,b)=>a-b)[Math.floor(x.length/2)];}
function measure(old,next,n){const timings=[[],[]];for(let warm=0;warm<20;warm++){old();next();}for(let k=0;k<7;k++)for(const which of (k%2?[1,0]:[0,1])){const t=performance.now();for(let i=0;i<n;i++)(which?next:old)();timings[which].push((performance.now()-t)/n);}const before=median(timings[0]),after=median(timings[1]);return {before_ms:before,after_ms:after,speedup:before/after,iterations_per_round:n,rounds:7};}
const checks={},timings={};
const masks=[];
for(let k=0;k<240;k++){const w=[32,100,128,256][k%4],h=[64,100,128][k%3],p={gridWidth:w,gridHeight:h,road:new Uint8Array(w*h),obstacle:new Uint8Array(w*h)};for(let y=0;y<h;y++)for(let x=0;x<w;x++){p.road[y*w+x]=(x/w>.15&&x/w<.85&&y/h>.25&&y/h<.6&&random()>.015)?1:0;p.obstacle[y*w+x]=random()<.001?1:0;}masks.push(p);}
for(const name of (await readdir(new URL('../../work/autopilot/road-cache/',import.meta.url))).filter(x=>x.endsWith('.json'))){const p=JSON.parse(await readFile(new URL('../../work/autopilot/road-cache/'+name,import.meta.url)));masks.push(p);}
for(const p of masks)for(const intent of ['lane_follow','straight','left','right'])assert.deepEqual(road(p,intent),oldRoad(p,intent));checks.corridor_cases=masks.length*4;
const wide={gridWidth:128,gridHeight:128,road:new Uint8Array(16384),obstacle:new Uint8Array(16384)};for(let y=28;y<75;y++)for(let x=15;x<113;x++)wide.road[y*128+x]=1;
timings.corridor_wide=measure(()=>oldRoad(wide,'lane_follow'),()=>road(wide,'lane_follow'),300);
const realMasks=masks.slice(240);timings.corridor_real=measure(()=>{for(const p of realMasks)oldRoad(p,'lane_follow');},()=>{for(const p of realMasks)road(p,'lane_follow');},20);
timings.corridor_real.before_ms/=realMasks.length;timings.corridor_real.after_ms/=realMasks.length;timings.corridor_real.scope='per frame, identical full set of eight real masks each iteration';
console.log(JSON.stringify({phase:'corridor',checks:checks.corridor_cases}));
const gray=[0,64,128,255].map(n=>Buffer.alloc(200*66,n)),rgb=[0,64,128,255].map(n=>Buffer.alloc(128*72*3,n));
assert.equal(digest(packGray(gray,200,66)),digest(oldGray(gray,200,66)));assert.equal(digest(packHistory(rgb,128,72)),digest(oldRGB(rgb,128,72)));checks.model_history_bitwise_equal=true;
timings.gray_history=measure(()=>oldGray(gray,200,66),()=>packGray(gray,200,66),1000);timings.rgb_history=measure(()=>oldRGB(rgb,128,72),()=>packHistory(rgb,128,72),800);
const image=await readFile(new URL('../../fixtures/road-day.jpg',import.meta.url));
const {controlVision}=await import('../../packages/perception/control-vision.mjs'),oldVision=(await import(base+'control-vision.mjs')).controlVision;
const root=new URL('../../training/datasets/2026-11-01T17-32-01-342Z/',import.meta.url),{fileURLToPath}=await import('node:url');
const examples=(await readFile(new URL('examples.jsonl',root),'utf8')).trim().split('\n').map(JSON.parse).slice(0,96);
const profilesToCheck=['rgb-v1','rgb-hi-v1','gray-stack-v1','gray-mask-v1','gray-contrast-v1','gray-delta-v1','gray-motion-v1','pilotnet-gray-v1'];
const cacheTimings={};let cacheFrames=0;
for(const name of profilesToCheck){
  const beforeVision=oldVision(name),nextVision=controlVision(name),times=[[],[]];
  for(let round=0;round<3;round++){
    const values=[];
    for(const which of (round%2?[1,0]:[0,1])){const t=performance.now();values[which]=await (which?nextVision:beforeVision).cache(fileURLToPath(root),examples);times[which].push(performance.now()-t);}
    assert.deepEqual([...values[1].keys()],[...values[0].keys()]);
    for(const [key,value]of values[0])assert.equal(digest(values[1].get(key)),digest(value),name+':'+key);
    for(const e of examples)assert.equal(digest(nextVision.pack(e.frames.map(f=>values[1].get(f)))),digest(beforeVision.pack(e.frames.map(f=>values[0].get(f)))),name);
    if(round===0)cacheFrames+=values[0].size;
  }
  cacheTimings[name]={before_ms:median(times[0]),after_ms:median(times[1]),rounds:3};cacheTimings[name].speedup=cacheTimings[name].before_ms/cacheTimings[name].after_ms;
}
checks.image_cache_profiles_equal=profilesToCheck.length;checks.image_cache_frames_bitwise_equal=cacheFrames;checks.cached_model_histories_bitwise_equal=profilesToCheck.length*examples.length*3;
timings.image_caches=cacheTimings;console.log(JSON.stringify({phase:'image-caches',checks}));
const logits=new Float32Array(19*128*128);for(let i=0;i<logits.length;i++)logits[i]=(random()-.5)*16;
let oldTensor,newTensor;const fakeOld={run:async input=>{oldTensor=input.pixel_values.data;return {logits:{dims:[1,19,128,128],data:logits}};}},fakeNew={run:async input=>{newTensor=input.pixel_values.data;return {logits:{dims:[1,19,128,128],data:logits}};}};
const a=new OldSemantic(fakeOld,512,{}),b=new SemanticRoad(fakeNew,512,{});
for(const profile of ['unknown','rear','cockpit'])for(const horizontalFlip of [false,true]){const before=await a.analyze(image,{cameraProfile:profile,horizontalFlip}),after=await b.analyze(image,{cameraProfile:profile,horizontalFlip});assert.equal(digest(oldTensor),digest(newTensor));for(const key of ['labels','probability','road','rawRoad','sidewalk','obstacle'])assert.equal(digest(before[key]),digest(after[key]));}
checks.semantic_tensor_and_masks_bitwise_equal=6;
const asyncTimings=[[],[]];for(let k=0;k<12;k++)for(const which of (k%2?[1,0]:[0,1])){const t=performance.now();await (which?b:a).analyze(image,{cameraProfile:'rear'});if(k>=2)asyncTimings[which].push(performance.now()-t);}timings.semantic_cpu_pipeline={before_ms:median(asyncTimings[0]),after_ms:median(asyncTimings[1]),scope:'real preprocessing and mask decoding, fake inference; excludes GPU model cost'};
const n=320,count=n*n,seg=new Float32Array(count*2);for(let i=0;i<seg.length;i++)seg[i]=random();let yt1,yt2;
const yo=()=>({drive_area_seg:{data:seg},lane_line_seg:{data:seg},det_out:{dims:[1,2,6],data:Float32Array.from([160,160,30,30,.8,.9,180,170,40,40,.2,.9])}});
const ya=new OldPerception({inputNames:['x'],run:async x=>{yt1=x.x.data;return yo();}},n,null,'rear'),yb=new Perception({inputNames:['x'],run:async x=>{yt2=x.x.data;return yo();}},n,null,'rear');
for(const useSemantic of [false,true]){if(useSemantic){ya.semantic={analyze:()=>a.analyze(image,{cameraProfile:'rear'})};yb.semantic={analyze:()=>b.analyze(image,{cameraProfile:'rear'})};}const before=await ya.analyze(image),after=await yb.analyze(image);assert.equal(digest(yt1),digest(yt2));for(const key of ['mask','lane'])assert.equal(digest(before[key]),digest(after[key]));for(const key of ['rows','vehicles','road_fraction','center','confidence'])assert.deepEqual(before[key],after[key]);}checks.combined_perception_equal=2;
const templates=await loadGearTemplates(),labels=JSON.parse(await readFile(new URL('../../fixtures/gear-labels.json',import.meta.url)));let firstGlyph;
for(const row of labels.rows){const bytes=await readFile(new URL(`../recordings/${row.session}/${row.file}`,import.meta.url)),before=await oldGear.gearGlyph(bytes,GAUGE_PROFILE.gear),after=await gearGlyph(bytes,GAUGE_PROFILE.gear);assert.deepEqual(after,before);assert.deepEqual(matchGearGlyph(after,templates),oldGear.matchGearGlyph(before,templates));firstGlyph??=after;}checks.gear_glyph_cases=labels.rows.length;
timings.gear_template_matching=measure(()=>oldGear.matchGearGlyph(firstGlyph,templates),()=>matchGearGlyph(firstGlyph,templates),3000);
console.log(JSON.stringify({phase:'ocr',checks}));
const profiles=[{profile:{...GAUGE_PROFILE,speed:{...GAUGE_PROFILE.speed,padded_consensus:true},gear:{...GAUGE_PROFILE.gear,shape_confirmation:true}},files:labels.rows.map(r=>new URL(`../recordings/${r.session}/${r.file}`,import.meta.url))},{profile:hudProfile(JSON.parse(await readFile(new URL('../../fixtures/native-hud/geometry.json',import.meta.url)))),files:['zero.png','five.png','seven.png'].map(f=>new URL('../../fixtures/native-hud/'+f,import.meta.url))}];
let ocr=0;const ocrTimes=[[],[]];
for(const item of profiles){const old=await OldState.create(item.profile),next=await VehicleStateReader.create(item.profile);try{for(const file of item.files){const bytes=await readFile(file);old.speed.previous=null;next.speed.previous=null;let t=performance.now();const before=await old.read(bytes,100);ocrTimes[0].push(performance.now()-t);t=performance.now();const after=await next.read(bytes,100);ocrTimes[1].push(performance.now()-t);assert.deepEqual(after,before,String(file));ocr++;}}finally{await Promise.all([old.close(),next.close()]);}}
checks.full_ocr_outputs_equal=ocr;timings.full_ocr={before_median_ms:median(ocrTimes[0]),after_median_ms:median(ocrTimes[1]),scope:'single pass over matching ordered recordings; timing indicative, exact output checked'};
const report={scope:'Offline optimization equivalence, not driving quality. No model weights or thresholds changed.',checks,timings};await writeFile(new URL('../runs/optimization-2026-11-02/report.json',import.meta.url),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
