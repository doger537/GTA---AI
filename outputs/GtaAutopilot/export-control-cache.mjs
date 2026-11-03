import {readFile,writeFile,mkdir,open} from 'node:fs/promises';
import path from 'node:path';
import {controlVision} from './control-vision.mjs';
import {encodeControls} from './control-model.mjs';
const [inputRoot,profile,outputRoot]=process.argv.slice(2),root=path.resolve(inputRoot),out=path.resolve(outputRoot);
const meta=JSON.parse(await readFile(path.join(root,'dataset.json'),'utf8'));
const rows=(await readFile(path.join(root,'examples.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
if(rows.some(r=>r.source_session!==meta.source_session))throw Error('Mixed sessions');
rows.forEach(r=>encodeControls(r.targets));const vision=controlVision(profile),cache=await vision.cache(root,rows);
await mkdir(out,{recursive:true});const file=await open(path.join(out,'input.f32'),'w');
try{for(const r of rows){const data=vision.pack(r.frames.map(f=>cache.get(f)));await file.write(Buffer.from(data.buffer,data.byteOffset,data.byteLength));}}finally{await file.close();}
await writeFile(path.join(out,'cache.json'),JSON.stringify({version:1,profile,input:vision.input,traits:vision.traits,camera_profile:meta.camera_profile??'legacy_rear_unverified',source_dataset:root,source_session:meta.source_session,label_quality:meta.label_quality,shape:[rows.length,vision.input.height,vision.input.width,vision.input.channels],dtype:'little-endian-float32-NHWC',targets:rows.map(r=>r.targets),time_ms:rows.map(r=>r.time_ms)},null,2));
console.log(JSON.stringify({profile,session:meta.source_session,samples:rows.length,cache:out}));
