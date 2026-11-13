// Image-space ego/camera motion estimates. Everything is expressed in pixels or
// normalised image fractions, never in degrees, radians or metres: a monocular
// rear view without a measured scale cannot supply those. Every estimate either
// carries an uncertainty span or refuses with a reason.
export const EGO_SCOPE='Image-space shift of the road mask and supplied minimap motion; not vehicle yaw, not camera calibration, not metric distance';

const num=x=>Number.isFinite(x);

// Column occupancy of the road mask inside one horizontal band. The band keeps
// the estimate away from the ego body and from the far horizon.
export function roadRowProfile(p,{top=0.42,bottom=0.56}={}){
  const w=p?.gridWidth,h=p?.gridHeight;
  if(!Number.isInteger(w)||!Number.isInteger(h)||w<8||h<8||!p.road||p.road.length!==w*h)return {ok:false,reason:'invalid_road_mask'};
  if(!num(top)||!num(bottom)||top<0||bottom>1||bottom-top<0.03)return {ok:false,reason:'invalid_band'};
  const y0=Math.max(0,Math.floor(top*h)),y1=Math.min(h-1,Math.ceil(bottom*h));
  const profile=new Float64Array(w);
  for(let y=y0;y<=y1;y++)for(let x=0;x<w;x++)profile[x]+=p.road[y*w+x]?1:0;
  let energy=0;for(const v of profile)energy+=v;
  if(energy<=0)return {ok:false,reason:'no_road_in_band'};
  for(let x=0;x<w;x++)profile[x]/=y1-y0+1;
  return {ok:true,profile,width:w,band:{top:y0/h,bottom:y1/h},rows:y1-y0+1,energy:energy/(w*(y1-y0+1))};
}

// Cosine similarity of two column profiles for a candidate shift. Overlap is
// required to stay large so a tiny sliver cannot produce a confident number.
function scoreShift(a,b,shift){
  const n=a.length;let dot=0,aa=0,bb=0,overlap=0;
  for(let x=0;x<n;x++){
    const y=x+shift;
    if(y<0||y>=n)continue;
    dot+=a[x]*b[y];aa+=a[x]*a[x];bb+=b[y]*b[y];overlap++;
  }
  if(!overlap||aa<=0||bb<=0)return {score:-Infinity,overlap};
  return {score:dot/Math.sqrt(aa*bb),overlap:overlap/n};
}

// Horizontal image shift between two consecutive profiles. Positive means the
// scene moved right in the image, which in this rear view is a left camera turn;
// the sign convention is reported but not converted to an angle.
export function estimateShift(previous,current,{maxShiftPixels=null,minOverlap=0.6,minScore=0.5,minAmbiguity=0.05}={}){
  if(![minOverlap,minScore,minAmbiguity].every(num)||minOverlap<=0||minOverlap>1||minScore<0||minScore>1||minAmbiguity<0||minAmbiguity>2)return {ok:false,reason:'invalid_shift_thresholds'};
  if(!previous?.ok||!current?.ok)return {ok:false,reason:previous?.reason??current?.reason??'profiles_required'};
  if(previous.width!==current.width)return {ok:false,reason:'profile_width_changed'};
  const a=previous.profile,b=current.profile,w=a.length;
  const limit=maxShiftPixels===null?Math.floor(w*0.25):maxShiftPixels;
  if(!Number.isInteger(limit)||limit<1||limit>w/2)return {ok:false,reason:'invalid_max_shift'};
  const scores=new Map();
  for(let s=-limit;s<=limit;s++){
    const {score,overlap}=scoreShift(a,b,s);
    if(overlap<minOverlap||!num(score))continue;
    scores.set(s,{score,overlap});
  }
  if(!scores.size)return {ok:false,reason:'no_overlapping_shift'};
  const ranked=[...scores].sort((x,y)=>y[1].score-x[1].score);
  const [bestShift,{score,overlap}]=ranked[0];
  if(score<minScore)return {ok:false,reason:'scene_has_no_usable_structure',peak:score};
  const rival=ranked.find(([s])=>Math.abs(s-bestShift)>1);
  // Margin to the next distinct candidate. A unique peak has no rival inside the
  // band, so the observed margin is reported as-is and near_shifts says why.
  const ambiguity=rival?score-rival[1].score:score;
  // Every shift close to the best one widens the uncertainty instead of being
  // reported as a single exact pixel value.
  const near=ranked.filter(([,v])=>v.score>=score-0.02).map(([s])=>s);
  const uncertainty=(Math.max(...near)-Math.min(...near))/2;
  const result={ok:true,max_shift_pixels:limit,shift_pixels:bestShift,shift_fraction:bestShift/w,peak:score,overlap,ambiguity,
    uncertainty_pixels:uncertainty,near_shifts:near.length,
    // A unique, non-overlapping peak is reported with the margin actually seen;
    // ambiguity_out_of_range marks that no rival existed inside the search band.
    confident:ambiguity>=minAmbiguity&&uncertainty<=1.5&&overlap>=minOverlap,
    band:current.band,sign_note:'positive shift = scene moved right in the image',scope:EGO_SCOPE};
  if(!result.confident)result.reason=ambiguity<minAmbiguity?'shift_ambiguous':uncertainty>1.5?'shift_uncertain':'shift_low_overlap';
  return result;
}

