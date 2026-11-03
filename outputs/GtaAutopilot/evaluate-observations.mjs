// Offline evaluation only; labels remain manual, never generated from predictions.
import{readFile,writeFile,mkdir}from'node:fs/promises';import path from'node:path';
import{VehicleStateReader}from'./vehicle-state.mjs';import{hudProfile}from'./hud-profile.mjs';import{Perception}from'./perception.mjs';import{roadGeometry}from'./road-guidance.mjs';import{percentiles}from'./latency-trace.mjs';
const root=path.resolve(process.argv[2]??''),n=Number(process.argv.find(a=>a.startsWith('--frames='))?.split('=')[1]??40);
if(!Number.isInteger(n)||n<1||n>500)throw Error('frames must be 1..500');
const session=JSON.parse(await readFile(path.join(root,'session.json'),'utf8'));
const samples=(await readFile(path.join(root,'samples.jsonl'),'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
if(!samples.length||session.source!=='single_capture')throw Error('A nonempty single-capture session is required');
const count=Math.min(n,samples.length),selected=Array.from({length:count},(_,i)=>samples[count===1?0:Math.floor(i*(samples.length-1)/(count-1))]);
for(const r of samples)if(!/^\d{6}\.jpg$/.test(r.file)||!/^\d{6}-hud\.png$/.test(r.hud_file)||r.capture_skew_ms!==0||r.capture_start_ms>r.capture_end_ms)throw Error('Invalid capture manifest');
let annotations;try{annotations=JSON.parse(await readFile(path.join(root,'annotations.json'),'utf8'));if(annotations.session!==session.id)throw Error('Annotation session mismatch');}catch(e){if(e.code!=='ENOENT')throw e;annotations={session:session.id,rows:[]};}
const truth=new Map();for(const row of annotations.rows){if(truth.has(row.file))throw Error('Duplicate annotation');truth.set(row.file,row);}
const template={session:session.id,scope:'Manually review pixels, use null for unreadable/unlabelled speed/gear. Do not copy predictions as truth.',rows:selected.map(r=>({file:r.file,speed:null,gear:null,camera_heading:'unlabelled',road_points:[]}))};
await writeFile(path.join(root,'annotation-template.json'),JSON.stringify(template,null,2));
let reader,vision;const rows=[];
try{reader=await VehicleStateReader.create(hudProfile(selected[0].hud_geometry));vision=await Perception.load({cameraProfile:session.camera_declared});
  for(const r of selected){if(JSON.stringify(r.hud_geometry)!==JSON.stringify(selected[0].hud_geometry))throw Error('Geometry changed within recording');
    const [image,hud]=await Promise.all([readFile(path.join(root,r.file)),readFile(path.join(root,r.hud_file))]),start=performance.now();
    const [state,p]=await Promise.all([reader.read(hud,r.capture_start_ms),vision.analyze(image)]),geometry=roadGeometry(p.semantic,'lane_follow'),label=truth.get(r.file)??null;
    const points=(label?.road_points??[]).map(point=>{
      if(![point.x,point.y].every(v=>Number.isFinite(v)&&v>=0&&v<1)||typeof point.road!=='boolean')throw Error('Invalid point annotation');
      const i=Math.floor(point.y*p.semantic.gridHeight)*p.semantic.gridWidth+Math.floor(point.x*p.semantic.gridWidth);
      return {...point,predicted_road:!!p.semantic.road[i],semantic_obstacle:!!p.semantic.obstacle[i],vehicle_box:p.vehicles.some(b=>point.x>=b.x&&point.x<=b.x+b.w&&point.y>=b.y&&point.y<=b.y+b.h)};
    });rows.push({file:r.file,time_ms:r.capture_start_ms,state,geometry,vehicles:p.vehicles,camera_heading_prediction:'unknown',camera_heading_verified:false,label,points,analysis_ms:performance.now()-start});
  }
}finally{if(reader)await reader.close();if(vision)await Promise.allSettled([vision.session.release(),vision.semantic.session.release()]);}
const speed=rows.filter(r=>Number.isFinite(r.label?.speed)),accepted=speed.filter(r=>r.state.speed.valid),errors=accepted.map(r=>Math.abs(r.state.speed.kmh-r.label.speed)),gears=rows.filter(r=>/^[RN1-8]$/.test(r.label?.gear??'')),points=rows.flatMap(r=>r.points);
const summary={sampled_frames:rows.length,total_recorded:samples.length,labelled_speed:speed.length,accepted_labelled_speed:accepted.length,correct_speed:accepted.filter(r=>r.state.speed.kmh===r.label.speed).length,false_zero:accepted.filter(r=>r.label.speed>0&&r.state.speed.kmh===0).length,speed_error_kmh:percentiles(errors),labelled_gear:gears.length,correct_gear:gears.filter(r=>r.state.gear.valid&&r.state.gear.value===r.label.gear).length,road_points:points.length,correct_road_points:points.filter(p=>p.road===p.predicted_road).length,false_road_points:points.filter(p=>!p.road&&p.predicted_road).length,camera_heading_estimator_implemented:false,analysis_ms:percentiles(rows.map(r=>r.analysis_ms))};
await mkdir('runs/moving-perception',{recursive:true});const report=path.resolve('runs/moving-perception/'+session.id+'.json');await writeFile(report,JSON.stringify({session:session.id,role:session.role,sampling:'Uniform chronological positions over the full recording, declared before evaluation',scope:'Offline sampled observations. Missing labels do not count as success. Heading remains unknown; camera is only operator-declared. No driving.',game_input_sent:false,summary,rows},null,2));console.log(JSON.stringify({report,summary},null,2));
