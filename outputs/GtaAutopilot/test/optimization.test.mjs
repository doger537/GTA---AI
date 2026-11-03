import {test} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {orderedFrameCache} from '../ordered-frame-cache.mjs';
import {imageNetTensor} from '../vision-tensor.mjs';
import {matchGearGlyph} from '../gear-shape.mjs';

test('Parallel frame cache deduplicates, bounds work and preserves first-use order',async()=>{
  let active=0,peak=0;const called=[];
  const frames=['a','b','c','d','e','f','a'];
  const cache=await orderedFrameCache(process.cwd(),[{frames}],async file=>{
    active++;peak=Math.max(peak,active);called.push(path.basename(file));
    await new Promise(r=>setTimeout(r,path.basename(file)==='a'?12:1));active--;return Buffer.from(path.basename(file));
  });
  assert.equal(peak,4);assert.deepEqual(called,frames.slice(0,6));assert.deepEqual([...cache.keys()],frames.slice(0,6));
  for(const [key,value]of cache)assert.equal(value.toString(),key);
});
test('Frame cache rejects traversal and propagates decoder errors',async()=>{
  let called=false;
  await assert.rejects(orderedFrameCache(process.cwd(),[{frames:['../escape.jpg']}],async()=>{called=true;}),/outside dataset/);
  assert.equal(called,false);
  await assert.rejects(orderedFrameCache(process.cwd(),[{frames:['a']}],async()=>{throw Error('decode failed');}),/decode failed/);
});
test('ImageNet channels retain original float32 operation order for every byte',()=>{
  const bytes=Buffer.alloc(256*3);for(let i=0;i<bytes.length;i++)bytes[i]=i%256;
  const reference=new Float32Array(bytes.length),mean=[.485,.456,.406],std=[.229,.224,.225];
  for(let p=0;p<256;p++)for(let c=0;c<3;c++)reference[c*256+p]=(bytes[p*3+c]/255-mean[c])/std[c];
  assert.deepEqual(imageNetTensor(bytes,256),reference);
});
test('Gear cache observes replaced JSON glyphs and mutated Buffer glyphs',()=>{
  const glyph=Buffer.from([255,255,0,0]),t={gear:'1',glyph:glyph.toString('base64')};
  assert.equal(matchGearGlyph(glyph,[t]).valid,true);
  t.glyph=Buffer.from([0,0,255,255]).toString('base64');assert.equal(matchGearGlyph(glyph,[t]).valid,false);
  t.glyph=Buffer.from(glyph);assert.equal(matchGearGlyph(glyph,[t]).valid,true);
  t.glyph.fill(0);assert.equal(matchGearGlyph(glyph,[t]).valid,false);
});
