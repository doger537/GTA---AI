// Confirms current observations. Never fills an unreadable frame with old data.
export class TemporalPerception {
  constructor({gearFrames=2,roadFrames=3,maxGapMs=250,maxAgeMs=450,maxPathDelta=.035}={}){
    if(![gearFrames,roadFrames].every(n=>Number.isInteger(n)&&n>=1)||![maxGapMs,maxAgeMs,maxPathDelta].every(n=>Number.isFinite(n)&&n>0))throw Error('Invalid temporal configuration');
    Object.assign(this,{gearFrames,roadFrames,maxGapMs,maxAgeMs,maxPathDelta});this.reset();
  }
  reset(){this.last=null;this.gear=null;this.gearCount=0;this.path=null;this.roadCount=0;}
  update(frame){
    const {sequence,capture_start_ms:start,capture_end_ms:end,age_ms:age,state,geometry}=frame;
    if(!Number.isInteger(sequence)||sequence<0||![start,end,age].every(Number.isFinite)||start>end||end-start>this.maxGapMs||age<0||age>this.maxAgeMs||this.last&&(sequence<=this.last.sequence||start<=this.last.start||end<this.last.end)){
      this.reset();return {state:{...state,gear:{valid:false,value:null,reason:'invalid_or_stale_timeline'}},geometry:{valid:false,reason:'invalid_or_stale_timeline'},drive_allowed:false};
    }
    const gap=this.last?start-this.last.start:null,resetByGap=gap!==null&&gap>this.maxGapMs;
    if(resetByGap)this.reset();
    this.last={sequence,start,end};
    const gear=state?.gear;
    if(gear?.valid&&/^[RN1-8]$/.test(gear.value)){
      this.gearCount=this.gear===gear.value?this.gearCount+1:1;this.gear=gear.value;
    }else{this.gear=null;this.gearCount=0;}
    const confirmedGear=this.gearCount>=this.gearFrames;
    const filteredState={...state,gear:confirmedGear?{...gear,temporal_count:this.gearCount}:{valid:false,value:null,observed:gear?.value??null,reason:this.gearCount?'gear_confirming':'gear_unreadable',temporal_count:this.gearCount}};
    // Compare paths only at overlapping image rows, not by differently spaced nodes.
    let delta=null;
    const validPath=geometry?.valid&&validPoints(geometry.points);
    if(validPath){
      if(this.path)delta=pathDelta(this.path,geometry.points);
      this.roadCount=delta!==null&&delta<=this.maxPathDelta?this.roadCount+1:1;
      this.path=geometry.points.map(p=>({...p}));
    }else{this.path=null;this.roadCount=0;}
    const filteredGeometry=validPath&&this.roadCount>=this.roadFrames?{...geometry,temporal_count:this.roadCount}:{valid:false,reason:validPath?'road_confirming':geometry?.reason??'road_unreadable',temporal_count:this.roadCount};
    return {state:filteredState,geometry:filteredGeometry,diagnostics:{reset_by_gap:resetByGap,path_delta:delta,gear_count:this.gearCount,road_count:this.roadCount},drive_allowed:false};
  }
}
function validPoints(points){return Array.isArray(points)&&points.length>=2&&points.every((p,i)=>[p.x,p.y].every(Number.isFinite)&&p.x>=0&&p.x<=1&&p.y>=0&&p.y<=1&&(!i||p.y<points[i-1].y));}
function xAt(points,y){for(let i=1;i<points.length;i++)if(y>=points[i].y-1e-10&&y<=points[i-1].y+1e-10){const a=points[i-1],b=points[i],t=Math.max(0,Math.min(1,(y-a.y)/(b.y-a.y)));return a.x+t*(b.x-a.x);}return null;}
function pathDelta(a,b){
  const lo=Math.max(a.at(-1).y,b.at(-1).y),hi=Math.min(a[0].y,b[0].y);if(hi-lo<.06)return null;
  let delta=0;for(let i=0;i<7;i++){const y=lo+(hi-lo)*i/6;delta=Math.max(delta,Math.abs(xAt(a,y)-xAt(b,y)));}return delta;
}
