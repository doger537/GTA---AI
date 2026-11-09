import {test} from 'node:test';import {strict as assert} from 'node:assert';
import {auditFrame,pathTube,summarizeAudit,HAZARD_KINDS} from '../../packages/perception/false-free-audit.mjs';

// Synthetic masks and hand points only: no GTA frame, no model output.
const W=40,H=20;
const scene=({roadAt=[],obstacleAt=[]}={})=>{
 const road=new Uint8Array(W*H),obstacle=new Uint8Array(W*H);
 for(const [x,y] of roadAt)road[Math.floor(y*H)*W+Math.floor(x*W)]=1;
 for(const [x,y] of obstacleAt)obstacle[Math.floor(y*H)*W+Math.floor(x*W)]=1;
 return {gridWidth:W,gridHeight:H,road,corridorRoad:road,corridorObstacle:obstacle};
};
const corridor={valid:true,points:[{x:.5,y:.55},{x:.5,y:.45},{x:.5,y:.35}]};
const maskOf=()=>({gridWidth:W,gridHeight:H});
const tubeOf=()=>pathTube(corridor,{mask:maskOf()});

test('a hazard labelled free by the mask is counted as false-free, on the path too',()=>{
 const p=scene({roadAt:[[.5,.5]],obstacleAt:[[.2,.5]]});
 const audit=auditFrame(p,[{x:.2,y:.5,expected:'hazard',kind:'curb'},{x:.5,y:.5,expected:'road'}],{corridor,tube:tubeOf()});
 assert.equal(audit.ok,true);
 assert.equal(audit.hazard_points,1);assert.equal(audit.false_free,0);
 // The same hazard off the path is still a false-free, but not on the path.
 const bad=auditFrame(scene({roadAt:[[.2,.5],[.5,.5]]}),[{x:.2,y:.5,expected:'hazard',kind:'curb'},{x:.5,y:.5,expected:'road'}],{corridor,tube:tubeOf()});
 assert.equal(bad.false_free,1);assert.equal(bad.false_free_on_path,0);
 const onPath=auditFrame(scene({roadAt:[[.5,.5],[.5,.4]]}),[{x:.5,y:.5,expected:'hazard',kind:'standing_car'},{x:.5,y:.4,expected:'road'}],{corridor,tube:tubeOf()});
 assert.equal(onPath.false_free,1);assert.equal(onPath.false_free_on_path,1);
});

test('the path tube is derived only from the corridor and reports image units',()=>{
 const tube=tubeOf();
 assert.equal(tube.ok,true);assert.ok(tube.cells>0);
 assert.match(tube.scope,/no perspective or metric correction/);
 assert.equal(pathTube({valid:false,reason:'no_visible_corridor'}).reason,'no_visible_corridor');
 assert.equal(pathTube(corridor,{mask:maskOf(),halfWidth:0.5}).reason,'invalid_half_width');
 assert.equal(pathTube(corridor,{mask:maskOf(),halfWidth:0}).reason,'invalid_half_width');
 const narrow=pathTube(corridor,{mask:maskOf(),halfWidth:0.03}),wide=pathTube(corridor,{mask:maskOf(),halfWidth:0.12});
 assert.ok(wide.cells>narrow.cells);
});

test('every hazard needs a known kind and an unlabelled point is never guessed',()=>{
 const p=scene({roadAt:[[.5,.5]]});
 assert.throws(()=>auditFrame(p,[{x:.5,y:.5,expected:'hazard'}]),/known kind/);
 assert.throws(()=>auditFrame(p,[{x:.5,y:.5,expected:'hazard',kind:'rock'}]),/known kind/);
 assert.throws(()=>auditFrame(p,[{x:.5,y:.5,expected:'maybe'}]),/road or hazard/);
 assert.throws(()=>auditFrame(p,[{x:1.2,y:.5,expected:'road'}]),/outside/);
 assert.equal(auditFrame(p,[]).reason,'points_required');
 for(const kind of HAZARD_KINDS)assert.equal(auditFrame(p,[{x:.5,y:.5,expected:'hazard',kind}]).ok,true);
});

test('missed road is reported separately from false-free',()=>{
 const p=scene({roadAt:[]});
 const audit=auditFrame(p,[{x:.5,y:.5,expected:'road'},{x:.6,y:.5,expected:'road'}]);
 assert.equal(audit.missed_road,2);assert.equal(audit.false_free,0);
 assert.equal(audit.road_points,2);
});

test('a single false-free on the path fails the summary; wording stays limited',()=>{
 const clean=auditFrame(scene({roadAt:[[.5,.5]]}),[{x:.5,y:.5,expected:'road'}],{corridor,tube:tubeOf()});
 const summary=summarizeAudit([clean,clean]);
 assert.equal(summary.verdict,'no_false_free_on_labelled_points');
 assert.ok(summary.limitations.some(x=>/not a pixel/.test(x)));
 const dirty=auditFrame(scene({roadAt:[[.5,.5]]}),[{x:.5,y:.5,expected:'hazard',kind:'pole'}],{corridor,tube:tubeOf()});
 const bad=summarizeAudit([clean,dirty]);
 assert.equal(bad.verdict,'false_free_found');assert.equal(bad.false_free_on_path,1);
 assert.equal(bad.by_kind.pole.false_free,1);
 const offPath=summarizeAudit([clean,dirty],{allowAnyFalseFree:true});
 assert.equal(offPath.verdict,'false_free_found');
 assert.throws(()=>summarizeAudit([]),/nonempty/);
});
