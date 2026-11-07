// Geometry of a supplied one-cell centerline only. No colour/arrow detector,
// destination inference, navigation intent, old-mask reuse or actuator dispatch.
export function traceMinimapRoute({width,height,centerline,anchor,heading,source}={}){
  const fail=reason=>({geometry_valid:false,navigation_valid:false,intent:'unknown',reason});
  if(!Number.isInteger(width)||!Number.isInteger(height)||width<10||height<10||width>512||height>512||centerline?.length!==width*height||!ArrayBuffer.isView(centerline)||centerline.some(v=>v!==0&&v!==1))return fail('invalid_route_centerline');
  if(!source||!Number.isInteger(source.sequence)||source.sequence<0||![source.capture_start_ms,source.capture_end_ms,source.age_ms].every(Number.isFinite)||source.capture_start_ms<0||source.capture_end_ms<source.capture_start_ms||source.capture_end_ms-source.capture_start_ms>450||source.age_ms<0||source.age_ms>450)return fail('invalid_or_stale_route_source');
  if(!anchor||![anchor.x,anchor.y].every(v=>Number.isFinite(v)&&v>=0&&v<=1))return fail('vehicle_anchor_unknown');
  if(!heading||![heading.x,heading.y].every(Number.isFinite)||Math.hypot(heading.x,heading.y)<.01)return fail('vehicle_heading_unknown');
  const norm=Math.hypot(heading.x,heading.y);if(!Number.isFinite(norm))return fail('vehicle_heading_unknown');const hx=heading.x/norm,hy=heading.y/norm;
  centerline=Uint8Array.from(centerline);
  const scale=Math.max(width,height),ax=anchor.x*width-.5,ay=anchor.y*height-.5;
  const neighbours=i=>{const x=i%width,y=Math.floor(i/width),out=[];for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){
    if(!dx&&!dy)continue;const xx=x+dx,yy=y+dy;if(xx<0||xx>=width||yy<0||yy>=height||!centerline[yy*width+xx])continue;
    // Prefer orthogonal links around a right angle; avoid a triangular shortcut.
    if(dx&&dy&&(centerline[y*width+xx]||centerline[yy*width+x]))continue;out.push(yy*width+xx);
  }return out;};
  const seen=new Uint8Array(centerline.length),components=[];
  for(let i=0;i<centerline.length;i++)if(centerline[i]&&!seen[i]){
    const cells=[i];seen[i]=1;let nearest=i,distance=Infinity;
    for(let k=0;k<cells.length;k++){const j=cells[k],d=Math.hypot(j%width-ax,Math.floor(j/width)-ay);if(d<distance){distance=d;nearest=j;}for(const n of neighbours(j))if(!seen[n]){seen[n]=1;cells.push(n);}}
    components.push({cells,nearest,distance});
  }
  components.sort((a,b)=>a.distance-b.distance);const component=components[0];
  if(!component||component.distance>scale*.06)return fail('route_not_connected_to_vehicle');
  if(components[1]&&components[1].distance-component.distance<=.5)return fail('ambiguous_route_component');
  const ends=component.cells.filter(i=>neighbours(i).length===1);
  if(component.cells.some(i=>neighbours(i).length>2))return fail('branch_or_thick_route_unsupported');
  if(ends.length!==2)return fail('route_loop_or_degenerate');
  const seed=component.nearest,paths=[];
  for(const first of neighbours(seed)){
    const path=[seed,first];let previous=seed,current=first;
    while(true){const next=neighbours(current).filter(i=>i!==previous);if(!next.length)break;previous=current;current=next[0];path.push(current);}
    if(path.length<Math.ceil(scale*.10))continue;
    const look=path[Math.min(path.length-1,Math.ceil(scale*.10))],dx=look%width-seed%width,dy=Math.floor(look/width)-Math.floor(seed/width);
    const distance=Math.hypot(dx,dy),dot=dx/distance*hx+dy/distance*hy;paths.push({path,dot});
  }
  paths.sort((a,b)=>b.dot-a.dot);
  if(!paths.length)return fail('route_too_short');
  if(paths[0].dot<.35||paths[1]&&paths[0].dot-paths[1].dot<.25)return fail('route_direction_ambiguous');
  const points=paths[0].path.map(i=>({x:(i%width+.5)/width,y:(Math.floor(i/width)+.5)/height}));
  return {geometry_valid:true,navigation_valid:false,intent:'unknown',reason:'candidate_geometry_only',source:{...source},points,snap_distance_pixels:component.distance,
    scope:'Image-space centerline geometry from supplied vehicle anchor/heading; no GPS detection, verified turn, destination, metric distance or drive permission'};
}
