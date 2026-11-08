// Offline A/B replay. This tool never connects to the bridge or creates input devices.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const flags=Object.fromEntries(process.argv.slice(2).map(a=>{const p=a.indexOf('=');if(!a.startsWith('--')||p<3)throw Error('Use --name=value');return [a.slice(2,p),a.slice(p+1)];}));
if(flags['single-root']){
 await replayOne(path.resolve(flags['single-root']),flags.manifest,path.resolve(flags.out));
 process.exit(0);
}
for(const k of ['baseline','candidate','manifest','out'])if(!flags[k])throw Error('Required: --baseline=ROOT --candidate=ROOT --manifest=JSON --out=NEW_DIRECTORY');
const out=path.resolve(flags.out),roots=[flags.baseline,flags.candidate].map(r=>path.resolve(r));
if(roots[0]===roots[1])throw Error('Two distinct runtime trees required');
await mkdir(out); // Preserve earlier experiments instead of overwriting them.
const hash=b=>createHash('sha256').update(b).digest('hex');
const canonical=value=>JSON.stringify(value,(key,v)=>key==='inference_ms'?undefined:ArrayBuffer.isView(v)?{type:v.constructor.name,bytes:v.byteLength,sha256:hash(Buffer.from(v.buffer,v.byteOffset,v.byteLength))}:v);
const manifest=JSON.parse(await readFile(flags.manifest,'utf8'));
if(!Array.isArray(manifest.road)||!manifest.road.length||!Array.isArray(manifest.hud))throw Error('Manifest requires road and hud arrays');
const data={};
for(const set of ['road','hud'])data[set]=await Promise.all(manifest[set].map(async f=>{
 const bytes=await readFile(f.path);if(!/^[a-f0-9]{64}$/.test(f.sha256)||hash(bytes)!==f.sha256)throw Error('Source hash mismatch: '+f.path);
 return {...f,bytes,reference:f.baseline?JSON.parse(await readFile(f.baseline,'utf8')):null};
}));
const modules=[],runtimeFiles=['packages/perception/perception.mjs','packages/perception/semantic-road.mjs','packages/perception/vehicle-state.mjs','packages/perception/speed-reader.mjs','packages/perception/inference-session.mjs','packages/perception/inference-worker.mjs'];
const assets=['packages/perception/models/yolop-640.onnx','packages/perception/models/segformer-cityscapes.onnx','packages/perception/models/ocr/eng.traineddata','configs/gear-templates.json','configs/segformer-config.json'];
for(const root of roots){
 const snapshot=Object.fromEntries(await Promise.all([...runtimeFiles,...assets].map(async f=>[f,hash(await readFile(path.join(root,f)))])));
 const versions=Object.fromEntries(await Promise.all(['sharp','onnxruntime-node'].map(async name=>[name,JSON.parse(await readFile(path.join(root,'node_modules',name,'package.json'),'utf8')).version])));
 modules.push({root,versions,snapshot});
}
for(const f of assets)if(modules[0].snapshot[f]!==modules[1].snapshot[f])throw Error('Model/config changed: '+f);
for(const f of runtimeFiles){const a=(await readFile(path.join(roots[0],f),'utf8')).replace(/\r\n/g,'\n'),b=(await readFile(path.join(roots[1],f),'utf8')).replace(/\r\n/g,'\n');if(a!==b)throw Error('Algorithm source changed: '+f);}
await writeFile(path.join(out,'protocol.json'),JSON.stringify({registered_utc:new Date().toISOString(),scope:'Offline dependency replay in separate sequential Node processes to isolate native DLLs; no game/capture/input. Historical/development inputs, not independent driving validation. Unchanged model weights, thresholds, algorithms and DirectML options. No speed improvement claim.',acceptance:'Every road normalized input tensor, raw ONNX output, final probability/mask/scene/corridor and every complete native HUD result must match exactly. Saved road references must match. Hashes must remain unchanged.',manifest,roots:modules.map(m=>({root:m.root,versions:m.versions,snapshot:m.snapshot}))},null,2));
const rows=[],hudRows=[];let error=null;
const persist=()=>writeFile(path.join(out,'results.json'),JSON.stringify({error,road:rows,hud:hudRows},null,2));
try{
 const outputs=[];
 for(const [i,root]of roots.entries()){
  const childOut=path.join(out,'runtime-'+i+'.json');
  await new Promise((resolve,reject)=>{const child=spawn(process.execPath,[fileURLToPath(import.meta.url),'--single-root='+root,'--manifest='+path.resolve(flags.manifest),'--out='+childOut],{windowsHide:true,stdio:'inherit'});child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(Error('Replay child failed: '+code)));});
  outputs.push(JSON.parse(await readFile(childOut,'utf8')));
 }
 if(outputs.some(x=>x.road.length!==data.road.length||x.hud.length!==data.hud.length))throw Error('Incomplete replay');
 for(const [i,f]of data.road.entries()){const signatures=outputs.map(x=>x.road[i].signatures);rows.push({path:f.path,sha256:f.sha256,signatures,parity:isDeepStrictEqual(...signatures),saved_baselines:outputs.map(x=>x.road[i].baseline)});}
 for(const [i,f]of data.hud.entries()){const states=outputs.map(x=>x.hud[i].state);hudRows.push({path:f.path,sha256:f.sha256,parity:isDeepStrictEqual(...states),states});}
 for(const m of modules)for(const f of [...runtimeFiles,...assets])if(hash(await readFile(path.join(m.root,f)))!==m.snapshot[f])throw Error('Source/model changed during replay: '+f);
 for(const set of ['road','hud'])for(const f of data[set])if(hash(await readFile(f.path))!==f.sha256)throw Error('Input changed during replay: '+f.path);
 const summary={road:rows.length,road_exact:rows.filter(r=>r.parity).length,saved_reference_checks:rows.flatMap(r=>r.saved_baselines).filter(x=>x!==null).length,saved_reference_exact:rows.flatMap(r=>r.saved_baselines).filter(x=>x===true).length,hud:hudRows.length,hud_exact:hudRows.filter(r=>r.parity).length,hashes_unchanged:true};
 await writeFile(path.join(out,'summary.json'),JSON.stringify(summary,null,2));console.log(JSON.stringify(summary));
 if(rows.some(r=>!r.parity||r.saved_baselines.some(x=>x===false))||hudRows.some(r=>!r.parity))throw Error('Dependency replay acceptance failed; candidate not promoted');
}catch(e){error=e.stack;process.exitCode=1;console.error(e.message);}finally{await persist();}