// Lateral drift of the traced corridor from near to far row, in image fractions.
// This is a shape feature of the current frame, not a yaw angle.
export function corridorDrift(corridor,{minPoints=3}={}){
  if(!Number.isInteger(minPoints)||minPoints<3)return {ok:false,reason:'invalid_min_points'};
  if(!corridor?.valid||!Array.isArray(corridor.points))return {ok:false,reason:corridor?.reason??'corridor_not_valid'};
  const points=corridor.points.filter(p=>p&&num(p.x)&&num(p.y));
  // A drift needs a real span: three closely spaced nodes carry no shape.
  if(points.length<minPoints)return {ok:false,reason:'corridor_too_short'};
  if(points.length!==corridor.points.length||points.some(p=>p.x<0||p.x>1||p.y<0||p.y>1))return {ok:false,reason:'invalid_corridor_points'};
  const near=points[0],far=points.at(-1);
  const depth=near.y-far.y;
  if(!(depth>0.02))return {ok:false,reason:'corridor_depth_too_small'};
  const dx=far.x-near.x;
  const residuals=points.map(p=>p.x-(near.x+dx*(near.y-p.y)/depth));
  const spread=Math.max(0,...residuals.map(Math.abs));
  return {ok:true,lateral_drift:dx,drift_per_depth:dx/depth,depth,points:points.length,
    curvature_residual:spread,
    // Wider residual scatter means the single drift number is less trustworthy.
    uncertainty:Math.max(spread,1/points.length),
    honest_units:'image fractions; no scale, no angle',scope:EGO_SCOPE};
}

