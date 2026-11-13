// Horizon / visible-asphalt limit. A human marks the far edge of continuously
// visible asphalt in one frame; this module turns that mark into (a) how many grid
// rows the camera perspective actually offers at that mark, (b) whether the short
// corridor is caused by the view, the mask or the planner, and (c) how the same
// rows map to metres — but only with a measured camera calibration. Without that
// calibration no metre is printed anywhere.
export const ASPHALT_SCOPE='Image-space asphalt edge, grid rows available at that edge, and planner reach. Not a distance, not a lane, not clearance';

// Perspective row height: a pixel row near the horizon covers a much larger
// distance than a row near the bumper. Rows are never converted to metres by a
// constant factor; the calibration module below does the conversion.
export const ROW_GEOMETRY='Image rows are not equidistant in the world. Any row-to-metre conversion needs camera height, pitch and focal length';

const num=x=>Number.isFinite(x);
const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));

// A polyline of (x,y) in image fractions, from the bottom of the image upwards.
// y must decrease; a duplicated or reversed point is a protocol error, not a
// "close enough" line, because the whole measurement is that monotonicity.
// Two nodes already describe a straight edge; more nodes describe a curved one.
export function ascentProfile(edge,{minPoints=2}={}){
  if(!Array.isArray(edge)||edge.length<minPoints)return {ok:false,reason:'polyline_too_short'};
  const points=[];
  for(const [i,p] of edge.entries()){
    if(!Array.isArray(p)||p.length!==2||!num(p[0])||!num(p[1]))return {ok:false,reason:'invalid_point_at_'+i};
    if(p[0]<0||p[0]>1||p[1]<0||p[1]>1)return {ok:false,reason:'point_outside_image_at_'+i};
    if(i&&p[1]>=edge[i-1][1])return {ok:false,reason:'edge_must_ascend'};
    points.push({x:p[0],y:p[1]});
  }
  return {ok:true,points,near:points[0],far:points.at(-1)};
}

// Interpolates the marked edge at any image height: the mark is a few nodes and
// the frames compared against it are on a coarse grid, so a row needs a value at
// its own height rather than the nearest node.
export function edgeXAt(profile,y){
  if(!profile?.ok)return null;
  const pts=profile.points;
  if(y>=pts[0].y)return pts[0].x;
  if(y<=pts.at(-1).y)return pts.at(-1).x;
  for(let i=1;i<pts.length;i++){
    if(y>=pts[i].y){
      const t=(y-pts[i].y)/(pts[i-1].y-pts[i].y);
      return pts[i].x+t*(pts[i-1].x-pts[i].x);
    }
  }
  return pts.at(-1).x;
}

// How many grid rows the view offers between the planner seed and the marked
// edge. This is a property of the perspective and the mark, not of the model: it
// answers "could any planner have gone further at this angle?".
export function rowsAvailable({profile,gridHeight,seedY=null}={}){
  if(!profile?.ok)return {ok:false,reason:profile?.reason??'edge_required'};
  if(!Number.isInteger(gridHeight)||gridHeight<8)return {ok:false,reason:'invalid_grid_height'};
  const farY=profile.far.y,nearY=profile.near.y;
  const rows=(nearY-farY)*gridHeight;
  // The seed row is where the planner starts; rows above it are the ones a plan
  // can ever use.
  const seed=num(seedY)?seedY:nearY;
  if(seed<farY)return {ok:false,reason:'seed_above_marked_edge'};
  const rowsFromSeed=(seed-farY)*gridHeight;
  return {ok:true,rows_available:rows,rows_from_seed:rowsFromSeed,
    edge_row_from_top:(farY*gridHeight),
    // The same number as a fraction, because a grid is an image-space device.
    visible_span:rows/gridHeight,
    seed_y:seed,far_y:farY,scope:ASPHALT_SCOPE};
}

