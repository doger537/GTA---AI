export const RECORDING_CAMERAS=['unknown','rear','hood'];
export function recordingCrop(camera,width,height){
  if(!RECORDING_CAMERAS.includes(camera))throw Error('Camera must be unknown, rear or hood');
  const top=camera==='hood'?300/720:.20,bottom=camera==='hood'?620/720:.75;
  return {left:0,top:Math.floor(height*top),width,height:camera==='hood'?Math.floor(height*bottom)-Math.floor(height*top):Math.floor(height*.55)};
}
