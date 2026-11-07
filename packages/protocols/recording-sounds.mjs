import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

export const CUES={
  start:[[650,140],[950,180]],
  complete:[[880,180],[1100,180],[1320,180],[0,150],[1320,450]],
  interrupted:[[330,240],[0,100],[260,240],[0,100],[200,350]],
};

// PCM WAV with short fades to avoid clicks, played through the Windows audio
// mixer. This does not use the console/PC speaker or change volume settings.
export function cueWave(notes){
  const rate=22050,samples=[];
  for(const [frequency,ms] of notes){
    const n=Math.round(rate*ms/1000),fade=Math.round(rate*.01);
    for(let i=0;i<n;i++)samples.push(Math.round(8000*Math.sin(2*Math.PI*frequency*i/rate)*Math.min(1,i/fade,(n-1-i)/fade)));
    for(let i=0;i<Math.round(rate*.06);i++)samples.push(0);
  }
  const data=Buffer.alloc(44+samples.length*2);
  data.write('RIFF',0);data.writeUInt32LE(data.length-8,4);data.write('WAVEfmt ',8);data.writeUInt32LE(16,16);data.writeUInt16LE(1,20);data.writeUInt16LE(1,22);data.writeUInt32LE(rate,24);data.writeUInt32LE(rate*2,28);data.writeUInt16LE(2,32);data.writeUInt16LE(16,34);data.write('data',36);data.writeUInt32LE(samples.length*2,40);
  samples.forEach((v,i)=>data.writeInt16LE(v,44+i*2));return data;
}

export async function playRecordingSound(kind){
  if(!Object.hasOwn(CUES,kind))throw Error('Unknown recording cue');
  try{
    if(process.platform!=='win32')throw Error('Windows audio required');
    const file=fileURLToPath(new URL(`../../configs/sounds/recording-${kind}.wav`,import.meta.url));
    await new Promise((resolve,reject)=>{
      const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-Command','$ErrorActionPreference="Stop"; $sound=New-Object System.Media.SoundPlayer; $sound.SoundLocation=$env:GTA_RECORDING_CUE; $sound.PlaySync()'],{windowsHide:true,stdio:'ignore',timeout:8000,env:{...process.env,GTA_RECORDING_CUE:file}});
      child.once('error',reject);child.once('close',code=>code===0?resolve():reject(Error(`Audio process exited ${code}`)));
    });return true;
  }catch(error){console.warn(`Recording sound unavailable: ${error.message}`);process.stdout.write('\x07');return false;}
}
