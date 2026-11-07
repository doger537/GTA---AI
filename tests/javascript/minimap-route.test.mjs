import {test} from 'node:test';import {strict as assert} from 'node:assert';import {traceMinimapRoute} from '../../packages/navigation/minimap-route.mjs';
const input=()=>({width:40,height:40,centerline:new Uint8Array(1600),anchor:{x:20.5/40,y:30.5/40},heading:{x:0,y:-1},source:{sequence:1,capture_start_ms:100,capture_end_ms:120,age_ms:100}});
const line=(p,x,y0,y1)=>{for(let y=y0;y<=y1;y++)p.centerline[y*40+x]=1;};
test('route follows the vehicle forward, preserves capture identity and never issues navigation',()=>{
 const p=input();line(p,20,5,37);const original=p.centerline.slice(),r=traceMinimapRoute(p);assert.equal(r.geometry_valid,true);assert.equal(r.points[0].y,30.5/40);assert.equal(r.points.at(-1).y,5.5/40);assert.equal(r.navigation_valid,false);assert.equal(r.intent,'unknown');assert.deepEqual(r.source,p.source);assert.notEqual(r.source,p.source);assert.deepEqual(p.centerline,original);
});
test('a connected bend traces without diagonal shortcuts; distant icons are ignored',()=>{
 const p=input();line(p,20,18,35);for(let x=20;x<=32;x++)p.centerline[18*40+x]=1;p.centerline[2*40+2]=1;
 const r=traceMinimapRoute(p);assert.equal(r.geometry_valid,true);assert.deepEqual(r.points.at(-1),{x:32.5/40,y:18.5/40});
 for(let i=1;i<r.points.length;i++){const dx=Math.abs(r.points[i].x-r.points[i-1].x),dy=Math.abs(r.points[i].y-r.points[i-1].y);assert.ok(dx<1e-9||dy<1e-9);}
});
test('branches, loops, thick lines and two equally near components remain unknown',()=>{
 const p=input();line(p,20,5,37);for(let x=15;x<=25;x++)p.centerline[15*40+x]=1;assert.equal(traceMinimapRoute(p).reason,'branch_or_thick_route_unsupported');
 const two=input();line(two,19,5,37);line(two,21,5,37);assert.equal(traceMinimapRoute(two).reason,'ambiguous_route_component');
 const thick=input();line(thick,20,5,37);line(thick,21,5,37);assert.equal(traceMinimapRoute(thick).geometry_valid,false);
 const loop=input();line(loop,18,20,35);line(loop,23,20,35);for(const y of [20,35])for(let x=18;x<=23;x++)loop.centerline[y*40+x]=1;loop.anchor={x:18.5/40,y:30.5/40};assert.equal(traceMinimapRoute(loop).reason,'route_loop_or_degenerate');
});
test('gaps, absent route, missing heading and old or invalid source do not become a turn',()=>{
 const p=input();assert.equal(traceMinimapRoute(p).reason,'route_not_connected_to_vehicle');line(p,20,5,20);assert.equal(traceMinimapRoute(p).geometry_valid,false);line(p,20,21,37);
 for(const change of [{heading:null},{source:{...p.source,age_ms:451}},{anchor:null},{centerline:Uint8Array.of(1)},{source:{...p.source,capture_end_ms:99}}]){const r=traceMinimapRoute({...p,...change});assert.equal(r.geometry_valid,false);assert.equal(r.intent,'unknown');}
 const perpendicular=traceMinimapRoute({...p,heading:{x:1,y:0}});assert.equal(perpendicular.reason,'route_direction_ambiguous');
});
