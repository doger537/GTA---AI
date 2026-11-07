import {test} from 'node:test';
import {strict as assert} from 'node:assert';
import {offlineYolopGrid} from '../../packages/perception/offline-yolop-grid.mjs';

test('YOLOP ablation samples the image crop without leaking letterbox padding',()=>{
  const n=8,mask=new Uint8Array(n*n).fill(1);
  // Vertical stripe of real road, surrounded by non-road inside a padded image.
  for(let y=2;y<6;y++)for(let x=0;x<8;x++)mask[y*n+x]=x>=4?1:0;
  const p=offlineYolopGrid({mask,letterbox:{n,top:2,left:0,rw:8,rh:4},vehicles:[]});
  for(let y=0;y<128;y++)for(let x=0;x<128;x++)assert.equal(p.rawRoad[y*128+x],x>=64?1:0);
  assert.equal(p.rawRoad[127*128+64],1);
  assert.equal(p.road[127*128+64],0); // rear ego exclusion
  assert.equal(p.road[127*128+120],0); // HUD
  assert.equal(p.road[40*128+64],1);
  assert.equal(p.labels,undefined);
  assert.equal(p.probability,undefined);
});

test('YOLOP ablation keeps raw road but closes boxes with outward rounding and clipping',()=>{
  const p=offlineYolopGrid({mask:new Uint8Array(16).fill(1),letterbox:{n:4,top:0,left:0,rw:4,rh:4},vehicles:[{x:-.01,y:.201,w:.021,h:.001}]});
  for(const y of [25])for(const x of [0,1]){
    const i=y*128+x;assert.equal(p.rawRoad[i],1);assert.equal(p.road[i],1);assert.equal(p.corridorRoad[i],0);assert.equal(p.corridorObstacle[i],1);
  }
  assert.equal(p.corridorRoad[25*128+2],1);
  assert.equal(p.corridorObstacle[24*128],0);
});

test('YOLOP ablation rejects semantic masks and invalid geometry or detections',()=>{
  const p={mask:new Uint8Array(16),letterbox:{n:4,top:0,left:0,rw:4,rh:4},vehicles:[]};
  assert.throws(()=>offlineYolopGrid({...p,semantic:{}}));
  assert.throws(()=>offlineYolopGrid({...p,letterbox:{...p.letterbox,top:1}}));
  assert.throws(()=>offlineYolopGrid({...p,mask:Uint8Array.of(2,...Array(15).fill(0))}));
  assert.throws(()=>offlineYolopGrid({...p,vehicles:[{x:0,y:0,w:NaN,h:.1}]}));
});
