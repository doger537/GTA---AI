import {spawn} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const [train,valid,cacheRoot]=process.argv.slice(2);
if(!cacheRoot)throw Error('Usage: prepare-ablation.mjs TRAIN VALID CACHE');
const profiles=['rgb-v1','rgb-hi-v1','gray-stack-v1','gray-mask-v1','gray-contrast-v1','gray-delta-v1'];
const queue=profiles.flatMap(p=>[{p,kind:'train',data:train},{p,kind:'validation',data:valid}]);
async function worker(){while(queue.length){const job=queue.shift();await new Promise((resolve,reject)=>{const c=spawn(process.execPath,[fileURLToPath(new URL('./export-control-cache.mjs',import.meta.url)),job.data,job.p,path.join(cacheRoot,job.p,job.kind)],{stdio:'inherit',windowsHide:true});c.on('error',reject);c.on('close',n=>n===0?resolve():reject(Error(`Cache export failed ${n}`)));});}}
await Promise.all([worker(),worker()]);
