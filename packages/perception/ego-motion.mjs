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

// Horizontal image shift between two profiles. Positive means the scene moved
// right in the image; its physical cause and angle are deliberately not inferred.
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

// Image evidence supports hypotheses, not verified vehicle/camera motion: map
// rotation, zoom and UI icons can change independently of the vehicle.
export function classifyMotionSource({roadShift,minimapMotion,thresholds={}}={}){
  const t={road_pixels:4,minimap_fraction:0.01,...thresholds};
  if(!num(t.road_pixels)||!num(t.minimap_fraction)||t.road_pixels<0||t.minimap_fraction<0)return {source:'unknown',reason:'invalid_motion_thresholds',verified:false,scope:EGO_SCOPE};
  if(roadShift?.ok===true&&(!num(roadShift.shift_pixels))||minimapMotion?.ok===true&&(!num(minimapMotion.fraction)||minimapMotion.fraction<0))return {source:'unknown',reason:'invalid_motion_signal',verified:false,scope:EGO_SCOPE};
  const roadOk=roadShift?.ok===true&&roadShift.confident===true;
  const mapOk=minimapMotion?.ok===true&&minimapMotion.confident===true&&num(minimapMotion.fraction);
  const roadSignificant=roadOk&&Math.abs(roadShift.shift_pixels)>t.road_pixels;
  const mapSignificant=mapOk&&Math.abs(minimapMotion.fraction)>t.minimap_fraction;
  const base={road_ok:roadOk,minimap_ok:mapOk,thresholds:t,scope:EGO_SCOPE,verified:false,
    note:'A camera turn and a vehicle turn look identical in a monocular image. Minimap displacement is additional image evidence, affected by map rotation, zoom and icons; no physical source is verified.'};
  if(!roadOk&&!mapOk)return {...base,source:'unknown',reason:'no_motion_signal'};
  if(!mapOk)return {...base,source:roadSignificant?'unseparated_camera_or_vehicle':'no_road_shift_without_minimap',
    reason:roadSignificant?'minimap_signal_missing':'minimap_signal_missing_stationary'};
  if(!roadOk)return {...base,source:mapSignificant?'map_motion_without_road':'unknown',
    reason:mapSignificant?'road_signal_missing':'road_signal_missing_stationary'};
  if(!mapSignificant&&minimapMotion.axes_complete!==true)return {...base,source:'unknown',reason:'minimap_axis_unobserved'};
  if(!roadSignificant&&!mapSignificant)return {...base,source:'no_observed_image_motion',reason:'below_thresholds'};
  if(roadSignificant&&!mapSignificant)return {...base,source:'camera_motion_candidate',reason:'road_shift_without_observed_map_shift'};
  if(!roadSignificant&&mapSignificant)return {...base,source:'vehicle_motion_candidate',reason:'map_shift_without_road_shift'};
  return {...base,source:'ambiguous',reason:'both_signals_moved'};
}

// Minimap motion: how far the map content moved between two minimap images. The
// caller passes a grayscale buffer of the recorded minimap; nothing is inferred
// from the road view. A map that did not move is reported as zero with its own
// uncertainty, never reused as "the car turned".
export function minimapProfile(image,{top=0.3,bottom=0.7}={}){
  const w=image?.width,h=image?.height,data=image?.data;
  if(!Number.isSafeInteger(w)||!Number.isSafeInteger(h)||w<8||h<8||!data||data.length!==w*h)return {ok:false,reason:'invalid_minimap_image'};
  if(!num(top)||!num(bottom)||top<0||bottom>1||bottom-top<0.05)return {ok:false,reason:'invalid_band'};
  const y0=Math.max(0,Math.floor(top*h)),y1=Math.min(h-1,Math.ceil(bottom*h));
  // Edge energy per column: map outlines and road edges move, flat map fill does not.
  const profile=new Float64Array(w),vertical=new Float64Array(h);
  for(let y=y0;y<=y1;y++)for(let x=1;x<w-1;x++){
    const i=y*w+x;
    profile[x]+=Math.abs(data[i+1]-data[i-1]);
  }
  // A horizontal profile cannot see vertical movement. Measure the second axis
  // separately; an unobservable axis must never establish a stationary map.
  const x0=Math.floor(top*w),x1=Math.min(w-1,Math.ceil(bottom*w));
  for(let y=1;y<h-1;y++)for(let x=x0;x<=x1;x++)vertical[y]+=Math.abs(data[(y+1)*w+x]-data[(y-1)*w+x]);
  let energy=0;for(const v of profile)energy+=v;for(const v of vertical)energy+=v;
  if(energy<=0)return {ok:false,reason:'no_minimap_structure'};
  for(let x=0;x<w;x++)profile[x]/=y1-y0+1;
  for(let y=0;y<h;y++)vertical[y]/=x1-x0+1;
  return {ok:true,profile,width:w,height:h,band:{top:y0/h,bottom:y1/h},rows:y1-y0+1,
    vertical:{ok:true,profile:vertical,width:h}};
}

