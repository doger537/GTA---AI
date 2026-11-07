import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {connect} from './bridge-client.mjs';
async function launchBridge(){
  const exe=fileURLToPath(new URL('../../apps/gta-control/GtaControl.exe',import.meta.url));
  await new Promise((resolve,reject)=>{
    const child=spawn(exe,[],{windowsHide:true,detached:true,stdio:'ignore'});
    child.once('error',reject);child.once('spawn',()=>{child.unref();resolve();});
  });
}
const recoverable=e=>['ENOENT','ECONNREFUSED','ECONNRESET'].includes(e.code);
export async function connectRecordingBridge({connectClient=connect,launch=launchBridge,pause=ms=>new Promise(r=>setTimeout(r,ms)),attempts=30,isCancelled=()=>false,notify=console.log}={}){
  async function probe(){
    let client;
    try{
      client=await connectClient();const status=await client.status();
      if(typeof status.busy!=='boolean'||status.hold_supported!==true||!Array.isArray(status.keys))throw Error('Несовместимая версия GTA Control');
      return client;
    }catch(error){client?.close();throw error;}
  }
  if(isCancelled())throw Error('Запуск отменён');
  try{return await probe();}catch(error){if(!recoverable(error))throw error;}
  notify('Запускаю GTA Control. Дождись сигнала начала записи.');
  await launch();
  for(let i=0;i<attempts;i++){
    if(isCancelled())throw Error('Запуск отменён');
    await pause(200);
    try{return await probe();}catch(error){if(!recoverable(error))throw error;}
  }
  throw Error('Не удалось подключиться к GTA Control после запуска. Запись не началась.');
}