// Compares the three independent limits for one frame and names the first one
// that bites. Order matters: a planner cannot be blamed for rows the view does
// not offer, and the view cannot be blamed for rows the mask already lost.
export function classifyReach({available=null,planner=null,maskReachRows=null,requiredRows=13}={}){
  if(!available?.ok)return {ok:false,reason:available?.reason??'available_rows_required'};
  if(!Number.isInteger(requiredRows)||requiredRows<1)return {ok:false,reason:'invalid_required_rows'};
  const viewRows=available.rows_from_seed;
  const plannerRows=num(planner)&&planner>=0?planner:null;
  const maskRows=num(maskReachRows)&&maskReachRows>=0?maskReachRows:null;
  // The view limit is what any planner could reach at best; the mask limit is
  // what this model left usable; the planner limit is what the search achieved.
  const limits=[{name:'view',rows:viewRows},{name:'mask',rows:maskRows},{name:'planner',rows:plannerRows}]
    .filter(l=>l.rows!==null);
  const binding=limits.reduce((a,b)=>b.rows<a.rows?b:a);
  const viewAllows=viewRows>=requiredRows;
  const maskAllows=maskRows===null?null:maskRows>=requiredRows;
  const plannerAllows=plannerRows===null?null:plannerRows>=requiredRows;
  const firstBlocker=!viewAllows?'view':maskAllows===false?'mask':plannerAllows===false?'planner':null;
  return {ok:true,view_rows:viewRows,mask_rows:maskRows,planner_rows:plannerRows,
    required_rows:requiredRows,binding_limit:binding.name,
    view_allows_required:viewAllows,mask_allows_required:maskAllows,planner_allows_required:plannerAllows,
    first_blocker:firstBlocker,
    // A frame where the view alone is short is not a perception failure at all.
    eye_view_insufficient:!viewAllows,
    verdict:firstBlocker===null?'reachable':firstBlocker+'_limited',
    scope:ASPHALT_SCOPE};
}

// Real metric reach needs a camera calibration, and a calibration is only as good
// as the evidence behind it. A number plus source:"measured" is a claim, not a
// measurement: it must be checked against at least two independent known distances
// at distinct image rows. This function does that check and refuses otherwise.
export function cameraCalibration({heightM=null,pitchDeg=null,verticalFovDeg=null,imageHeightPx=null,source=null,
  references=[],maxErrorPct=10,minRowsApart=0.05}={}){
  const problems=[];
  const num0=v=>num(v);
  if(!num(heightM)||heightM<=0)problems.push('camera_height_required');
  // Pitch may legitimately be exactly 0 (camera parallel to the road); only a
  // missing or non-numeric value is a problem.
  if(!num0(pitchDeg))problems.push('camera_pitch_required');
  else if(pitchDeg<=-90||pitchDeg>=90)problems.push('camera_pitch_out_of_range');
  if(!num(verticalFovDeg)||verticalFovDeg<=0||verticalFovDeg>=180)problems.push('vertical_fov_required');
  if(!num(imageHeightPx)||!Number.isInteger(imageHeightPx))problems.push('image_height_required');
  if(source!=='measured')problems.push('calibration_source_not_measured');
  if(!num(maxErrorPct)||maxErrorPct<=0||maxErrorPct>=100)problems.push('invalid_max_error');
  if(!num(minRowsApart)||minRowsApart<=0||minRowsApart>=1)problems.push('invalid_min_rows_apart');
  if(!Array.isArray(references))problems.push('references_must_be_an_array');
  if(problems.length)return {ok:false,verified:false,reason:'incomplete_camera_calibration',problems};

  const focalPx=(imageHeightPx/2)/Math.tan((verticalFovDeg*Math.PI/180)/2);
  const base={height_m:heightM,pitch_deg:pitchDeg,vertical_fov_deg:verticalFovDeg,image_height_px:imageHeightPx,
    focal_px:focalPx,source,
    scope:'Measured camera calibration checked against independent references. Pitch sign convention: positive looks up'};

  // Each reference is a ground distance that was measured independently and seen
  // at a specific image row. The model is compared with the observation.
  const refProblems=[],checked=[];
  for(const [i,r] of references.entries()){
    const at='reference '+i;
    if(!r||typeof r!=='object'){refProblems.push(at+': invalid');continue;}
    if(typeof r.name!=='string'||!r.name.trim())refProblems.push(at+': name_required');
    if(!num(r.imageY)||r.imageY<0||r.imageY>1){refProblems.push(at+': image_y_required');continue;}
    if(!num(r.observedM)||r.observedM<=0){refProblems.push(at+': observed_distance_required');continue;}
    if(typeof r.independent!=='boolean')refProblems.push(at+': independence_must_be_declared');
    const predicted=groundDistanceUnchecked({y:r.imageY,focalPx,heightM,pitchDeg,imageHeightPx});
    if(!predicted.ok){refProblems.push(at+': '+predicted.reason);continue;}
    const errorPct=Math.abs(predicted.distance_m-r.observedM)/r.observedM*100;
    checked.push({name:r.name,image_y:r.imageY,observed_m:r.observedM,predicted_m:predicted.distance_m,
      error_pct:errorPct,independent:r.independent===true,ok:errorPct<=maxErrorPct});
    if(errorPct>maxErrorPct)refProblems.push(at+': camera_model_disagrees_with_measurement');
    if(r.independent!==true)refProblems.push(at+': reference_not_declared_independent');
  }
  if(references.length<2)refProblems.push('at_least_two_references_required');
  // Two references that look at nearly the same row are one measurement repeated:
  // they cannot cross-check the perspective.
  const rows=checked.map(c=>c.image_y).sort((a,b)=>a-b);
  const rowsApart=rows.length>1?rows.at(-1)-rows[0]:0;
  if(checked.length>1&&rowsApart<minRowsApart)refProblems.push('references_not_independent_rows');
  const verified=refProblems.length===0;
  return {...base,ok:verified,verified,
    reason:verified?null:'calibration_not_verified',
    problems:refProblems,
    verification:verified?{references:checked,max_error_pct:maxErrorPct,rows_apart:rowsApart,
      // Stated plainly: this module checks numbers and declared independence. It
      // cannot prove that the two measurements were physically independent.
      independence:'declared by the caller, not provable here'}:null};
}

