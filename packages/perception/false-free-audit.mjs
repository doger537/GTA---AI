// False-free audit for the corridor. Answers one question per labelled frame:
// does the mask call "free" a place a human marked as curb, pole, standing car or
// blocked view? The forbidden zone is checked on its own, separately from road
// recall, so a missed road pixel can never be hidden inside a false-free average.
export const AUDIT_SCOPE='Image-space audit of the free/corridor mask against manual points on a development set. Not independent validation, not a metric clearance claim, no driving permission';

// Use vehicle when a visible vehicle's motion is unknown from the labelled frame.
export const HAZARD_KINDS=Object.freeze(['curb','pole','standing_car','vehicle','blocked_view','pedestrian','wall','sign']);

const num=x=>Number.isFinite(x);
const clamp01=x=>Math.max(0,Math.min(1,x));

function gridIndex(p,x,y){
  const gx=Math.min(p.gridWidth-1,Math.max(0,Math.floor(x*p.gridWidth)));
  const gy=Math.min(p.gridHeight-1,Math.max(0,Math.floor(y*p.gridHeight)));
  return gy*p.gridWidth+gx;
}

// Marks every cell inside the path tube: the corridor points plus a half-width on
// each side. The tube is what an "is it free ahead?" question is about, so a
// hazard just outside the tube is not counted as a failure of the path.
// `mask` is the semantic frame the corridor came from; the tube lives on its grid.
export function pathTube(corridor,{halfWidth=0.06,mask=null}={}){
  const w=mask?.gridWidth??null,h=mask?.gridHeight??null;
  if(!corridor?.valid||!Array.isArray(corridor.points)||corridor.points.length<2)return {ok:false,reason:corridor?.reason??'corridor_not_valid'};
  if(!num(halfWidth)||halfWidth<0.01||halfWidth>0.3)return {ok:false,reason:'invalid_half_width'};
  const gw=w??corridor.gridWidth,gh=h??corridor.gridHeight;
  if(!Number.isInteger(gw)||!Number.isInteger(gh)||gw<8||gh<8)return {ok:false,reason:'grid_size_unknown'};
  const tube=new Uint8Array(gw*gh);
  if(corridor.points.some(p=>!num(p?.x)||!num(p?.y)||p.x<0||p.x>1||p.y<0||p.y>1))return {ok:false,reason:'invalid_path_points'};
  const radius=Math.max(1,Math.round(halfWidth*gw));
  for(let i=1;i<corridor.points.length;i++){
    const a=corridor.points[i-1],b=corridor.points[i];
    const steps=Math.max(1,Math.ceil(Math.max(Math.abs(b.x-a.x)*gw,Math.abs(b.y-a.y)*gh)));
    for(let j=0;j<=steps;j++){
      const x=Math.min(gw-1,Math.floor((a.x+(b.x-a.x)*j/steps)*gw)),y=Math.min(gh-1,Math.floor((a.y+(b.y-a.y)*j/steps)*gh));
      for(let xx=Math.max(0,x-radius);xx<=Math.min(gw-1,x+radius);xx++)tube[y*gw+xx]=1;
    }
  }
  let cells=0;for(const v of tube)cells+=v;
  return {ok:true,tube,gridWidth:gw,gridHeight:gh,cells,half_width:halfWidth,
    scope:'Constant image-space half-width; no perspective or metric correction'};
}

