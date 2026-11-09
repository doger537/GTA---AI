// Offline replay of a recorded observation session using the original HUD PNG.
// No bridge, no game input; model weights and thresholds are unchanged.
import {resolve,dirname} from 'node:path';
import {readFile} from 'node:fs/promises';
import {replayObservations} from '../../packages/protocols/offline-replay.mjs';
import {VehicleStateReader} from '../../packages/perception/vehicle-state.mjs';
import {hudProfile} from '../../packages/perception/hud-profile.mjs';
import {Perception} from '../../packages/perception/perception.mjs';

const args=process.argv.slice(2),arg=(key,fallback)=>args.find(a=>a.startsWith('--'+key+'='))?.split('=').slice(1).join('=')??fallback;
const root=args.find(a=>!a.startsWith('--'));
if(!root)throw Error('Usage: node experiments/tools/replay-observations.mjs <recording-folder> [--frames=1..500] [--intent=lane_follow|straight] [--skill] [--annotations=file] [--no-overlay] [--out=report.json]');
const sampling=Number(arg('frames',40)),intent=arg('intent','lane_follow'),skill=args.includes('--skill'),overlay=!args.includes('--no-overlay');
if(!Number.isInteger(sampling)||sampling<1||sampling>500)throw Error('frames must be 1..500');
if(!['lane_follow','straight'].includes(intent))throw Error('Offline replay supports lane_follow|straight only; a turn needs resolved road branches');
const annotationsFile=arg('annotations',null);
const annotations=annotationsFile?JSON.parse(await readFile(annotationsFile,'utf8')):null;
const out=arg('out',null)??resolve(root,'replay-report.json');
const cameraProfile=arg('camera','rear');
if(!['rear','hood'].includes(cameraProfile))throw Error('camera must be rear|hood (operator-declared, not verified)');
const report=await replayObservations(root,{
  sampling,intent,annotations,overlay,output:out,
  readerFactory:meta=>VehicleStateReader.create(hudProfile(meta,{digitModel:args.includes('--digit-model')})),
  // Same loader as the live path: YOLOP vehicles + SegFormer road with occlusion.
  visionFactory:()=>Perception.load({cameraProfile}),
  skill:skill?{targetKmh:Number(arg('target-kmh',8))}:null});
console.log(JSON.stringify({report:out,summary:report.summary},null,2));