// Map-space displacement, not metres: no map scale is measured anywhere in this
// project, so a metric claim is impossible and deliberately absent.
export function minimapMotion(previous,current,options={}){
  if(previous?.width!==current?.width||previous?.height!==current?.height)return {ok:false,reason:'minimap_geometry_changed',space:'map_pixels'};
  const x=estimateShift(previous,current,options),y=estimateShift(previous?.vertical,current?.vertical,options);
  const xOk=x.ok&&x.confident,yOk=y.ok&&y.confident;
  const fraction=xOk||yOk?Math.hypot(xOk?x.shift_fraction:0,yOk?y.shift_fraction:0):null;
  return {ok:Boolean(xOk||yOk),confident:Boolean(xOk||yOk),axes_complete:Boolean(xOk&&yOk),axes:{x,y},
    reason:xOk||yOk?null:'no_confident_minimap_axis',space:'map_pixels',fraction,
    signed_fraction:{x:xOk?x.shift_fraction:null,y:yOk?y.shift_fraction:null},
    honest_units:'fraction of each minimap dimension; lower bound when an axis is unobserved; map scale unknown, not metres'};
}

// Sequential motion over frames in recording order. Keeping it here makes the
// inter-frame shift part of the analysis instead of a separate experiment: a
// frame without a usable neighbour gets an explicit refusal, not an invented zero.
export class MotionSequence {
  constructor({band={},thresholds={},gapFrames=null}={}){
    if(gapFrames!==null&&(!Number.isSafeInteger(gapFrames)||gapFrames<1))throw Error('invalid_gap_frames');
    this.band=band;this.thresholds=thresholds;this.gapFrames=gapFrames;this.rows=[];this.previous=null;
  }
  update(frame){
    const index=this.rows.length,previous=this.previous;
    const road=roadRowProfile(frame?.semantic,this.band),map=frame?.minimap?minimapProfile(frame.minimap):{ok:false,reason:frame?.minimap_reason??'minimap_missing'};
    const hasIndex=Number.isSafeInteger(frame?.source_index)&&frame.source_index>=0;
    const indexed=hasIndex&&previous?.source_index!==null;
    const gap=previous?(indexed?frame.source_index-previous.source_index:this.gapFrames):null;
    let reason=null;
    if(previous){
      if(indexed&&gap<=0)reason='non_increasing_source_index';
      if(frame?.generation!=null&&previous.generation!=null&&frame.generation!==previous.generation)reason='generation_changed';
      if(num(frame?.capture_start_ms)&&num(previous.capture_start_ms)&&frame.capture_start_ms<=previous.capture_start_ms)reason='non_increasing_capture_time';
      if(Number.isSafeInteger(frame?.sequence)&&Number.isSafeInteger(previous.sequence)&&frame.sequence<=previous.sequence)reason='non_increasing_sequence';
    }
    const roadShift=previous&&!reason?estimateShift(previous.road,road):null;
    const mapMove=previous&&!reason?minimapMotion(previous.map,map):null;
    const row={index,file:frame?.file??null,sequence:frame?.sequence??null,
      gap_frames:reason?null:gap,gap_basis:previous?(indexed?'source_index':this.gapFrames===null?'unknown':'caller_declared'):null,
      sequence_gap:previous&&Number.isSafeInteger(frame?.sequence)&&Number.isSafeInteger(previous.sequence)?frame.sequence-previous.sequence:null,
      road_profile_ok:road.ok,road_profile_reason:road.reason??null,road_shift:roadShift,
      minimap_profile_ok:map.ok,minimap_profile_reason:map.reason??null,minimap_motion:mapMove,
      source:!previous?{source:'first_frame',reason:'no_neighbour',verified:false}:reason?{source:'unknown',reason,verified:false}:classifyMotionSource({roadShift,minimapMotion:mapMove,thresholds:this.thresholds})};
    this.rows.push(row);
    // Retain only the immediate neighbour's profiles, never full semantic masks.
    // Invalid/missing signals also replace the previous ones, breaking that pair.
    this.previous={road,map,source_index:hasIndex?frame.source_index:null,generation:frame?.generation,
      capture_start_ms:frame?.capture_start_ms,sequence:frame?.sequence};
    return row;
  }
  summary(){
    const rows=this.rows;
    if(!rows.length)return {ok:false,reason:'frames_required'};
    const shifts=rows.filter(r=>r.road_shift?.ok&&r.road_shift.confident).map(r=>r.road_shift.shift_pixels);
    const sources={},reasons={};
    for(const r of rows){const s=r.source.source;sources[s]=(sources[s]??0)+1;if(r.source.reason)reasons[r.source.reason]=(reasons[r.source.reason]??0)+1;}
    const gaps=rows.slice(1).map(r=>r.gap_frames),known=gaps.filter(num);
    return {ok:true,rows,frames:rows.length,gap_frames:gaps.length&&known.length===gaps.length&&known.every(v=>v===known[0])?known[0]:null,
    gap_range:known.length?{min:Math.min(...known),max:Math.max(...known),unknown:gaps.length-known.length}:null,
    shift_pixels:shifts.length?{count:shifts.length,min:Math.min(...shifts),max:Math.max(...shifts)}:null,
    sources,reasons,verified:false,scope:EGO_SCOPE,
    note:'Order is input order; source-index gaps are reported when known. A missing neighbour is a refusal, not zero motion. Source labels are unverified image hypotheses.'};
  }
}
export function motionSequence(frames,options={}){
  if(!Array.isArray(frames)||!frames.length)return {ok:false,reason:'frames_required'};
  if(options.gapFrames!=null&&(!Number.isSafeInteger(options.gapFrames)||options.gapFrames<1))return {ok:false,reason:'invalid_gap_frames'};
  const sequence=new MotionSequence(options);
  for(const frame of frames)sequence.update(frame);
  return sequence.summary();
}

