import {mkdir,writeFile,open} from 'node:fs/promises';
import {connectRecordingBridge} from './recording-bridge.mjs';
import {playRecordingSound} from './recording-sounds.mjs';
import {RECORDING_CAMERAS} from './recording-camera.mjs';
const camera=process.argv.find(x=>x.startsWith('--camera='))?.split('=')[1]??'unknown';
if(!RECORDING_CAMERAS.includes(camera))throw Error('Camera must be unknown, rear or hood');
const seconds=Number(process.argv.find(x=>x.startsWith('--seconds='))?.split('=')[1]??120);
if(!Number.isFinite(seconds)||seconds<1||seconds>3600)throw Error('Duration must be 1..3600 seconds');
const id=new Date().toISOString().replace(/[:.]/g,'-'),root=new URL(`./recordings/${id}/`,import.meta.url);
let client,cancelled=false,count=0,ambiguous=0,reason='duration',last=-1,started=null,log,eventLog,inputSession,eventCursor=0;
let startCue=Promise.resolve();
async function collectEvents(finish=false){
  const batch=await client.recordingEvents(inputSession.session,eventCursor,finish);
  for(const event of batch.events){if(event.sequence!==eventCursor+1)throw Error('Missing keyboard event');await eventLog.write(JSON.stringify(event)+'\n');eventCursor=event.sequence;}
  await writeFile(new URL('input-state.json',root),JSON.stringify({...batch,events:undefined},null,2));return batch;
}
process.on('SIGINT',()=>{cancelled=true;});
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
console.log('Переключись в GTA в течение минуты. После сигнала старта води до мелодии завершения. F8 или Ctrl+C — остановить.');
if(camera==='hood')console.log('Перед стартом вручную включи вид с капота и сохраняй его всю запись. Автоматической проверки ракурса нет.');
try{
  await mkdir(root,{recursive:true});
  await writeFile(new URL('session.json',root),JSON.stringify({version:1,id,status:'waiting_for_gta',samples:0},null,2));
  client=await connectRecordingBridge({isCancelled:()=>cancelled});
  console.log('GTA Control подключён. Ожидаю активное окно игры.');
  const wait=performance.now();
  while(!cancelled){const s=await client.status();if(s.busy)throw Error('Disable automated control first');if(s.target_found&&s.foreground)break;if(performance.now()-wait>60000)throw Error(s.target_found?'GTA focus timeout':'GTA not selected in GTA Control: click Refresh');await sleep(200);}
  if(cancelled)throw Error('Cancelled before recording');
  inputSession=await client.startRecording();
  await writeFile(new URL('input-session.json',root),JSON.stringify(inputSession,null,2));
  eventLog=await open(new URL('events.jsonl',root),'wx');
  log=await open(new URL('samples.jsonl',root),'wx');started=performance.now();
  console.log('ИДЁТ ЗАПИСЬ — '+seconds+' секунд. Оставайся в GTA до мелодии завершения.');
  startCue=playRecordingSound('start');
  while(!cancelled&&performance.now()-started<seconds*1000){
    const tick=performance.now(),s=await client.status();if(!s.foreground||s.busy){reason='focus_lost_or_automation_active';break;}
    const f=await client.frame();if(f.sequence===last){await sleep(10);continue;}last=f.sequence;
    const input=await collectEvents();if(!input.active){reason=input.end_reason??'input_recording_stopped';break;}
    if(f.capture_start_ms<inputSession.started_ms)continue;
    if(!f.keys_before||!f.keys_after||!Number.isFinite(f.capture_start_ms))throw Error('Updated GTA Control required');
    if([...f.keys_before,...f.keys_after].includes('f8')){reason='f8';break;}
    const stable=JSON.stringify(f.keys_before)===JSON.stringify(f.keys_after),file=`${String(count).padStart(6,'0')}.jpg`;
    await writeFile(new URL(file,root),f.bytes);
    await log.write(JSON.stringify({file,sequence:f.sequence,capture_start_ms:f.capture_start_ms,capture_end_ms:f.capture_end_ms,keys_before:f.keys_before,keys_after:f.keys_after,label_stable:stable,navigation:f.navigation})+'\n');
    if(!stable)ambiguous++;count++;await sleep(Math.max(0,100-(performance.now()-tick)));
  }
  if(cancelled)reason='ctrl_c';
}catch(error){reason=String(error.message??error);process.exitCode=1;}
finally{
  if(inputSession){try{if(eventLog)await collectEvents(true);else await client.recordingEvents(inputSession.session,0,true);}catch(error){reason+='; event_flush_failed: '+String(error.message??error);process.exitCode=1;}}
  if(eventLog)await eventLog.close();
  if(log)await log.close();const elapsed=started===null?0:(performance.now()-started)/1000;
  await writeFile(new URL('session.json',root),JSON.stringify({version:2,id,camera_profile:camera,camera_verification:'user_declared_not_automatically_verified',status:count>0?'recorded':'no_frames',samples:count,ambiguous,keyboard_events:eventCursor,elapsed_s:elapsed,actual_fps:elapsed?count/elapsed:0,reason,scope:'Manual GTA driving; OS keyboard events on bridge monotonic timeline, initial state and capture intervals. Hook delivery and focus boundaries still require validation.'},null,2));
  client?.close();console.log(JSON.stringify({folder:root.pathname,samples:count,ambiguous,reason}));
  const complete=reason==='duration'&&count>0&&elapsed>=seconds;
  console.log(complete?'ЗАПИСЬ ЗАВЕРШЕНА И СОХРАНЕНА — можно вернуться в чат.':'ЗАПИСЬ ПРЕРВАНА — проверь причину выше. Сохранено кадров: '+count);
  await startCue;await playRecordingSound(complete?'complete':'interrupted');
}
