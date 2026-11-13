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

// Real metric reach needs a camera calibration and a measured reference. The
// caller supplies it; this function never invents pitch, height or focal length.
export function cameraCalibration({heightM=null,pitchDeg=null,verticalFovDeg=null,imageHeightPx=null,source=null}={}){
  const problems=[];
  const finite=(v)=>num(v)&&v>0;
  if(!finite(heightM))problems.push('camera_height_required');
  // Pitch may legitimately be exactly 0 (camera parallel to the road); only a
  // missing or non-numeric value is a problem.
  if(!num(pitchDeg))problems.push('camera_pitch_required');
  if(num(pitchDeg)&&(pitchDeg<=-90||pitchDeg>=90))problems.push('camera_pitch_out_of_range');
  if(!finite(verticalFovDeg)||verticalFovDeg>=180)problems.push('vertical_fov_required');
  if(!finite(imageHeightPx)||!Number.isInteger(imageHeightPx))problems.push('image_height_required');
  if(source!=='measured')problems.push('calibration_source_not_measured');
  if(problems.length)return {ok:false,reason:'incomplete_camera_calibration',problems};
  // Focal length in pixels from the vertical field of view: f = (H/2)/tan(fov/2).
  const focalPx=(imageHeightPx/2)/Math.tan((verticalFovDeg*Math.PI/180)/2);
  return {ok:true,height_m:heightM,pitch_deg:pitchDeg,vertical_fov_deg:verticalFovDeg,
    image_height_px:imageHeightPx,focal_px:focalPx,source,
    scope:'Measured camera calibration only. Pitch sign convention: positive looks up'};
}

// Distance to the ground point seen at image fraction y (0 = top, 1 = bottom),
// using the pinhole model. With no calibration the only honest answer is a
// refusal that still reports the image fraction.
export function groundDistance({y,calibration=null,horizonY=null}={}){
  if(!num(y)||y<0||y>1)return {ok:false,reason:'invalid_image_fraction'};
  if(!calibration?.ok)return {ok:false,reason:'camera_calibration_required',image_fraction:y,
    note:'Rows cannot be converted to metres without a measured camera height, pitch and field of view'};
  const f=calibration.focal_px,h=calibration.height_m,pitch=calibration.pitch_deg*Math.PI/180;
  // Angle below the optical axis of the ray through row y.
  const theta=Math.atan((y-0.5)*calibration.image_height_px/f);
  // Ground plane is pitch radians below the axis at camera height h.
  const angle=pitch+theta;
  if(Math.abs(angle)<1e-6)return {ok:false,reason:'ray_parallel_to_ground',image_fraction:y};
  if(angle<=0)return {ok:false,reason:'ray_above_horizon',image_fraction:y};
  const distance=h/Math.tan(angle);
  if(!num(distance)||distance<=0||distance>1e5)return {ok:false,reason:'distance_out_of_range',image_fraction:y};
  return {ok:true,distance_m:distance,image_fraction:y,angle_below_axis_deg:angle*180/Math.PI,
    scope:'Ground-plane distance for a measured calibration; ignores road slope and body pitch changes'};
}

// What the whole task can and cannot conclude right now. Kept as data so a report
// cannot quietly upgrade "rows at this angle" into "metres on the road".
export function reachScope({calibration=null,haveMarks=false,haveFrames=false}={}){
  return {rows_known:haveMarks&&haveFrames,metres_known:Boolean(calibration?.ok),
    blockers:[...(!haveFrames?['no_frames_measured']:[]),...(!haveMarks?['no_asphalt_edge_marks']:[]),
      ...(calibration?.ok?[]:['no_camera_calibration'])],
    note:'Rows are image-space reach at this angle. Metres additionally need camera height, pitch and field of view, verified independently.',
    scope:ASPHALT_SCOPE};
}
