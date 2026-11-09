// Writes an empty label file for a folder or a saved recording. Nothing is
// pre-filled: every point, scene kind and yaw stays null until a human edits it.
import {readFile,writeFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import {emptyLabelFile} from '../../packages/perception/label-template.mjs';

const isMain=process.argv[1]&&path.resolve(process.argv[1])===path.resolve(new URL(import.meta.url).pathname);
if(isMain){
  const target=process.argv[2];
  if(!target)throw Error('Usage: node experiments/tools/make-label-template.mjs <recording-or-folder> [--out=labels.json] [--frames=40] [--session=ID]');
  const arg=(k,f)=>process.argv.find(a=>a.startsWith('--'+k+'='))?.split('=').slice(1).join('=')??f;
  const root=path.resolve(target);
  let files=[];
  try{
    const samples=(await readFile(path.join(root,'samples.jsonl'),'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
    const limit=Math.min(samples.length,Number(arg('frames',40)));
    if(!Number.isInteger(limit)||limit<1)throw Error('frames must be a positive integer');
    const step=(samples.length-1)/Math.max(1,limit-1);
    const picked=Array.from({length:limit},(_,i)=>samples[Math.min(samples.length-1,Math.round(i*step))]);
    files=picked.map(s=>s.file);
  }catch(error){
    if(error.code!=='ENOENT')throw error;
    files=(await readdir(root)).filter(f=>/^\d{6}\.jpg$/.test(f)).sort();
    if(!files.length)throw Error('No samples.jsonl and no 000000.jpg-style frames under '+root);
  }
  const session=arg('session',null);
  const label=emptyLabelFile({session,files});
  const out=arg('out',path.join(root,'labels.json'));
  await writeFile(out,JSON.stringify(label,null,2),{flag:'wx'}).catch(error=>{if(error.code==='EEXIST')throw Error('Refusing to overwrite an existing label file: '+out);throw error;});
  console.log(JSON.stringify({labels:out,frames:files.length,note:'Edit points/scene by hand; nothing is pre-filled.'},null,2));
}
