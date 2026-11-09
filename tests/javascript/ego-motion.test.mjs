import {test} from 'node:test';import {strict as assert} from 'node:assert';
import {roadRowProfile,estimateShift,corridorDrift,classifyMotionSource} from '../../packages/perception/ego-motion.mjs';

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
