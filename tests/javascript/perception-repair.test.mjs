import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import sharp from 'sharp';
import {segmentSpeedGlyphs,confirmSegmentedSpeed,compatibleSevenReading} from '../../packages/perception/segmented-speed.mjs';
import {SpeedReader} from '../../packages/perception/speed-reader.mjs';
import {addRoadOcclusions} from '../../packages/perception/road-occlusion.mjs';
import {roadGeometry} from '../../packages/navigation/road-guidance.mjs';
import {Perception} from '../../packages/perception/perception.mjs';
const fixture=file=>readFile(new URL('../../fixtures/segmented-speed/'+file,import.meta.url));
async function glyphSource(){const {data,info}=await sharp(await fixture('000532.png')).removeAlpha().raw().toBuffer({resolveWithObject:true});return {data,width:info.width,height:info.height};}

test('Seven repair permits only substitution/deletion at structurally checked seven positions',()=>{
  for(const value of ['75','15','5'])assert.equal(compatibleSevenReading(value,'75'),true);
  for(const value of ['74','14','0','175','005',''])assert.equal(compatibleSevenReading(value,'75'),false);
  assert.equal(compatibleSevenReading('12','127'),true);assert.equal(compatibleSevenReading('17','127'),false);
});
test('Segmentation rejects clipped, blank, touching and unsupported non-seven strings',async()=>{
  const {data,width,height}=await glyphSource();assert.ok(segmentSpeedGlyphs(data,width,height));
  assert.equal(segmentSpeedGlyphs(Buffer.alloc(data.length),width,height),null);
  assert.equal(segmentSpeedGlyphs(data.subarray(3),width,height),null);
  for(const file of ['000044.png','000088.png','000777.png']){const {data,info}=await sharp(await fixture(file)).raw().toBuffer({resolveWithObject:true});assert.equal(segmentSpeedGlyphs(data,info.width,info.height),null);}
  const cropped=await sharp(data,{raw:{width,height,channels:3}}).extract({left:0,top:10,width,height:height-10}).raw().toBuffer();assert.equal(segmentSpeedGlyphs(cropped,width,height-10),null);
});
test('Digit OCR refuses a weak glyph, a different digit or a whole-string conflict and restores parameters',async()=>{
  const {data,width,height}=await glyphSource();
  for(const outputs of [[['7',94],['7',74]],[['7',94],['1',94]],[['7',94],['7',94],['4',94],['4',94]]]){
    const params=[],worker={setParameters:async p=>params.push(p),recognize:async()=>{const [text,confidence]=outputs.shift();return {data:{text,confidence}};}};
    assert.equal((await confirmSegmentedSpeed(worker,data,width,height,[{text:'15',confidence:90}])).valid,false);
    assert.equal(params.at(-1).tessedit_pageseg_mode,'7');assert.equal(params.at(-1).tessedit_char_whitelist,'0123456789.-');
  }
  const params=[],worker={setParameters:async p=>params.push(p),recognize:async()=>{throw Error('OCR failed');}};
  await assert.rejects(confirmSegmentedSpeed(worker,data,width,height));assert.equal(params.at(-1).tessedit_pageseg_mode,'7');
});
test('Real native development crops recover six multi-digit sevens and leave touching 127 unresolved',async()=>{
  const {width,height}=await glyphSource(),reader=await SpeedReader.create({left:0,top:0,width,height,require_consensus:true,padded_consensus:true,single_glyph_confirmation:true,segmented_seven_confirmation:true});
  const labels=JSON.parse(await fixture('labels.json'));
  try{for(const row of labels.rows){reader.previous=null;const result=await reader.read(await fixture(row.file),100);
    if(row.repair_expected){assert.equal(result.valid,true,row.file);assert.equal(result.kmh,row.speed);assert.equal(result.source,'ocr_segmented_seven');}
    else if(row.speed===127)assert.equal(result.valid,false);
    else assert.ok(!result.valid||result.kmh===row.speed);
  }}finally{await reader.close();}
});
const scene=(w=100,h=100)=>({gridWidth:w,gridHeight:h,road:new Uint8Array(w*h).fill(1),obstacle:new Uint8Array(w*h),labels:new Uint8Array(w*h),probability:new Float32Array(w*h).fill(1)});
test('Fused occlusions close a detector-only car and semantic vehicle holes without mutating road or adding free pixels',()=>{
  const p=scene(20,20);for(let y=8;y<14;y++)for(let x=7;x<13;x++)if(x===7||x===12||y===13){p.labels[y*20+x]=13;p.obstacle[y*20+x]=1;p.road[y*20+x]=0;}
  const original=Uint8Array.from(p.road),q=addRoadOcclusions(p,[{x:.1,y:.1,w:.1,h:.1}]);
  assert.equal(q.corridorRoad[10*20+10],0);assert.equal(q.corridorObstacle[2*20+2],1);
  assert.equal(q.corridorRoad[7*20+10],1);assert.equal(q.corridorRoad[8*20+6],1);
  assert.deepEqual(p.road,original);assert.ok(q.corridorRoad.every((v,i)=>!v||p.road[i]));assert.ok(q.corridorObstacle.every((v,i)=>v||!p.obstacle[i]));
});
test('Row silhouettes preserve clear corners of slanted vehicles and never bridge disconnected objects',()=>{
  const p=scene(20,20);for(let y=5;y<=12;y++){const x=y-2;p.labels[y*20+x]=13;p.labels[y*20+x+1]=13;}
  p.labels[6*20+15]=13;p.labels[7*20+15]=13;const q=addRoadOcclusions(p);
  assert.equal(q.corridorRoad[5*20+9],1);assert.equal(q.corridorRoad[6*20+10],1);
  assert.equal(q.corridorRoad[6*20+15],0);assert.equal(q.corridorRoad[6*20+5],0);
});
test('Corridor rejects a detector-only barrier that unmodified semantic road would accept',()=>{
  const p=scene();p.road.fill(0);for(let y=25;y<56;y++)for(let x=30;x<70;x++)p.road[y*100+x]=1;
  assert.equal(roadGeometry(p,'lane_follow').valid,true);
  const q=addRoadOcclusions(p,[{x:.2,y:.44,w:.6,h:.03}]);assert.equal(roadGeometry(q,'lane_follow').valid,false);
  assert.throws(()=>addRoadOcclusions(p,[{x:NaN,y:0,w:1,h:1}]));assert.throws(()=>addRoadOcclusions({...p,labels:[]}));
});
test('Perception scanlines and its exported control mask also exclude detector-only occlusion',async()=>{
  const p=scene(),n=100,session={inputNames:['images'],run:async()=>({drive_area_seg:{data:new Float32Array(2*n*n)},lane_line_seg:{data:new Float32Array(2*n*n)},det_out:{dims:[1,1,6],data:Float32Array.from([50,45,60,3,1,1])}})};
  const perception=new Perception(session,n,{analyze:async()=>p},'rear');
  const bytes=await sharp({create:{width:100,height:100,channels:3,background:'black'}}).png().toBuffer(),result=await perception.analyze(bytes);
  assert.equal(result.vehicles.length,1);assert.equal(result.mask[45*100+50],0);assert.equal(result.semantic.corridorRoad[45*100+50],0);
  assert.equal(result.semantic.road[45*100+50],1);assert.equal(p.road[45*100+50],1);
});