// Shared pinhole maths. Kept private so a caller cannot get a distance from a
// calibration object that was never verified.
function groundDistanceUnchecked({y,focalPx,heightM,pitchDeg,imageHeightPx}){
  const pitch=pitchDeg*Math.PI/180;
  const theta=Math.atan((y-0.5)*imageHeightPx/focalPx);
  const angle=pitch+theta;
  if(Math.abs(angle)<1e-6)return {ok:false,reason:'ray_parallel_to_ground'};
  if(angle<=0)return {ok:false,reason:'ray_above_horizon'};
  const distance=heightM/Math.tan(angle);
  if(!num(distance)||distance<=0||distance>1e5)return {ok:false,reason:'distance_out_of_range'};
  return {ok:true,distance_m:distance,angle_below_axis_deg:angle*180/Math.PI};
}

// Distance to the ground point seen at image fraction y (0 = top, 1 = bottom).
// It refuses any calibration that was not verified by cameraCalibration: a bare
// {ok:true} object, a hand-written JSON or a partially filled calibration all
// produce camera_calibration_required instead of a number.
export function groundDistance({y,calibration=null}={}){
  if(!num(y)||y<0||y>1)return {ok:false,reason:'invalid_image_fraction'};
  const verified=calibration?.verified===true&&calibration?.ok===true
    &&num(calibration.focal_px)&&calibration.focal_px>0
    &&num(calibration.height_m)&&calibration.height_m>0
    &&num(calibration.pitch_deg)&&num(calibration.image_height_px)
    &&Array.isArray(calibration.verification?.references)
    &&calibration.verification.references.length>=2
    &&calibration.verification.references.every(r=>r?.ok===true);
  if(!verified)return {ok:false,reason:'camera_calibration_required',image_fraction:y,
    note:'Rows cannot be converted to metres without a verified camera calibration: height, pitch, field of view and at least two independent measured distances at distinct image rows'};
  const got=groundDistanceUnchecked({y,focalPx:calibration.focal_px,heightM:calibration.height_m,
    pitchDeg:calibration.pitch_deg,imageHeightPx:calibration.image_height_px});
  if(!got.ok)return {...got,image_fraction:y};
  return {ok:true,distance_m:got.distance_m,image_fraction:y,angle_below_axis_deg:got.angle_below_axis_deg,
    calibration_error_pct:calibration.verification.max_error_pct,
    scope:'Ground-plane distance for a verified calibration; ignores road slope and body pitch changes'};
}

// What the whole task can and cannot conclude right now. Kept as data so a report
// cannot quietly upgrade "rows at this angle" into "metres on the road".
export function reachScope({calibration=null,haveMarks=false,haveFrames=false}={}){
  return {rows_known:haveMarks&&haveFrames,metres_known:calibration?.verified===true&&calibration?.ok===true,
    blockers:[...(!haveFrames?['no_frames_measured']:[]),...(!haveMarks?['no_asphalt_edge_marks']:[]),
      ...(calibration?.verified===true&&calibration?.ok===true?[]:['no_verified_camera_calibration'])],
    note:'Rows are image-space reach at this angle. Metres additionally need camera height, pitch and field of view, verified independently.',
    scope:ASPHALT_SCOPE};
}
