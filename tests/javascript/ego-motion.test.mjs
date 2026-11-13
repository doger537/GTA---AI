import {test} from 'node:test';import {strict as assert} from 'node:assert';
import {roadRowProfile,estimateShift,corridorDrift,classifyMotionSource,minimapProfile,minimapMotion,motionSequence,latencyBreakdown,scaleReadiness} from '../../packages/perception/ego-motion.mjs';

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

test('camera turn and vehicle turn stay separated only when a minimap signal exists',()=>{
 const road={ok:true,confident:true,shift_pixels:9};
 const still={ok:true,confident:true,shift_pixels:0};
 const mapMoved={ok:true,fraction:.05},mapStill={ok:true,fraction:.001};
 assert.equal(classifyMotionSource({roadShift:road,minimapMotion:mapStill}).source,'camera_only_rotation');
 assert.equal(classifyMotionSource({roadShift:still,minimapMotion:mapMoved}).source,'vehicle_motion');
 assert.equal(classifyMotionSource({roadShift:road,minimapMotion:mapMoved}).source,'ambiguous');
 assert.equal(classifyMotionSource({roadShift:still,minimapMotion:mapStill}).source,'stationary');
 const noMap=classifyMotionSource({roadShift:road});
 assert.equal(noMap.source,'unseparated_camera_or_vehicle');
 assert.match(noMap.note,/identical/);
 assert.equal(classifyMotionSource({}).reason,'no_motion_signal');
 assert.equal(classifyMotionSource({roadShift:{ok:true,confident:false,shift_pixels:9},minimapMotion:mapMoved}).source,'vehicle_motion_without_road');
});

test('missing motion values and invalid thresholds never establish stationarity',()=>{
 assert.equal(classifyMotionSource({roadShift:{ok:true,confident:true},minimapMotion:{ok:true,fraction:0}}).source,'unknown');
 assert.equal(classifyMotionSource({thresholds:{road_pixels:NaN}}).source,'unknown');
 assert.equal(corridorDrift({valid:true,points:[{x:.5,y:.6},{x:.5,y:.5},{x:.5,y:.4}]},{minPoints:4}).ok,false);
});

// A minimap with one bright vertical line so a movement is visible and a still
// map really is still; flat images must refuse instead of reporting zero.
function minimap(shift=0,{w=40,h=20}={}){
  const data=new Uint8Array(w*h);
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){const xx=((x-shift)%w+w)%w;data[y*w+x]=xx>=12&&xx<18?200:20;}
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
 assert.equal(seq.rows[2].source.source,'stationary');
 assert.equal(seq.sources.stationary,1);
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
});
