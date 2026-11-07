import {test} from 'node:test';import assert from 'node:assert/strict';
import sharp from 'sharp';
import {grayRoad,packMotion,packGray,ablationFrame,maskedPreparedPixel,controlVision} from '../../packages/perception/control-vision.mjs';
test('Ablation profiles differ by one declared factor relative to their parent',()=>{
  const pairs=[['rgb-hi-v1','gray-stack-v1','rgb'],['gray-stack-v1','gray-mask-v1','mask'],['gray-stack-v1','gray-contrast-v1','contrast'],['gray-stack-v1','gray-delta-v1','motion']];
  for(const [a,b,changed] of pairs){const aa=controlVision(a),bb=controlVision(b);assert.deepEqual(Object.keys(aa.traits).filter(k=>aa.traits[k]!==bb.traits[k]),[changed]);}
  const p=packGray([Buffer.from([0]),Buffer.from([64]),Buffer.from([128]),Buffer.from([255])],1,1);assert.equal(p[0],-1);assert.equal(p[3],1);
});
test('Single-factor mask changes only excluded pixels and preserves visible RGB/gray shape',async()=>{
  const bytes=await sharp({create:{width:320,height:180,channels:3,background:'#ff0000'}}).png().toBuffer();
  const plain=await ablationFrame(bytes),masked=await ablationFrame(bytes,{mask:true}),rgb=await ablationFrame(bytes,{rgb:true});
  assert.equal(rgb.length,128*72*3);assert.equal(plain[0],masked[0]);assert.notEqual(plain[70*128+64],masked[70*128+64]);assert.equal(masked[70*128+64],128);
});
test('Prepared crop coordinates map ego car and HUD back to original camera masks',()=>{
  assert.equal(maskedPreparedPixel(.5,.9),true);assert.equal(maskedPreparedPixel(.95,.9),true);assert.equal(maskedPreparedPixel(.3,.6),false);
});
test('Motion channels preserve change direction and clipping with newest brightness first',()=>{
  const v=packMotion([Buffer.from([0]),Buffer.from([50]),Buffer.from([25]),Buffer.from([255])],1,1);
  assert.equal(v[0],1);assert.ok(v[1]>0);assert.ok(v[2]<0);assert.equal(v[3],1);assert.throws(()=>packMotion([],1,1));
});
test('Masked pixels stay neutral after contrast processing and profile remains versioned',async()=>{
  const bytes=await sharp({create:{width:320,height:180,channels:3,background:'#ff0000'}}).png().toBuffer();
  const b=await grayRoad(bytes);assert.equal(b.length,128*72);assert.equal(b[70*128+64],128);
  assert.equal(controlVision('rgb-v1').input.channels,12);assert.equal(controlVision('gray-motion-v1').input.channels,4);assert.throws(()=>controlVision('unknown'));
});
