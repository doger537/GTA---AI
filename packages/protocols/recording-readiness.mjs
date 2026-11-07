// Read-only startup gate; never changes focus or sends input.
export function recordingReadiness(status,generation){
  if(status.generation!==generation)throw Error(`Control generation changed (${generation} -> ${status.generation})`);
  if(status.busy||status.input_owner)throw Error('Automated input is active');
  return status.target_found&&status.foreground;
}
export async function waitRecordingFocus(client,generation,{timeoutMs=60000,stableMs=400,cancelled=()=>false,clock=()=>performance.now(),sleep=ms=>new Promise(r=>setTimeout(r,ms))}={}){
  const start=clock();let since=null;
  while(!cancelled()){
    const ready=recordingReadiness(await client.status(),generation),now=clock();
    since=ready?(since??now):null;if(since!==null&&now-since>=stableMs)return;
    if(now-start>=timeoutMs)throw Error('Waiting for stable GTA focus timed out');await sleep(100);
  }
  throw Error('Cancelled before recording');
}
