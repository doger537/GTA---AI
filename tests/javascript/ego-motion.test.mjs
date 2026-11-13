import {test} from 'node:test';import {strict as assert} from 'node:assert';
import {roadRowProfile,estimateShift,corridorDrift,classifyMotionSource,minimapProfile,minimapMotion,motionSequence,latencyBreakdown,scaleReadiness} from '../../packages/perception/ego-motion.mjs';
import {decodeMinimap,recordedMinimap} from '../../packages/perception/recorded-minimap.mjs';

// Synthetic masks only: no GTA frame, no measured camera, no degrees.
const W=64,H=40;
function mask(shift=0,{band=[.42,.56],noise=0}={}){
  const road=new Uint8Array(W*H);
  for(let y=0;y<H;y++)for(let x=0;x<W;x++){
    const t=y/H;
    if(t<band[0]||t>band[1])continue;
    // A road wedge with a distinct left/right edge so a shift is observable.
    const left=18+shift,right=46+shift;
    if(x>=left&&x<right)road[y*W+x]=1;
  }
  if(noise)for(let i=0;i<noise;i++)road[(i*37)%(W*H)]=road[(i*37)%(W*H)]?0:1;
  return {gridWidth:W,gridHeight:H,road};
}

test('a shifted road mask produces a pixel shift with an explicit uncertainty',()=>{
 const a=roadRowProfile(mask(0)),b=roadRowProfile(mask(6));
 assert.equal(a.ok,true);assert.equal(a.rows>0,true);
 const s=estimateShift(a,b);
 assert.equal(s.ok,true);assert.equal(s.shift_pixels,6);
 assert.equal(s.confident,true);assert.equal(s.uncertainty_pixels<=1.5,true);
 assert.equal(s.shift_fraction,6/W);
 assert.match(s.scope,/not vehicle yaw/);
 const still=estimateShift(a,a);
 assert.equal(still.shift_pixels,0);assert.equal(still.confident,true);
});

test('a flat or broken band refuses instead of reporting zero motion',()=>{
 const empty=roadRowProfile({gridWidth:W,gridHeight:H,road:new Uint8Array(W*H)});
 assert.equal(empty.ok,false);assert.equal(empty.reason,'no_road_in_band');
 assert.equal(estimateShift(empty,empty).reason,'no_road_in_band');
 const bad=roadRowProfile({gridWidth:W,gridHeight:H,road:new Uint8Array(4)});
 assert.equal(bad.reason,'invalid_road_mask');
 assert.equal(roadRowProfile(mask(),{top:.5,bottom:.52}).reason,'invalid_band');
 // A band too thin to carry structure is refused before any shift is computed.
 const thin=roadRowProfile(mask(0),{top:.50,bottom:.515});
 assert.equal(thin.ok,false);assert.equal(thin.reason,'invalid_band');
 assert.equal(estimateShift(thin,thin).reason,'invalid_band');
});

test('an ambiguous shift is reported as uncertain, never as a command input',()=>{
 const a=roadRowProfile(mask(0));
 const shifted=estimateShift(a,roadRowProfile(mask(0)),{maxShiftPixels:0});
 assert.equal(shifted.ok,false);
 const noisy=estimateShift(a,roadRowProfile(mask(0,{noise:400})),{minScore:.99});
 assert.equal(noisy.ok,false);assert.equal(noisy.reason,'scene_has_no_usable_structure');
 const wide=estimateShift(a,roadRowProfile(mask(3)),{maxShiftPixels:40});
 assert.equal(wide.reason,'invalid_max_shift');
});

test('corridor drift is a shape feature with honest units and a residual',()=>{
 const straight={valid:true,points:[{x:.5,y:.6},{x:.5,y:.52},{x:.5,y:.42}]};
 const d=corridorDrift(straight);
 assert.equal(d.ok,true);assert.equal(Math.round(d.lateral_drift*1000)/1000,0);
 assert.match(d.honest_units,/no angle/);
 const bent={valid:true,points:[{x:.5,y:.6},{x:.56,y:.52},{x:.57,y:.47},{x:.5,y:.42}]};
 assert.ok(corridorDrift(bent).curvature_residual>0.02);
 assert.equal(corridorDrift({valid:false,reason:'no_visible_corridor'}).reason,'no_visible_corridor');
 assert.equal(corridorDrift({valid:true,points:[{x:.5,y:.6},{x:.5,y:.58}]}).reason,'corridor_too_short');
 assert.equal(corridorDrift({valid:true,points:[{x:.5,y:.6},{x:.5,y:.599},{x:.5,y:.598},{x:.5,y:.597}]}).reason,'corridor_depth_too_small');
});

