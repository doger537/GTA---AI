// Verify local assets without downloading models or starting inference/input.
import {readFile} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
const root=new URL('../../',import.meta.url);
const manifest=JSON.parse(await readFile(new URL('models-manifest.json',root),'utf8'));
const rows=[];
for(const item of manifest.artifacts){
  const hash=createHash('sha256');let bytes=0;
  try{
    for await(const chunk of createReadStream(new URL(item.path,root))){hash.update(chunk);bytes+=chunk.length;}
    rows.push({id:item.id,path:item.path,required:item.required,ok:bytes===item.bytes&&hash.digest('hex')===item.sha256});
  }catch(error){if(error.code!=='ENOENT')throw error;rows.push({id:item.id,path:item.path,required:item.required,ok:false,reason:'missing'});}
}
console.log(JSON.stringify({ok:rows.every(r=>r.ok||!r.required),artifacts:rows},null,2));
if(rows.some(r=>r.required&&!r.ok))process.exitCode=1;