async function replayOne(root,manifestFile,destination){
 const hash=b=>createHash('sha256').update(b).digest('hex');
 const canonical=value=>JSON.stringify(value,(key,v)=>key==='inference_ms'?undefined:ArrayBuffer.isView(v)?{type:v.constructor.name,bytes:v.byteLength,sha256:hash(Buffer.from(v.buffer,v.byteOffset,v.byteLength))}:v);
 const manifest=JSON.parse(await readFile(manifestFile,'utf8'));
 const [perception,vehicle,profile,geometry]=await Promise.all(['perception.mjs','vehicle-state.mjs','hud-profile.mjs','road-corridor.mjs'].map(f=>import(pathToFileURL(path.join(root,'packages/perception',f)))));
 const require=createRequire(path.join(root,'package.json')),versions={sharp:require('sharp').versions,ort:require('onnxruntime-node/package.json').version};
 const rows=[],hud=[],observed={};let failure=null,vision;
 try{
  vision=await perception.Perception.load({cameraProfile:'rear'});
  for(const [name,s]of [['yolop',vision.session],['segformer',vision.semantic.session]]){const run=s.run.bind(s);s.run=async feeds=>{const result=await run(feeds);observed[name]={feeds,result};return result;};}
  for(const [i,f]of manifest.road.entries()){
   const bytes=await readFile(f.path);if(hash(bytes)!==f.sha256)throw Error('Road source changed');
   const p=await vision.analyze(bytes),g=geometry.connectedRoadGeometry(p.semantic,'lane_follow');
   const actual={gridWidth:p.semantic.gridWidth,gridHeight:p.semantic.gridHeight,vehicles:p.vehicles,...Object.fromEntries(['rawRoad','road','obstacle','corridorRoad','corridorObstacle','labels'].map(k=>[k,[...p.semantic[k]]]))};
   const reference=f.baseline?JSON.parse(await readFile(f.baseline,'utf8')):null;
   rows.push({path:f.path,signatures:{tensor:hash(canonical(observed)),scene:hash(canonical(p)),geometry:hash(canonical(g))},baseline:reference?Object.entries(actual).every(([k,v])=>isDeepStrictEqual(v,reference[k])):null});
   if((i+1)%40===0)console.log(JSON.stringify({runtime:versions.sharp.sharp,road:i+1,total:manifest.road.length}));
  }
 }catch(e){failure=e;}
 finally{if(vision)await Promise.all([vision.session.release(),vision.semantic.session.release()]);}
 let reader,currentGeometry;
 if(!failure)try{
  for(const [i,f]of manifest.hud.entries()){
   const key=JSON.stringify(f.geometry);if(currentGeometry!==key){if(reader)await reader.close();reader=null;reader=await vehicle.VehicleStateReader.create(profile.hudProfile(f.geometry));currentGeometry=key;}
   const bytes=await readFile(f.path);if(hash(bytes)!==f.sha256)throw Error('HUD source changed');
   reader.speed.previous=null;hud.push({path:f.path,state:await reader.read(bytes,1000)});
   if((i+1)%80===0)console.log(JSON.stringify({runtime:versions.sharp.sharp,hud:i+1,total:manifest.hud.length}));
  }
 }catch(e){failure=e;}finally{if(reader)await reader.close();}
 await writeFile(destination,JSON.stringify({versions,road:rows,hud,error:failure?.stack??null},null,2),{flag:'wx'});
 if(failure)throw failure;
}
