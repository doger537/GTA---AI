// Reversible START-button diagnostic. No gas, brake or steering.
import {GamepadWorker} from './analog-actuator.mjs';import {connect} from '../GtaControl/bridge-client.mjs';import {writeFile,mkdir} from 'node:fs/promises';
const pid=Number(process.argv[2]);if(!Number.isInteger(pid)||pid<=0)throw Error('Explicit GTA pid required');
const c=await connect(),initial=await c.status();if(!initial.foreground||initial.busy)throw Error('Focus GTA and disable automated input');
const w=new GamepadWorker({device:'vgamepad',targetPid:pid}),root=new URL('./runs/analog/pause-probe/',import.meta.url);await mkdir(root,{recursive:true});
async function capture(name){const f=await c.frame();await writeFile(new URL(name+'.jpg',root),f.bytes);}
async function pulse(){const s=await c.status();if(!s.foreground||s.generation!==initial.generation)throw Error('External interruption');await w.call('arm');await w.call('pause_pulse');await w.call('stop');}
try{await w.ready;await capture('before');await pulse();await new Promise(r=>setTimeout(r,500));await capture('after');console.log(JSON.stringify({phase:'single_start_pulse',images:root.pathname}));}finally{await w.close();c.close();}
