import path from 'node:path';
// Bounded independent image reads; preserve key insertion order and transform bytes.
export async function orderedFrameCache(root,examples,render){
  const cache=new Map(),prefix=path.resolve(root)+path.sep,files=[...new Set(examples.flatMap(e=>e.frames))];
  for(let start=0;start<files.length;start+=4){
    const batch=files.slice(start,start+4),paths=batch.map(file=>{const full=path.resolve(root,file);if(!full.startsWith(prefix))throw Error('Image outside dataset');return full;});
    const values=await Promise.all(paths.map(render));for(let i=0;i<batch.length;i++)cache.set(batch[i],values[i]);
  }
  return cache;
}
