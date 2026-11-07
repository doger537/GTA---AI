// Explicit human-reviewed annotations only; never derive intent from A/D.
import {readFile,writeFile,mkdir} from 'node:fs/promises';import path from 'node:path';
import {INTENTS} from '../../packages/navigation/navigation-context.mjs';
const root=path.resolve(process.argv[2]??''),from=Number(process.argv.find(a=>a.startsWith('--from='))?.split('=')[1]),to=Number(process.argv.find(a=>a.startsWith('--to='))?.split('=')[1]),intent=process.argv.find(a=>a.startsWith('--intent='))?.split('=')[1];
const session=JSON.parse(await readFile(path.join(root,'session.json'),'utf8'));
if(!Number.isFinite(from)||!Number.isFinite(to)||from<0||to<=from||to>session.elapsed_s||!INTENTS.includes(intent))throw Error('Provide reviewed --from=SECONDS --to=SECONDS --intent=left|straight|right|lane_follow|stop within recording duration');
const file=path.join(root,'navigation-annotations.json');let data={session:session.id,time_domain:'seconds converted to milliseconds relative to first recorded frame',intervals:[]};
try{data=JSON.parse(await readFile(file,'utf8'));await mkdir(path.join(root,'navigation-history'),{recursive:true});await writeFile(path.join(root,'navigation-history',`${Date.now()}.json`),JSON.stringify(data,null,2));}catch(e){if(e.code!=='ENOENT')throw e;}
if(data.session!==session.id)throw Error('Annotation session mismatch');
const entry={start_ms:from*1000,end_ms:to*1000,intent,source:'human_review'};
if(data.intervals.some(a=>entry.start_ms<a.end_ms&&entry.end_ms>a.start_ms))throw Error('Overlapping intent intervals rejected');
data.intervals.push(entry);data.intervals.sort((a,b)=>a.start_ms-b.start_ms);await writeFile(file,JSON.stringify(data,null,2));console.log(JSON.stringify(entry));