// Scores manual points. `points` entries: {x,y,expected:'road'|'hazard',kind?}.
// Unlabelled points are ignored, never guessed.
export function auditFrame(p,points,{corridor=null,tube=null}={}){
  if(!p||!Array.isArray(points))return {ok:false,reason:'points_required'};
  if(!points.length)return {ok:false,reason:'points_required'};
  if(!Number.isInteger(p.gridWidth)||!Number.isInteger(p.gridHeight)||p.gridWidth<1||p.gridHeight<1||['road','corridorRoad','obstacle','corridorObstacle'].some(k=>p[k]&&p[k].length!==p.gridWidth*p.gridHeight)||!p.road)return {ok:false,reason:'invalid_road_mask'};
  const road=p.corridorRoad??p.road,obstacle=p.corridorObstacle??p.obstacle??null;
  if(tube&&((tube.tube??tube).length!==p.gridWidth*p.gridHeight||tube.ok===false))return {ok:false,reason:'invalid_path_tube'};
  const results=[];
  for(const point of points){
    if(point===null||point.expected===null)continue;
    if(!num(point?.x)||!num(point?.y)||point.x<0||point.x>1||point.y<0||point.y>1)throw Error('Point outside the image');
    if(point.expected!=='road'&&point.expected!=='hazard')throw Error('Point must be labelled road or hazard');
    if(point.expected==='hazard'&&!HAZARD_KINDS.includes(point.kind))throw Error('Hazard point needs a known kind: '+HAZARD_KINDS.join(','));
    const i=gridIndex(p,point.x,point.y);
    // Accept both a raw cell array and the pathTube() result.
    const cells=tube?.tube??tube;
    const inTube=cells?cells[i]===1:null;
    results.push({x:point.x,y:point.y,expected:point.expected,kind:point.kind??null,
      predicted_road:road[i]===1,predicted_obstacle:obstacle?obstacle[i]===1:null,in_tube:inTube,
      // The single most dangerous cell state: free according to the mask where a human says it is not.
      false_free:point.expected==='hazard'&&road[i]===1&&obstacle?.[i]!==1,
      missed_road:point.expected==='road'&&road[i]!==1});
  }
  if(!results.length)return {ok:false,reason:'points_required'};
  const hazard=results.filter(r=>r.expected==='hazard'),roadPoints=results.filter(r=>r.expected==='road');
  const inTube=hazard.filter(r=>r.in_tube===true);
  return {ok:true,grid:{width:p.gridWidth,height:p.gridHeight},points:results.length,
    hazard_points:hazard.length,road_points:roadPoints.length,
    false_free:hazard.filter(r=>r.false_free).length,
    false_free_on_path:inTube.filter(r=>r.false_free).length,
    missed_road:roadPoints.filter(r=>r.missed_road).length,
    hazard_kinds:Object.fromEntries(HAZARD_KINDS.map(kind=>{
      const list=hazard.filter(r=>r.kind===kind);
      return [kind,{total:list.length,false_free:list.filter(r=>r.false_free).length}];
    }).filter(([,v])=>v.total>0)),
    corridor_valid:corridor?.valid===true,
    results,scope:AUDIT_SCOPE};
}

export function summarizeAudit(frames,{allowAnyFalseFree=false}={}){
  if(!Array.isArray(frames)||!frames.length)throw Error('A nonempty list of frame audits is required');
  const ok=frames.filter(f=>f?.ok);
  const sum=key=>ok.reduce((a,f)=>a+(f[key]??0),0);
  const falseFreeOnPath=sum('false_free_on_path'),falseFreeAll=sum('false_free');
  // Historical summaries can lack individual points. Preserve unknown coverage.
  let pathCoverage=null;
  if(ok.length && ok.every(f=>Array.isArray(f.results))){
    const hazards=ok.flatMap(f=>f.results).filter(point=>point.expected==='hazard');
    const inside=hazards.filter(point=>point.in_tube===true).length;
    const outside=hazards.filter(point=>point.in_tube===false).length;
    pathCoverage={inside,outside,unavailable:hazards.length-inside-outside,
      false_free_fraction_inside:inside?falseFreeOnPath/inside:null};
  }
  const byKind={};
  for(const f of ok)for(const [kind,v] of Object.entries(f.hazard_kinds??{})){
    byKind[kind]??={total:0,false_free:0};
    byKind[kind].total+=v.total;byKind[kind].false_free+=v.false_free;
  }
  return {frames:frames.length,scored:ok.length,refused:frames.length-ok.length,
    points:sum('points'),hazard_points:sum('hazard_points'),road_points:sum('road_points'),
    false_free_total:falseFreeAll,false_free_on_path:falseFreeOnPath,path_hazard_coverage:pathCoverage,
    missed_road:sum('missed_road'),
    // Any single dangerous false-free on the intended path fails the gate.
    verdict:falseFreeOnPath>0||(allowAnyFalseFree&&falseFreeAll>0)?'false_free_found':
      ok.length!==frames.length||ok.length===0?'insufficient_audit_data':ok.some(f=>f.corridor_valid===false)?'road_not_traversable':'no_false_free_on_labelled_points',
    by_kind:byKind,
    limitations:['Development frames only; these images were used while tuning the models.',
      'A point audit is not a pixel or polygon IoU and cannot prove the whole corridor is safe.',
      'Absence of a false-free point does not mean the corridor is drivable.']
  };
}
