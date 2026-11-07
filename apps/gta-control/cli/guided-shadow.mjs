import * as ort from 'onnxruntime-node';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import sharp from 'sharp';
import {SemanticRoad} from '../../../packages/perception/semantic-road.mjs';
import {VehicleStateReader,GAUGE_PROFILE} from '../../../packages/perception/vehicle-state.mjs';
import {INTENTS,navigationAtFrame} from '../../../packages/navigation/navigation-context.mjs';
import {roadGeometry,steeringFeatures,guidanceGate} from '../../../packages/navigation/road-guidance.mjs';
const image=path.resolve(process.argv[2]??''),intent=process.argv.find(a=>a.startsWith('--intent='))?.split('=')[1]??'unknown';
if(intent!=='unknown'&&!INTENTS.includes(intent))throw Error('Unknown direction command');
const bytes=await readFile(image),reader=await VehicleStateReader.create({...GAUGE_PROFILE,speed:{...GAUGE_PROFILE.speed,padded_consensus:true},gear:{...GAUGE_PROFILE.gear,shape_confirmation:true}}),vision=await SemanticRoad.load({provider:'dml'});
let state,p;
try{[state,p]=await Promise.all([reader.read(bytes,0),vision.analyze(bytes,{cameraProfile:'rear'})]);}finally{await reader.close();}
// Explicit hypothetical command for this saved-frame inspection, not a label
// claiming what the human intended during the original free-driving session.
const navigation=navigationAtFrame({valid:intent!=='unknown',intent,source:'user',issued_ms:0,expires_ms:1000},0,100);
const geometry=roadGeometry(p,intent),gate=guidanceGate({navigation,state,geometry,age_ms:0});let steer=null;
if(gate.allow_shadow_proposal){const session=await ort.InferenceSession.create(fileURLToPath(new URL('../../../training/trained/geometry-guidance-v1/model.onnx',import.meta.url)),{executionProviders:['cpu'],intraOpNumThreads:2});const output=await session.run({geometry_state:new ort.Tensor('float32',Float32Array.from(steeringFeatures(geometry,state)),[1,4])});steer=Math.max(-.3,Math.min(.3,output.steer.data[0]));await session.release();}
const report={image,state,navigation,geometry,gate,proposed_steer:steer,steering_model_source:'synthetic geometric reference, not GTA driving demonstrations',driving_enabled:false,camera_calibrated:false,braking_calibrated:false,scope:'Saved-frame what-if inspection only. No keyboard inputs.'};
const root=new URL('../../../experiments/runs/guided/',import.meta.url);await mkdir(root,{recursive:true});await writeFile(new URL('latest.json',root),JSON.stringify(report,null,2));
const meta=await sharp(bytes).metadata(),points=geometry.points?.map(q=>`${q.x*meta.width},${q.y*meta.height}`).join(' ')??'';
await sharp(bytes).composite([{input:Buffer.from(`<svg width="${meta.width}" height="${meta.height}"><polyline points="${points}" fill="none" stroke="lime" stroke-width="4"/></svg>`)}]).jpeg().toFile(fileURLToPath(new URL('latest.jpg',root)));
await vision.session.release();console.log(JSON.stringify(report,null,2));
