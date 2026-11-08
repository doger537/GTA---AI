// Frozen native HUD regression cases; offline only, no bridge or actuation.
import {readFile,writeFile} from 'node:fs/promises';import {createHash} from 'node:crypto';import path from 'node:path';import {fileURLToPath} from 'node:url';
import {VehicleStateReader} from '../../packages/perception/vehicle-state.mjs';import {hudProfile} from '../../packages/perception/hud-profile.mjs';
const root=fileURLToPath(new URL('../../fixtures/calibration-hud-20261108/',import.meta.url)),manifest=JSON.parse(await readFile(path.join(root,'labels.json'),'utf8'));
const output=process.argv.find(a=>a.startsWith('--out='))?.slice(6),rows=[];const reader=await VehicleStateReader.create(hudProfile(manifest.geometry));
try{for(const item of manifest.cases){
 if(path.basename(item.file)!==item.file||!Number.isFinite(item.speed_kmh)||!/^[R1-8]$/.test(item.gear))throw Error('Invalid calibration HUD case');
 const bytes=await readFile(path.join(root,item.file));if(createHash('sha256').update(bytes).digest('hex')!==item.sha256)throw Error('Calibration HUD fixture changed');
 reader.speed.previous=null;const state=await reader.read(bytes,item.capture_start_ms);
 rows.push({id:item.id,expected:{speed_kmh:item.speed_kmh,gear:item.gear},actual:state,speed_exact:state.speed.valid&&state.speed.kmh===item.speed_kmh,gear_exact:state.gear.valid&&state.gear.value===item.gear});
}}finally{await reader.close();}
const summary={cases:rows.length,speed_exact:rows.filter(r=>r.speed_exact).length,gear_exact:rows.filter(r=>r.gear_exact).length,false_stops:rows.filter(r=>r.expected.speed_kmh>1&&r.actual.speed.valid&&r.actual.speed.kmh<=1).length};
const report={scope:manifest.scope,game_input_sent:false,calibration_verified:false,summary,rows};
if(output)await writeFile(path.resolve(output),JSON.stringify(report,null,2),{flag:'wx'});
console.log(JSON.stringify(summary));if(process.argv.includes('--strict')&&rows.some(r=>!r.speed_exact||!r.gear_exact))process.exitCode=1;
