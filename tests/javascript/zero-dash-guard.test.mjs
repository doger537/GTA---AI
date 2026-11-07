import {test} from 'node:test';import {strict as assert} from 'node:assert';import sharp from 'sharp';
import {SpeedReader} from '../../packages/perception/speed-reader.mjs';
async function source(kind){const w=32,h=23,b=Buffer.alloc(w*h*3);if(kind!=='blank')for(let y=8;y<(kind==='dash'?10:18);y++)for(let x=20;x<(kind==='dash'?26:22);x++)b.fill(255,(y*w+x)*3,(y*w+x+1)*3);return sharp(b,{raw:{width:w,height:h,channels:3}}).png().toBuffer();}
const roi={left:0,top:0,width:32,height:23,dash_means_zero:true,require_consensus:true};
test('OCR dash alone cannot declare a blank region or vertical digit stopped',async()=>{
 for(const kind of ['blank','digit'])for(const text of ['-','–','—'])for(const require_consensus of [false,true]){
  const reader=new SpeedReader({recognize:async()=>({data:{text,confidence:99}})},{...roi,require_consensus});reader.previous={kmh:7,time_ms:900};
  const r=await reader.read(await source(kind),1000);assert.equal(r.valid,false,kind+' '+text);assert.equal(r.kmh,null);assert.equal(r.rejection_reason,'unverified_zero_dash');assert.equal(reader.previous.kmh,7);
 }
});
test('visible dash still means zero without relying on OCR and obeys temporal checks',async()=>{
 const reader=new SpeedReader({recognize:async()=>{throw Error('OCR must not be required for a verified dash');}},roi),bytes=await source('dash');
 const r=await reader.read(bytes,1000);assert.equal(r.valid,true);assert.equal(r.kmh,0);assert.equal(r.source,'configured_zero_dash');
 reader.previous={kmh:75,time_ms:1900};const jump=await reader.read(bytes,2000);assert.equal(jump.valid,false);assert.equal(jump.rejection_reason,'temporal_speed_jump');assert.equal(reader.previous.kmh,75);
});
