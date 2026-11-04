// Conservative image-space occlusion, not a measured vehicle footprint.
// Preserve raw segmentation for evaluation; the corridor uses the stricter copy.
export function addRoadOcclusions(p,vehicles=[]){
  const w=p.gridWidth,h=p.gridHeight,n=w*h;
  if(!Number.isInteger(w)||!Number.isInteger(h)||w<1||h<1||p.road?.length!==n||p.obstacle?.length!==n||p.labels?.length!==n||p.probability?.length!==n)throw Error('Invalid semantic scene');
  const road=Uint8Array.from(p.road),obstacle=Uint8Array.from(p.obstacle),seen=new Uint8Array(n),boxes=[];
  const isVehicle=i=>p.labels[i]>=13&&p.labels[i]<=18&&p.probability[i]>=.5;
  // Fill row gaps inside each 4-connected semantic vehicle's visible silhouette.
  // This also treats the visible ego body as occlusion, without estimating yaw.
  for(let i=0;i<n;i++)if(!seen[i]&&isVehicle(i)){
    const queue=[i];seen[i]=1;let left=w,top=h,right=-1,bottom=-1;
    const rowLeft=new Int32Array(h).fill(w),rowRight=new Int32Array(h).fill(-1);
    for(let j=0;j<queue.length;j++){
      const k=queue[j],x=k%w,y=Math.floor(k/w);left=Math.min(left,x);right=Math.max(right,x);top=Math.min(top,y);bottom=Math.max(bottom,y);
      rowLeft[y]=Math.min(rowLeft[y],x);rowRight[y]=Math.max(rowRight[y],x);
      for(const [xx,yy]of [[x-1,y],[x+1,y],[x,y-1],[x,y+1]]){
        if(xx<0||xx>=w||yy<0||yy>=h)continue;const next=yy*w+xx;
        if(!seen[next]&&isVehicle(next)){seen[next]=1;queue.push(next);}
      }
    }
    boxes.push({x:left/w,y:top/h,w:(right-left+1)/w,h:(bottom-top+1)/h,source:'semantic_vehicle_component'});
    for(let y=top;y<=bottom;y++)for(let x=rowLeft[y];x<=rowRight[y];x++){road[y*w+x]=0;obstacle[y*w+x]=1;}
  }
  for(const b of vehicles){
    if(![b.x,b.y,b.w,b.h].every(Number.isFinite)||b.w<=0||b.h<=0)throw Error('Invalid vehicle box');
    boxes.push({x:b.x,y:b.y,w:b.w,h:b.h,source:'yolop_vehicle'});
  }
  // Outward rounding is conservative. No road is added, interpolated or carried
  // forward from an older frame. False detections can only close a corridor.
  for(const b of boxes.filter(b=>b.source==='yolop_vehicle')){
    const left=Math.max(0,Math.floor(b.x*w)),right=Math.min(w,Math.ceil((b.x+b.w)*w)),top=Math.max(0,Math.floor(b.y*h)),bottom=Math.min(h,Math.ceil((b.y+b.h)*h));
    for(let y=top;y<bottom;y++)for(let x=left;x<right;x++){road[y*w+x]=0;obstacle[y*w+x]=1;}
  }
  let removed=0;for(let i=0;i<n;i++)if(p.road[i]&&!road[i])removed++;
  return {...p,corridorRoad:road,corridorObstacle:obstacle,occlusion:{boxes,removed_road_pixels:removed,scope:'Current-frame semantic row spans plus YOLOP rectangles; occluded road and vehicle heading remain unknown'}};
}