test('road and map evidence produce unverified hypotheses only with confident map data',()=>{
 const road={ok:true,confident:true,shift_pixels:9};
 const still={ok:true,confident:true,shift_pixels:0};
 const mapMoved={ok:true,confident:true,axes_complete:true,fraction:.05},mapStill={ok:true,confident:true,axes_complete:true,fraction:.001};
 assert.equal(classifyMotionSource({roadShift:road,minimapMotion:mapStill}).source,'camera_motion_candidate');
 assert.equal(classifyMotionSource({roadShift:still,minimapMotion:mapMoved}).source,'vehicle_motion_candidate');
 assert.equal(classifyMotionSource({roadShift:road,minimapMotion:mapMoved}).source,'ambiguous');
 assert.equal(classifyMotionSource({roadShift:still,minimapMotion:mapStill}).source,'no_observed_image_motion');
 assert.equal(classifyMotionSource({roadShift:still,minimapMotion:mapMoved}).verified,false);
 const noMap=classifyMotionSource({roadShift:road});
 assert.equal(noMap.source,'unseparated_camera_or_vehicle');
 assert.match(noMap.note,/identical/);
 assert.equal(classifyMotionSource({}).reason,'no_motion_signal');
 assert.equal(classifyMotionSource({roadShift:{ok:true,confident:false,shift_pixels:9},minimapMotion:mapMoved}).source,'map_motion_without_road');
});

test('recorded map decoding distinguishes missing, corrupt and valid lossless pixels',async()=>{
 const {default:sharp}=await import('sharp');
 const source=minimap();
 const png=await sharp(source.data,{raw:{width:source.width,height:source.height,channels:1}}).png().toBuffer();
 const decoded=await decodeMinimap(png);
 assert.deepEqual([...decoded.data],[...source.data]);
 assert.equal((await recordedMinimap(async()=>png)).image.width,40);
 const missing=await recordedMinimap(async()=>{throw Object.assign(Error('missing'),{code:'ENOENT'});});
 assert.equal(missing.reason,'minimap_file_missing');assert.equal(missing.present,false);
 const corrupt=await recordedMinimap(async()=>Buffer.from('not PNG'));
 assert.equal(corrupt.reason,'minimap_decode_failed');assert.equal(corrupt.present,true);
 await assert.rejects(recordedMinimap(async()=>{throw Object.assign(Error('denied'),{code:'EACCES'});}),/denied/);
});

test('missing motion values and invalid thresholds never establish stationarity',()=>{
 assert.equal(classifyMotionSource({roadShift:{ok:true,confident:true},minimapMotion:{ok:true,fraction:0}}).source,'unknown');
 assert.equal(classifyMotionSource({thresholds:{road_pixels:NaN}}).source,'unknown');
 assert.equal(corridorDrift({valid:true,points:[{x:.5,y:.6},{x:.5,y:.5},{x:.5,y:.4}]},{minPoints:4}).ok,false);
});

// A minimap with one bright vertical line so a movement is visible and a still
// map really is still; flat images must refuse instead of reporting zero.
function minimap(shift=0,{w=40,h=20,dy=0}={}){
  const data=new Uint8Array(w*h);
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){const xx=((x-shift)%w+w)%w;data[y*w+x]=xx>=12&&xx<18&&y>=6+dy&&y<11+dy?200:20;}
  return {width:w,height:h,data};
}

test('inter-frame shift is measured over a sequence, never on a single frame',()=>{
 const frames=[{file:'a',semantic:mask(0),minimap:minimap(0)},{file:'b',semantic:mask(2),minimap:minimap(2)},{file:'c',semantic:mask(2),minimap:minimap(2)}];
 const seq=motionSequence(frames);
 assert.equal(seq.ok,true);
 assert.equal(seq.rows.length,3);
 // The first frame has no neighbour: that is a refusal, not zero motion.
 assert.equal(seq.rows[0].source.source,'first_frame');
 assert.equal(seq.rows[0].source.reason,'no_neighbour');
 assert.equal(seq.rows[1].minimap_motion.ok,true);
 assert.ok(Math.abs(seq.rows[1].minimap_motion.fraction-.05)<.01);
 // The last step moved nothing (road and map both steady), so it is stationary.
 assert.equal(seq.rows[2].source.source,'no_observed_image_motion');
 assert.equal(seq.sources.no_observed_image_motion,1);
 assert.equal(seq.gap_frames,null); // No source indices or declared gap.
 assert.equal(motionSequence([]).reason,'frames_required');
 assert.equal(motionSequence(frames,{gapFrames:0}).reason,'invalid_gap_frames');
 assert.equal(motionSequence(frames,{gapFrames:7}).gap_frames,7);
});

test('a flat minimap refuses instead of reporting a zero movement',()=>{
 assert.equal(minimapProfile({width:10,height:10,data:new Uint8Array(100)}).reason,'no_minimap_structure');
 assert.equal(minimapProfile({width:4,height:4}).reason,'invalid_minimap_image');
 assert.equal(minimapProfile(minimap(),{top:.5,bottom:.51}).reason,'invalid_band');
 const moved=minimapMotion(minimapProfile(minimap(0)),minimapProfile(minimap(3)));
 assert.equal(moved.space,'map_pixels');
 assert.match(moved.honest_units,/not metres/);
});

