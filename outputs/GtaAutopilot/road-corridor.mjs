// Shared current-frame clearance mask. No interpolation or filling unknown road.
export function corridorSafeGrid(p){
  const w=p.gridWidth,h=p.gridHeight;
  const road=p.corridorRoad??p.road,obstacle=p.corridorObstacle??p.obstacle;
  if(!road||w<10||h<10||road.length!==w*h||(obstacle&&obstacle.length!==w*h))return {valid:false,reason:'no_semantic_road'};
  const safe=new Uint8Array(w*h),radius=Math.max(1,Math.round(w/128));
  // Summed-area table preserves the exact rectangular obstacle footprint.
  let obstacleSum=null,stride=w+1;
  if(obstacle){obstacleSum=new Uint32Array((w+1)*(h+1));for(let y=0;y<h;y++){let row=0;for(let x=0;x<w;x++){row+=obstacle[y*w+x]?1:0;obstacleSum[(y+1)*stride+x+1]=obstacleSum[y*stride+x+1]+row;}}}
  for(let y=1;y<h-1;y++)for(let x=radius;x<w-radius;x++){
    let clear=true;for(let dx=-radius;dx<=radius;dx++)if(!road[y*w+x+dx])clear=false;
    if(obstacleSum){const top=Math.max(0,y-radius),bottom=Math.min(h,y+radius+1),left=x-radius,right=x+radius+1;if(obstacleSum[bottom*stride+right]-obstacleSum[top*stride+right]-obstacleSum[bottom*stride+left]+obstacleSum[top*stride+left])clear=false;}
    safe[y*w+x]=clear?1:0;
  }
  return {valid:true,safe,w,h,radius};
}

// Connected image-space path, not a lane, vehicle footprint or metric clearance.
export function connectedRoadGeometry(p,intent){
  const prepared=corridorSafeGrid(p);if(!prepared.valid)return prepared;
  if(!['lane_follow','straight'].includes(intent))return {valid:false,reason:'turn_branch_not_resolved'};
  const {safe,w,h,radius}=prepared;
  // Start near the assumed forward image axis, above the configured ego footprint.
  let seed=null;
  for(let y=Math.floor(.54*h);y>=Math.floor(.42*h)&&!seed;y--){
    let nearest=-1,distance=Infinity;for(let x=Math.floor(.44*w);x<=Math.ceil(.56*w);x++)if(safe[y*w+x]){const d=Math.abs(x-w*.5);if(d<distance){nearest=x;distance=d;}}
    if(nearest>=0)seed={x:nearest,y};
  }
  if(!seed)return {valid:false,reason:'projected_heading_not_on_road'};
  let previous=new Float64Array(w).fill(Infinity);previous[seed.x]=0;
  const parents=new Map();let last={y:seed.y,costs:previous};
  const minRows=Math.ceil(.10*h),maxRows=Math.ceil(.18*h);
  for(let y=seed.y-1;y>=Math.max(Math.floor(.27*h),seed.y-maxRows);y--){
    const next=new Float64Array(w).fill(Infinity),parent=new Int16Array(w).fill(-1);
    const centers=new Float64Array(w);let run=-1;
    for(let x=0;x<=w;x++){if(x<w&&safe[y*w+x]){if(run<0)run=x;}else if(run>=0){const center=(run+x-1)/2;centers.fill(center,run,x);run=-1;}}
    for(let x=Math.floor(.15*w);x<Math.ceil(.85*w);x++)if(safe[y*w+x]){
      const center=centers[x];
      for(let dx=-1;dx<=1;dx++){const px=x+dx;if(px<0||px>=w||!Number.isFinite(previous[px]))continue;
        if(dx&&(!safe[y*w+px]||!safe[(y+1)*w+x]))continue; // no diagonal corner cutting
        const cost=previous[px]+.3*Math.abs(dx)+.04*Math.abs(x-center)+.02*Math.abs(x-seed.x);
        if(cost<next[x]){next[x]=cost;parent[x]=px;}
      }
    }
    if(!next.some(Number.isFinite))break;parents.set(y,parent);last={y,costs:next};previous=next;
  }
  if(seed.y-last.y<minRows)return {valid:false,reason:'connected_road_too_short',visible_span:(seed.y-last.y)/h};
  let x=0;for(let k=1;k<w;k++)if(last.costs[k]<last.costs[x])x=k;
  const reverse=[];for(let y=last.y;y<seed.y;y++){reverse.push({x:(x+.5)/w,y:(y+.5)/h});x=parents.get(y)[x];}
  reverse.push({x:(seed.x+.5)/w,y:(seed.y+.5)/h});const points=reverse.reverse(),near=points[0],far=points.at(-1),mid=points[Math.floor(points.length/2)];
  return {valid:true,points,near_offset:(near.x-.5)/.25,far_offset:(far.x-.5)/.25,curvature:(far.x-2*mid.x+near.x)/.25,road_support:1,visible_span:near.y-far.y,clearance_grid_pixels:radius,scope:'connected image-space corridor only; camera heading, lane ownership and metric clearance unverified'};
}
