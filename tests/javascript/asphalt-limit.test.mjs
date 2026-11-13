import {test} from 'node:test';import {strict as assert} from 'node:assert';
import {mkdtemp,writeFile,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';import path from 'node:path';
import {ascentProfile,edgeXAt,rowsAvailable,classifyReach,groundDistance,cameraCalibration,reachScope,ROW_GEOMETRY} from '../../packages/perception/asphalt-limit.mjs';
import {emptyEdgeFile,validateEdgeFile,maskRowsToEdge,edgeReport,plannerRows} from '../../experiments/tools/audit-asphalt-edge.mjs';


// A calibration is verified only against measured distances. These two references
// are stated as observations; the test checks that the model agrees with them.
const REF_A={name:'kerb-marker',imageY:.80,observedM:7.31,independent:true};
const REF_B={name:'junction-post',imageY:.98,observedM:4.11,independent:true};
const verifiedCalibration=(overrides={})=>cameraCalibration({heightM:1.2,pitchDeg:-3,verticalFovDeg:40,
  imageHeightPx:668,source:'measured',references:[REF_A,REF_B],...overrides});

// A straight image-space edge, bottom of the frame upwards. No GTA frame here.
const edge=[[.52,.58],[.50,.52],[.49,.46],[.50,.40]];

test('a marked edge must ascend, and a reversed or duplicated node is refused',()=>{
 const p=ascentProfile(edge);
 assert.equal(p.ok,true);
 assert.equal(p.near.y,.58);
 assert.equal(p.far.y,.40);
 assert.equal(ascentProfile([[.5,.5],[.5,.6]]).reason,'edge_must_ascend');
 assert.equal(ascentProfile([[.5,.5],[.5,.5]]).reason,'edge_must_ascend');
 assert.equal(ascentProfile([[.5,.5],[1.2,.4]]).reason,'point_outside_image_at_1');
 assert.equal(ascentProfile([[.5,.5]]).reason,'polyline_too_short');
 assert.equal(ascentProfile([[.5,.5],['.4',.4]]).reason,'invalid_point_at_1');
});

test('the marked edge is interpolated at a row height, not snapped to a node',()=>{
 const p=ascentProfile(edge);
 // Halfway between y=.52 (.50) and y=.46 (.49) the edge must be .495.
 assert.ok(Math.abs(edgeXAt(p,.49)-.495)<1e-9);
 // Outside the marked span the edge is held, never extrapolated.
 assert.equal(edgeXAt(p,.70),.52);
 assert.equal(edgeXAt(p,.20),.50);
 assert.equal(edgeXAt({ok:false},.5),null);
});

test('rows available come from the perspective, and are refused above the mark',()=>{
 const p=ascentProfile(edge);
 const rows=rowsAvailable({profile:p,gridHeight:128,seedY:.54});
 assert.equal(rows.ok,true);
 // .54 -> .40 over 128 rows.
 assert.ok(Math.abs(rows.rows_from_seed-17.92)<1e-6);
 assert.ok(Math.abs(rows.visible_span-.18)<1e-9);
 // A seed below the marked edge cannot be measured against it.
 assert.equal(rowsAvailable({profile:p,gridHeight:128,seedY:.30}).reason,'seed_above_marked_edge');
 assert.equal(rowsAvailable({profile:p,gridHeight:4}).reason,'invalid_grid_height');
 assert.equal(rowsAvailable({profile:{ok:false,reason:'edge_must_ascend'}}).reason,'edge_must_ascend');
});

test('the first blocker separates a short view from a lost mask and a weak planner',()=>{
 const p=ascentProfile([[.5,.58],[.5,.42]]);
 // View alone allows 16 rows; mask keeps 12; planner reached 6. Required 13.
 const shortMask=classifyReach({available:rowsAvailable({profile:p,gridHeight:100,seedY:.58}),maskReachRows:12,planner:6});
 assert.equal(shortMask.view_allows_required,true);
 assert.equal(shortMask.mask_allows_required,false);
 assert.equal(shortMask.first_blocker,'mask');
 assert.equal(shortMask.verdict,'mask_limited');
 assert.equal(shortMask.eye_view_insufficient,false);
 // A view that cannot offer the rows makes perception blameless.
 const shortView=classifyReach({available:rowsAvailable({profile:ascentProfile([[.5,.58],[.5,.53]]),gridHeight:100,seedY:.58}),maskReachRows:5,planner:4});
 assert.equal(shortView.first_blocker,'view');
 assert.equal(shortView.eye_view_insufficient,true);
 assert.equal(shortView.verdict,'view_limited');
 // Nothing missing beyond the view means the frame is reachable.
 const ok=classifyReach({available:rowsAvailable({profile:p,gridHeight:100,seedY:.58}),maskReachRows:16,planner:15});
 assert.equal(ok.first_blocker,null);
 assert.equal(ok.verdict,'reachable');
 assert.equal(classifyReach({available:rowsAvailable({profile:p,gridHeight:100,seedY:.58}),maskReachRows:16,planner:15,requiredRows:0}).reason,'invalid_required_rows');
});

test('rows never become metres without a measured camera calibration',()=>{
 const none=groundDistance({y:.44});
 assert.equal(none.ok,false);
 assert.equal(none.reason,'camera_calibration_required');
 assert.equal(none.image_fraction,.44);
 assert.match(none.note,/without a verified camera calibration/);
 // Incomplete calibrations are refused field by field.
 const incomplete=cameraCalibration({heightM:1.2,source:'measured'});
 assert.equal(incomplete.ok,false);
 assert.deepEqual(incomplete.problems.sort(),['camera_pitch_required','image_height_required','vertical_fov_required']);
 assert.equal(cameraCalibration({heightM:1.2,pitchDeg:0,verticalFovDeg:40,imageHeightPx:668,source:'derived',references:[REF_A,REF_B]}).problems.includes('calibration_source_not_measured'),true);
 assert.equal(cameraCalibration({heightM:1.2,pitchDeg:95,verticalFovDeg:40,imageHeightPx:668,source:'measured',references:[REF_A,REF_B]}).problems.includes('camera_pitch_out_of_range'),true);
 assert.match(ROW_GEOMETRY,/not equidistant/);
});

test('with a calibration the ground distance increases towards the horizon and refuses above it',()=>{
 const cal=verifiedCalibration();
 assert.equal(cal.ok,true);
 assert.equal(cal.verified,true);
 assert.ok(Math.abs(cal.focal_px-917.7)<1);
 const near=groundDistance({y:.98,calibration:cal}),mid=groundDistance({y:.80,calibration:cal}),far=groundDistance({y:.60,calibration:cal});
 assert.equal(near.ok&&mid.ok&&far.ok,true);
 // Near the bumper is close, far up the frame is far away: monotonic, not linear.
 assert.ok(near.distance_m<mid.distance_m&&mid.distance_m<far.distance_m);
 assert.ok(near.distance_m>2&&near.distance_m<8);
 // 59 m at y=.60, not "a hundred plus": the model is checked, not guessed at.
 assert.ok(far.distance_m>50&&far.distance_m<70,`far=${far.distance_m}`);
 // The horizon for this pitch sits around y=.54; above it there is no ground point.
 const above=groundDistance({y:.44,calibration:cal});
 assert.equal(above.ok,false);
 assert.equal(above.reason,'ray_above_horizon');
 assert.equal(groundDistance({y:1.4,calibration:cal}).reason,'invalid_image_fraction');
});

test('the scope says which half of the task is done',()=>{
 const rowsOnly=reachScope({haveMarks:true,haveFrames:true});
 assert.equal(rowsOnly.rows_known,true);
 assert.equal(rowsOnly.metres_known,false);
 assert.deepEqual(rowsOnly.blockers,['no_verified_camera_calibration']);
 const nothing=reachScope({});
 assert.deepEqual(nothing.blockers,['no_frames_measured','no_asphalt_edge_marks','no_verified_camera_calibration']);
 assert.deepEqual(reachScope({haveMarks:true,haveFrames:true,calibration:verifiedCalibration()}).blockers,[]);
});

test('a template is empty, keeps the source hash and refuses unknown obstructions',()=>{
 const file=emptyEdgeFile({session:'synthetic',files:['000000.jpg','000010.jpg'],frames:[{file:'000000.jpg',sha256:'a'.repeat(64)},{file:'000010.jpg',sha256:'b'.repeat(64)}]});
 assert.equal(file.frames.length,2);
 assert.equal(file.frames.every(f=>f.edge.length===0&&f.obstruction===null),true);
 assert.equal(file.frames[0].sha256,'a'.repeat(64));
 assert.match(file.instructions.join(' '),/do not mark the mask as the road/i);
 assert.equal(validateEdgeFile(file).ok,true);
 assert.equal(validateEdgeFile(file).marked,0);
 const bad=structuredClone(file);
 bad.frames[0].edge=[[.5,.4],[.5,.5]];
 assert.match(validateEdgeFile(bad).problems.join(' '),/edge_must_ascend/);
 const wrongKind=structuredClone(file);
 wrongKind.frames[0].obstruction='puddle';
 assert.match(validateEdgeFile(wrongKind).problems.join(' '),/unknown obstruction/);
});

test('mask rows are measured along the marked edge, and a missing mask is not a zero',()=>{
 const w=128,h=128,road=new Uint8Array(w*h);
 // Road only below y=.50: above that the mask loses the surface.
 for(let y=0;y<h;y++){const yy=(y+.5)/h;if(yy>=.50)for(let x=0;x<w;x++)road[y*w+x]=1;}
 const p=ascentProfile(edge);
 const got=maskRowsToEdge({prediction:{gridWidth:w,gridHeight:h,road},profile:p});
 assert.equal(got.ok,true);
 assert.ok(got.rows>0&&got.rows<14,`rows=${got.rows}`);
 assert.equal(maskRowsToEdge({prediction:{gridWidth:2,gridHeight:2},profile:p}).reason,'no_road_mask');
 assert.equal(maskRowsToEdge({prediction:{gridWidth:w,gridHeight:h,road},profile:{ok:false}}).reason,'edge_required');
});

test('the planner row count is in rows, not in fractions',()=>{
 // Floating point: compare with a tolerance, not with the literal product.
 assert.ok(Math.abs(plannerRows({valid:true,points:[{x:.5,y:.55},{x:.5,y:.45}]})-12.8)<1e-9);
 assert.equal(plannerRows({valid:false}),null);
 assert.equal(plannerRows({valid:true,points:[{x:.5,y:.5}]}),null);
});

test('the report reuses saved predictions, skips unmarked frames and prints no metres without calibration',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'edge-'));
 try{
  const file=emptyEdgeFile({session:'synthetic',files:['000000.jpg','000010.jpg']});
  file.frames[0].edge=edge;
  file.frames[0].obstruction='curb';
  await writeFile(path.join(dir,'edges.json'),JSON.stringify(file));
  const w=128,h=128,road=new Uint8Array(w*h);
  for(let y=0;y<h;y++){const yy=(y+.5)/h;if(yy>=.50)for(let x=0;x<w;x++)road[y*w+x]=1;}
  await writeFile(path.join(dir,'000000.json'),JSON.stringify({gridWidth:w,gridHeight:h,road,
    corridor:{valid:true,points:[{x:.5,y:.56},{x:.5,y:.50}]}}));
  const report=await edgeReport({edgeFile:path.join(dir,'edges.json'),root:dir});
  assert.equal(report.summary.frames,2);
  assert.equal(report.summary.marked,1);
  assert.equal(report.summary.skipped,1);
  assert.equal(report.rows[1].skipped,'not_marked');
  assert.equal(report.summary.obstruction.curb,1);
  assert.equal(report.rows[0].prediction,'loaded');
  assert.ok(Math.abs(report.rows[0].planner_rows-7.68)<1e-9);
  assert.equal(report.rows[0].metres,null);
  assert.equal(report.scope_of_units.metres_known,false);
  assert.match(report.scope,/Not a distance/);
  // A frame without a saved prediction is reported as such, not guessed.
  assert.equal(report.rows[0].available_rows>0,true);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('the report refuses a file with no marks at all',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'edge-'));
 try{
  const file=emptyEdgeFile({files:['000000.jpg']});
  await writeFile(path.join(dir,'edges.json'),JSON.stringify(file));
  // A file with no marks is written with an explanation, not thrown away: a bare
  // zero could otherwise be read as "the view allowed nothing".
  const report=await edgeReport({edgeFile:path.join(dir,'edges.json'),root:dir});
  assert.equal(report.summary.marked,0);
  assert.equal(report.why_not_scored.reason,'no_asphalt_edge_marks');
  assert.equal(report.why_not_scored.counts.empty,1);
  assert.match(report.why_not_scored.explanation,/not labelled/);
  assert.match(report.why_not_scored.note,/says nothing about what the camera could see/);
  assert.equal(report.scope_of_units.rows_known,false);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('the report turns the marked edge into metres only with a measured calibration',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'edge-'));
 try{
  const file=emptyEdgeFile({files:['000000.jpg']});
  file.frames[0].edge=[[.5,.58],[.5,.50]];
  await writeFile(path.join(dir,'edges.json'),JSON.stringify(file));
  const report=await edgeReport({edgeFile:path.join(dir,'edges.json'),root:dir,
    calibration:{heightM:1.2,pitchDeg:-3,verticalFovDeg:40,imageHeightPx:668,source:'measured',references:[REF_A,REF_B]}});
  assert.equal(report.calibration.ok,true);
  assert.equal(report.scope_of_units.metres_known,true);
  // A seed at y=.58 with this pitch is 207 m away: the perspective is strongly
  // non-linear, which is exactly why a constant row-to-metre factor is forbidden.
  const seedMetres=report.rows[0].metres.seed;
  assert.equal(seedMetres.ok,true);
  assert.ok(seedMetres.distance_m>150&&seedMetres.distance_m<300,`seed=${seedMetres.distance_m}`);
  // The marked edge at y=.50 is above the horizon for this calibration, so it is
  // refused instead of being reported as an implausible distance.
  assert.equal(report.rows[0].metres.edge.ok,false);
  assert.equal(report.rows[0].metres.edge.reason,'ray_above_horizon');
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('a claimed calibration without independent references yields no metres',()=>{
 // Exactly the hole this test guards: numbers plus source:"measured" is a claim.
 const claim=cameraCalibration({heightM:1.2,pitchDeg:-3,verticalFovDeg:40,imageHeightPx:668,source:'measured'});
 assert.equal(claim.ok,false);
 assert.equal(claim.verified,false);
 assert.ok(claim.problems.includes('at_least_two_references_required'));
 assert.equal(groundDistance({y:.80,calibration:claim}).reason,'camera_calibration_required');
 // A hand-written object that merely says ok:true must be refused too.
 const forged={ok:true,verified:true,height_m:1.2,pitch_deg:-3,focal_px:918,image_height_px:668};
 assert.equal(groundDistance({y:.80,calibration:forged}).reason,'camera_calibration_required');
 // And a verified calibration whose references failed is not usable either.
 const failed=verifiedCalibration({references:[REF_A,REF_B],maxErrorPct:0.001});
 assert.equal(failed.ok,false);
 assert.equal(groundDistance({y:.80,calibration:failed}).reason,'camera_calibration_required');
});

test('references must disagree with the model only within tolerance and cover different rows',()=>{
 // Two references at nearly the same row are one measurement repeated.
 const sameRow=verifiedCalibration({references:[REF_A,{...REF_B,imageY:.81,observedM:7.2}]});
 assert.equal(sameRow.ok,false);
 assert.ok(sameRow.problems.includes('references_not_independent_rows'));
 // A reference whose measured distance contradicts the model fails the calibration.
 const wrong=verifiedCalibration({references:[REF_A,{...REF_B,observedM:12}]});
 assert.equal(wrong.ok,false);
 assert.ok(wrong.problems.some(p=>/camera_model_disagrees_with_measurement/.test(p)));
 // Independence has to be declared explicitly, and the report says it is only declared.
 const undeclared=verifiedCalibration({references:[{...REF_A,independent:undefined},REF_B]});
 assert.equal(undeclared.ok,false);
 assert.ok(undeclared.problems.some(p=>/independence_must_be_declared/.test(p)));
 const good=verifiedCalibration();
 assert.equal(good.ok,true);
 assert.match(good.verification.independence,/declared by the caller, not provable/);
 assert.ok(good.verification.max_error_pct<=10);
});

test('a file whose marks use another shape is diagnosed, not silently scored zero',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'edge-'));
 try{
  const base={schema_version:1,session:'s',frames:[{file:'000000.jpg',edge:[{x:.5,y:.58},{x:.5,y:.4}],obstruction:null},
    {file:'000010.jpg',edge:[.5,.58,.5,.4],obstruction:null},{file:'000020.jpg',edge:[],obstruction:null}]};
  await writeFile(path.join(dir,'edges.json'),JSON.stringify(base));
  const report=await edgeReport({edgeFile:path.join(dir,'edges.json'),root:dir});
  assert.equal(report.summary.marked,0);
  assert.equal(report.why_not_scored.counts.unexpected_shape,2);
  assert.equal(report.why_not_scored.counts.empty,1);
  assert.match(report.why_not_scored.hints[0],/\[x,y\] pairs/);
  assert.equal(report.summary.view_insufficient,null);
  assert.equal(report.rows.every(r=>r.skipped),true);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('one unreadable frame does not abort the report',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'edge-'));
 try{
  const file=emptyEdgeFile({files:['000000.jpg','000010.jpg']});
  file.frames[0].edge=[[.5,.58],[.5,.40]];
  file.frames[1].edge=[[.5,.40],[.5,.58]];
  await writeFile(path.join(dir,'edges.json'),JSON.stringify(file));
  const report=await edgeReport({edgeFile:path.join(dir,'edges.json'),root:dir});
  assert.equal(report.summary.marked,1);
  assert.equal(report.rows[1].skipped,'invalid_edge');
  assert.equal(report.rows[1].reason,'edge_must_ascend');
  assert.equal(report.summary.scored,1);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('a path planned past the marked asphalt is its own error, not a depth success',()=>{
 const available={ok:true,rows_from_seed:6.27};
 const beyond=classifyReach({available,planner:9});
 assert.equal(beyond.planned_beyond_mark,true);
 assert.ok(Math.abs(beyond.rows_beyond_mark-2.73)<1e-9);
 assert.equal(beyond.first_blocker,'beyond_mark');
 assert.equal(beyond.verdict,'planned_beyond_mark');
 // A fraction of a row is mark noise, not a claim that the mask invented road.
 const inside=classifyReach({available,planner:6.5});
 assert.equal(inside.planned_beyond_mark,false);
 assert.equal(inside.first_blocker,'view');
 // The tolerance itself must be a real number, and negative is refused.
 assert.equal(classifyReach({available,planner:9,beyondMarkToleranceRows:-1}).reason,'invalid_beyond_mark_tolerance');
 assert.equal(classifyReach({available,planner:null}).planned_beyond_mark,false);
});

test('the join uses recorded depth without re-running a model and reports skipped frames',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'join-'));
 try{
  const edges=emptyEdgeFile({files:['000000.jpg','000010.jpg','000020.jpg']});
  edges.frames[0].edge=[[.5,.543],[.5,.50],[.5,.469]];
  // A short visible span (.543 -> .50 = ~5.5 rows) against a planner depth of 9.
  edges.frames[1].edge=[[.5,.543],[.5,.50]];
  edges.frames[2].edge=[];
  await writeFile(path.join(dir,'edges.json'),JSON.stringify(edges));
  // Seed row 69 on a 128 grid, depth 5 rows, plus a frame that is not in the marks.
  await writeFile(path.join(dir,'breaks.json'),JSON.stringify({base:'abc',rows:[
    {file:'000000.jpg',seed:[64,69],depth:5,first_blocked_row:64,first_layer_short:'confidence'},
    {file:'000010.jpg',seed:[64,69],depth:9}]}));
  const {joinReach}=await import('../../experiments/tools/join-asphalt-reach.mjs');
  const report=await joinReach({edgeFile:path.join(dir,'edges.json'),depthFile:path.join(dir,'breaks.json')});
  assert.equal(report.summary.frames,3);
  assert.equal(report.summary.scored,2);
  assert.equal(report.summary.missing_depth,0);
  assert.equal(report.rows[2].skipped,'not_marked');
  // Frame 1: the view offers ~9.5 rows, the planner used 5. Required is 13, so both
  // the view and the planner fall short and the view is named first: a planner
  // cannot be blamed for rows the camera never offered.
  const first=report.rows[0];
  assert.ok(Math.abs(first.seed_y-(69.5)/128)<1e-9);
  assert.ok(Math.abs(first.available_rows-9.47)<0.01);
  assert.equal(first.reach.first_blocker,'view');
  assert.equal(first.reach.planner_allows_required,false);
  // Frame 2: the planner went past its own marked edge.
  const second=report.rows[1];
  assert.equal(second.reach.planned_beyond_mark,true);
  assert.equal(report.summary.planned_beyond_mark,1);
  assert.equal(report.depth_source.base,'abc');
  assert.match(report.depth_source.note,/does not re-infer/);
  assert.equal(report.calibration,null);
  assert.equal(report.scope_of_units.metres_known,false);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('the join refuses an unverified calibration instead of quietly printing no metres',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'join-'));
 try{
  const edges=emptyEdgeFile({files:['000000.jpg']});
  edges.frames[0].edge=[[.5,.543],[.5,.469]];
  await writeFile(path.join(dir,'edges.json'),JSON.stringify(edges));
  await writeFile(path.join(dir,'breaks.json'),JSON.stringify({rows:[{file:'000000.jpg',seed:[64,69],depth:5}]}));
  const {joinReach}=await import('../../experiments/tools/join-asphalt-reach.mjs');
  await assert.rejects(joinReach({edgeFile:path.join(dir,'edges.json'),depthFile:path.join(dir,'breaks.json'),
    calibration:{heightM:1.2,pitchDeg:-3,verticalFovDeg:40,imageHeightPx:668,source:'measured'}}),/not verified/);
 }finally{await rm(dir,{recursive:true,force:true});}
});