// Latency has three different meanings and they must never be averaged into one
// number: the age of a stored frame when it was written, the time an offline
// process spends on inference, and the live capture-to-decision loop that only
// exists while the game runs. A live number cannot be produced offline.
export function latencyBreakdown({recordedAgeMs=[],offlineAnalysisMs=[],liveLoopMs=[]}={}){
  const pct=list=>{
    const v=list.filter(x=>num(x)&&x>=0).slice().sort((a,b)=>a-b);
    if(!v.length)return null;
    const at=q=>v[Math.max(0,Math.ceil(q*v.length)-1)];
    return {count:v.length,p50:at(.5),p95:at(.95),max:v.at(-1)};
  };
  return {recorded_age_ms:pct(recordedAgeMs),offline_analysis_ms:pct(offlineAnalysisMs),live_loop_ms:pct(liveLoopMs),
    meanings:{recorded_age_ms:'Recorded receipt age from the manifest; not the current age or a live loop.',
      offline_analysis_ms:'Offline wall time for input reads, OCR/vision, corridor and motion analysis; excludes report rendering/writing and live actuation.',
      live_loop_ms:'Capture-to-decision time with the game running; cannot be produced offline.'},
    scope:'Three separate measurements, never summed or compared as one latency.'};
}

// Structural checks on caller declarations. Counts do not prove independent
// measurements; this helper cannot verify or authorize physical-unit claims.
export function scaleReadiness({distanceScale=null,angleCalibration=null}={}){
  const distanceOk=distanceScale?.method==='known_distance'&&num(distanceScale?.pixels_per_metre)
    &&distanceScale.pixels_per_metre>0&&Number.isSafeInteger(distanceScale?.independent_checks)&&distanceScale.independent_checks>=2;
  const angleOk=angleCalibration?.method==='independent_heading'&&num(angleCalibration?.degrees_per_pixel)
    &&angleCalibration.degrees_per_pixel>0&&Number.isSafeInteger(angleCalibration?.independent_checks)&&angleCalibration.independent_checks>=2;
  return {distance_ready:distanceOk,angle_ready:angleOk,degrees_emitted:false,metres_emitted:false,
    blockers:[...(!distanceOk?['no_independent_distance_scale']:[]),...(!angleOk?['no_independent_angle_calibration']:[])],
    note:'A camera pan left and right does not create a numeric calibration: the angle the camera actually turned must be known independently.',
    verification:'caller_declarations_only',physical_units_allowed:false,
    scope:'Structural readiness check only, not verified calibration evidence or drive authorization. No physical units are emitted.'};
}
