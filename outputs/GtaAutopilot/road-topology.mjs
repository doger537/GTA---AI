import {corridorSafeGrid} from './road-corridor.mjs';

// Diagnostic reachability only. A 4-neighbour image path can have sharp corners
// and is NOT a feasible steering trajectory. It intentionally has no `valid`
// geometry flag or steering features and is never supplied to the actuator.
export function visibleRoadReachability(p){
  const prepared=corridorSafeGrid(p);
  const result=(reachable,reason,extra={})=>({reachable,reason,drive_allowed:false,heading_verified:false,scope:'Current-frame image-space connectivity only; vehicle connection, lane, curvature and metric clearance unverified',...extra});
  if(!prepared.valid)return result(false,prepared.reason);
  const {w,h,safe,radius}=prepared;let seed=null;
  for(let y=Math.floor(.54*h);y>=Math.floor(.42*h)&&!seed;y--){
    let nearest=-1,distance=Infinity;
    for(let x=Math.floor(.44*w);x<=Math.ceil(.56*w);x++)if(safe[y*w+x]){const d=Math.abs(x-w*.5);if(d<distance){nearest=x;distance=d;}}
    if(nearest>=0)seed={x:nearest,y};
  }
  if(!seed)return result(false,'projected_seed_not_on_road');
  const minRows=Math.ceil(.10*h),maxRows=Math.ceil(.18*h),top=Math.max(Math.floor(.27*h),seed.y-maxRows),left=Math.floor(.15*w),right=Math.ceil(.85*w)-1;
  const initial=seed.y*w+seed.x,parents=new Int32Array(w*h).fill(-1),queue=new Int32Array(w*h);let head=0,tail=1,end=-1;queue[0]=initial;parents[initial]=initial;
  while(head<tail){
    const i=queue[head++],x=i%w,y=Math.floor(i/w);
    if(seed.y-y>=minRows){end=i;break;}
    // Four-neighbour edges explicitly forbid diagonal corner cutting. Horizontal
    // movement/backtracking is why this is only topology, not a drivable path.
    for(const [xx,yy]of [[x,y-1],[x-1,y],[x+1,y],[x,y+1]]){
      if(xx<left||xx>right||yy<top||yy>seed.y)continue;const next=yy*w+xx;
      if(safe[next]&&parents[next]===-1){parents[next]=i;queue[tail++]=next;}
    }
  }
  if(end<0)return result(false,'no_connected_forward_region',{visited_pixels:tail,seed:{x:(seed.x+.5)/w,y:(seed.y+.5)/h}});
  const reverse=[];let i=end;
  while(true){reverse.push({x:(i%w+.5)/w,y:(Math.floor(i/w)+.5)/h});if(i===initial)break;i=parents[i];}
  const points=reverse.reverse();
  return result(true,'connected_visible_region',{points,visible_span:points[0].y-points.at(-1).y,clearance_grid_pixels:radius,visited_pixels:tail});
}