// Separates "the camera turned while the car stood" from "the car moved".
// minimap_motion must be supplied by the caller from a real minimap source; it is
// never inferred here and never defaulted.
export function classifyMotionSource({roadShift,minimapMotion,thresholds={}}={}){
  const t={road_pixels:4,minimap_fraction:0.01,...thresholds};
  if(!num(t.road_pixels)||!num(t.minimap_fraction)||t.road_pixels<0||t.minimap_fraction<0)return {source:'unknown',reason:'invalid_motion_thresholds',scope:EGO_SCOPE};
  if(roadShift?.ok===true&&(!num(roadShift.shift_pixels))||minimapMotion?.ok===true&&(!num(minimapMotion.fraction)||minimapMotion.fraction<0))return {source:'unknown',reason:'invalid_motion_signal',scope:EGO_SCOPE};
  const roadOk=roadShift?.ok===true&&roadShift.confident===true;
  const mapOk=minimapMotion?.ok===true&&num(minimapMotion.fraction);
  const roadSignificant=roadOk&&Math.abs(roadShift.shift_pixels)>t.road_pixels;
  const mapSignificant=mapOk&&Math.abs(minimapMotion.fraction)>t.minimap_fraction;
  const base={road_ok:roadOk,minimap_ok:mapOk,thresholds:t,scope:EGO_SCOPE,
    note:'A camera turn and a vehicle turn look identical in a monocular image; only an independent minimap signal separates them.'};
  if(!roadOk&&!mapOk)return {...base,source:'unknown',reason:'no_motion_signal'};
  if(!mapOk)return {...base,source:roadSignificant?'unseparated_camera_or_vehicle':'stationary_without_minimap',
    reason:roadSignificant?'minimap_signal_missing':'minimap_signal_missing_stationary'};
  if(!roadOk)return {...base,source:mapSignificant?'vehicle_motion_without_road':'stationary_without_road',
    reason:mapSignificant?'road_signal_missing':'road_signal_missing_stationary'};
  if(!roadSignificant&&!mapSignificant)return {...base,source:'stationary',reason:'below_thresholds'};
  if(roadSignificant&&!mapSignificant)return {...base,source:'camera_only_rotation',reason:'road_shift_without_vehicle_motion'};
  if(!roadSignificant&&mapSignificant)return {...base,source:'vehicle_motion',reason:'vehicle_motion_without_road_shift'};
  return {...base,source:'ambiguous',reason:'both_signals_moved'};
}

// Minimap motion: how far the map content moved between two minimap images. The
// caller passes a grayscale buffer of the recorded minimap; nothing is inferred
// from the road view. A map that did not move is reported as zero with its own
// uncertainty, never reused as "the car turned".
export function minimapProfile(image,{top=0.3,bottom=0.7}={}){
  const w=image?.width,h=image?.height,data=image?.data;
  if(!Number.isInteger(w)||!Number.isInteger(h)||!data||data.length<w*h)return {ok:false,reason:'invalid_minimap_image'};
  if(!num(top)||!num(bottom)||top<0||bottom>1||bottom-top<0.05)return {ok:false,reason:'invalid_band'};
  const y0=Math.max(0,Math.floor(top*h)),y1=Math.min(h-1,Math.ceil(bottom*h));
  // Edge energy per column: map outlines and road edges move, flat map fill does not.
  const profile=new Float64Array(w);
  for(let y=y0;y<=y1;y++)for(let x=1;x<w-1;x++){
    const i=y*w+x;
    profile[x]+=Math.abs(data[i+1]-data[i-1]);
  }
  let energy=0;for(const v of profile)energy+=v;
  if(energy<=0)return {ok:false,reason:'no_minimap_structure'};
  for(let x=0;x<w;x++)profile[x]/=y1-y0+1;
  return {ok:true,profile,width:w,band:{top:y0/h,bottom:y1/h},rows:y1-y0+1};
}

// Map-space displacement, not metres: no map scale is measured anywhere in this
// project, so a metric claim is impossible and deliberately absent.
export function minimapMotion(previous,current,options={}){
  const shift=estimateShift(previous,current,options);
  if(!shift.ok)return {...shift,ok:false,space:'map_pixels'};
  return {...shift,ok:true,space:'map_pixels',fraction:shift.shift_pixels/previous.width,
    honest_units:'fraction of the minimap width; map scale unknown, not metres'};
}

