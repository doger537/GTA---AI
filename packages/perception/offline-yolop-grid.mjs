// Offline ablation only. This is not a semantic scene or a live-control input.
import {excludedByCamera} from './camera-profile.mjs';

export function offlineYolopGrid(p, cameraProfile='rear') {
  const {n,top,left,rw,rh}=p.letterbox??{};
  if(p.semantic || ![n,top,left,rw,rh].every(Number.isInteger) || n<1 || rw<1 || rh<1 || top<0 || left<0 || left+rw>n || top+rh>n || p.mask?.length!==n*n || p.mask.some(v=>v!==0&&v!==1))throw Error('Expected raw binary YOLOP mask with valid letterbox');
  if(!Array.isArray(p.vehicles))throw Error('Expected current-frame vehicle boxes');
  const gridWidth=128,gridHeight=128,rawRoad=new Uint8Array(128*128),road=new Uint8Array(128*128),obstacle=new Uint8Array(128*128);
  for(let y=0;y<gridHeight;y++)for(let x=0;x<gridWidth;x++){
    const fx=(x+.5)/gridWidth,fy=(y+.5)/gridHeight;
    const sx=left+Math.min(rw-1,Math.floor(fx*rw)),sy=top+Math.min(rh-1,Math.floor(fy*rh)),i=y*gridWidth+x;
    rawRoad[i]=p.mask[sy*n+sx];
    road[i]=excludedByCamera(fx,fy,cameraProfile)?0:rawRoad[i];
  }
  for(const b of p.vehicles){
    if(![b.x,b.y,b.w,b.h].every(Number.isFinite)||b.w<=0||b.h<=0)throw Error('Invalid vehicle box');
    for(let y=Math.max(0,Math.floor(b.y*gridHeight));y<Math.min(gridHeight,Math.ceil((b.y+b.h)*gridHeight));y++)
      for(let x=Math.max(0,Math.floor(b.x*gridWidth));x<Math.min(gridWidth,Math.ceil((b.x+b.w)*gridWidth));x++)obstacle[y*gridWidth+x]=1;
  }
  const corridorRoad=Uint8Array.from(road);
  for(let i=0;i<corridorRoad.length;i++)if(obstacle[i])corridorRoad[i]=0;
  return {gridWidth,gridHeight,rawRoad,road,obstacle,corridorRoad,corridorObstacle:obstacle,
    scope:'Offline YOLOP road samples and vehicle rectangles only; no semantic obstacle classes, probabilities, hidden-road filling or verified camera heading'};
}