test('three clocks stay three measurements',()=>{
 const l=latencyBreakdown({recordedAgeMs:[100,300,200],offlineAnalysisMs:[40,60],liveLoopMs:[]});
 assert.equal(l.recorded_age_ms.count,3);
 assert.equal(l.recorded_age_ms.p50,200);
 assert.equal(l.offline_analysis_ms.count,2);
 // A live loop cannot be produced offline; it is absent, not zero.
 assert.equal(l.live_loop_ms,null);
 assert.match(l.scope,/never summed/);
 assert.equal(latencyBreakdown({offlineAnalysisMs:[-1,NaN,2,4]}).offline_analysis_ms.p50,2);
});

test('degrees and metres stay blocked until an independent scale exists',()=>{
 const none=scaleReadiness();
 assert.equal(none.distance_ready,false);
 assert.equal(none.degrees_emitted,false);
 assert.deepEqual(none.blockers,['no_independent_distance_scale','no_independent_angle_calibration']);
 // A camera pan alone is not a calibration.
 const panOnly=scaleReadiness({distanceScale:{method:'camera_pan',pixels_per_metre:10,independent_checks:5}});
 assert.equal(panOnly.distance_ready,false);
 // One check is not enough to call a scale independent.
 const oneCheck=scaleReadiness({distanceScale:{method:'known_distance',pixels_per_metre:10,independent_checks:1}});
 assert.equal(oneCheck.distance_ready,false);
 const both=scaleReadiness({distanceScale:{method:'known_distance',pixels_per_metre:10,independent_checks:2},
   angleCalibration:{method:'independent_heading',degrees_per_pixel:.1,independent_checks:2}});
 assert.equal(both.distance_ready,true);
 assert.equal(both.degrees_emitted,false);
 assert.deepEqual(both.blockers,[]);
 assert.equal(both.physical_units_allowed,false);
 assert.equal(both.verification,'caller_declarations_only');
 for(const count of [Infinity,2.5,'2'])assert.equal(scaleReadiness({distanceScale:{method:'known_distance',pixels_per_metre:10,independent_checks:count}}).distance_ready,false);
 for(const scale of [0,-1,Infinity])assert.equal(scaleReadiness({angleCalibration:{method:'independent_heading',degrees_per_pixel:scale,independent_checks:2}}).angle_ready,false);
});

test('map displacement handles leftward and vertical movement without inventing a vehicle measurement',()=>{
 const a=minimapProfile(minimap());
 const left=minimapMotion(a,minimapProfile(minimap(-2)));
 assert.equal(left.ok,true);assert.ok(left.fraction>0);
 assert.equal(left.signed_fraction.x,-.05);
 const down=minimapMotion(a,minimapProfile(minimap(0,{dy:2})));
 assert.equal(down.ok,true);assert.equal(down.signed_fraction.y,.1);
 const road={ok:true,confident:true,shift_pixels:0};
 assert.equal(classifyMotionSource({roadShift:road,minimapMotion:down}).source,'vehicle_motion_candidate');
 assert.equal(classifyMotionSource({roadShift:road,minimapMotion:{...down,confident:false}}).minimap_ok,false);
 const stripe=minimap();for(let y=0;y<stripe.height;y++)stripe.data.copyWithin(y*stripe.width,8*stripe.width,9*stripe.width);
 const horizontalOnly=minimapMotion(minimapProfile(stripe),minimapProfile(stripe));
 assert.equal(horizontalOnly.axes_complete,false);
 assert.equal(classifyMotionSource({roadShift:road,minimapMotion:horizontalOnly}).reason,'minimap_axis_unobserved');
});

test('missing frames break both comparisons and actual source indices determine each gap',()=>{
 const frames=[{source_index:0,semantic:mask(),minimap:minimap()},
   {source_index:4,semantic:null,minimap:null},
   {source_index:9,semantic:mask(3),minimap:minimap(2)},
   {source_index:10,semantic:mask(3),minimap:minimap(2)}];
 const seq=motionSequence(frames);
 assert.deepEqual(seq.rows.map(r=>r.gap_frames),[null,4,5,1]);
 assert.equal(seq.gap_frames,null);assert.deepEqual(seq.gap_range,{min:1,max:5,unknown:0});
 assert.equal(seq.rows[2].road_shift.ok,false);assert.equal(seq.rows[2].minimap_motion.ok,false);
 assert.equal(seq.shift_pixels.count,1);
 assert.equal(seq.rows[3].source.source,'no_observed_image_motion');
 for(const bad of [{source_index:0},{generation:2},{capture_start_ms:99},{sequence:1}]){
   const a={source_index:0,generation:1,sequence:1,capture_start_ms:100,semantic:mask(),minimap:minimap()};
   const b={...a,source_index:1,capture_start_ms:200,sequence:2,...bad};
   const row=motionSequence([a,b]).rows[1];
   assert.equal(row.source.source,'unknown');assert.equal(row.road_shift,null);assert.equal(row.minimap_motion,null);
 }
});