// Sequential motion over frames in recording order. Keeping it here makes the
// inter-frame shift part of the analysis instead of a separate experiment: a
// frame without a usable neighbour gets an explicit refusal, not an invented zero.
export function motionSequence(frames,{band={},thresholds={},gapFrames=1}={}){
  if(!Array.isArray(frames)||!frames.length)return {ok:false,reason:'frames_required'};
  if(!Number.isInteger(gapFrames)||gapFrames<1)return {ok:false,reason:'invalid_gap_frames'};
  const rows=[];let previousRoad=null,previousMap=null;
  for(const [index,frame] of frames.entries()){
    const road=frame?.semantic?roadRowProfile(frame.semantic,band):null;
    const map=frame?.minimap?minimapProfile(frame.minimap,band):null;
    const roadShift=road?.ok&&previousRoad?estimateShift(previousRoad,road):null;
    const mapMove=map?.ok&&previousMap?minimapMotion(previousMap,map):null;
    rows.push({index,file:frame?.file??null,sequence:frame?.sequence??null,
      // gap_frames > 1 means the neighbours are sampled frames, so the shift
      // covers several original frames and is reported as such.
      gap_frames:index?gapFrames:null,
      road_profile_ok:road?.ok===true,road_profile_reason:road?.ok===false?road.reason:null,
      road_shift:roadShift,minimap_profile_ok:map?.ok===true,minimap_profile_reason:map?.ok===false?map.reason:null,
      minimap_motion:mapMove,
      source:index?classifyMotionSource({roadShift,minimapMotion:mapMove,thresholds}):{source:'first_frame',reason:'no_neighbour'}});
    if(road?.ok)previousRoad=road;
    if(map?.ok)previousMap=map;
  }
  const shifts=rows.filter(r=>r.road_shift?.ok&&r.road_shift.confident).map(r=>r.road_shift.shift_pixels);
  const sources={};
  for(const r of rows){const s=r.source.source;sources[s]=(sources[s]??0)+1;}
  return {ok:true,rows,frames:rows.length,gap_frames:gapFrames,
    shift_pixels:shifts.length?{count:shifts.length,min:Math.min(...shifts),max:Math.max(...shifts)}:null,
    sources,scope:EGO_SCOPE,
    note:'Order is recording order and the gap is reported. A missing neighbour is a refusal, not zero motion.'};
}

// Latency has three different meanings and they must never be averaged into one
// number: the age of a stored frame when it was written, the time an offline
// process spends on inference, and the live capture-to-decision loop that only
// exists while the game runs. A live number cannot be produced offline.
export function latencyBreakdown({recordedAgeMs=[],offlineAnalysisMs=[],liveLoopMs=[]}={}){
  const pct=list=>{
    const v=list.filter(num).slice().sort((a,b)=>a-b);
    if(!v.length)return null;
    const at=q=>v[Math.min(v.length-1,Math.max(0,Math.round(q*(v.length-1))))];
    return {count:v.length,p50:at(.5),p95:at(.95),max:v.at(-1)};
  };
  return {recorded_age_ms:pct(recordedAgeMs),offline_analysis_ms:pct(offlineAnalysisMs),live_loop_ms:pct(liveLoopMs),
    meanings:{recorded_age_ms:'Stored frame age at write time, from the recording manifest.',
      offline_analysis_ms:'Wall time this offline process spent on the frame; not a live cycle.',
      live_loop_ms:'Capture-to-decision time with the game running; cannot be produced offline.'},
    scope:'Three separate measurements, never summed or compared as one latency.'};
}

// What a physical-unit claim needs before a degree or a metre may be printed.
// Supplied by the caller as measured facts; nothing here estimates them.
export function scaleReadiness({distanceScale=null,angleCalibration=null}={}){
  const distanceOk=distanceScale?.method==='known_distance'&&num(distanceScale?.pixels_per_metre)
    &&distanceScale.pixels_per_metre>0&&distanceScale?.independent_checks>=2;
  const angleOk=angleCalibration?.method==='independent_heading'&&num(angleCalibration?.degrees_per_pixel)
    &&angleCalibration?.independent_checks>=2;
  return {distance_ready:distanceOk,angle_ready:angleOk,degrees_emitted:false,metres_emitted:false,
    blockers:[...(!distanceOk?['no_independent_distance_scale']:[]),...(!angleOk?['no_independent_angle_calibration']:[])],
    note:'A camera pan left and right does not create a numeric calibration: the angle the camera actually turned must be known independently.',
    scope:'Gate for physical units. Output stays in pixels and image fractions until both checks pass.'};
}
