export function excludedByCamera(x,y,profile='unknown') {
  if(x<0||x>1||y<0||y>1)return true;
  if((x<.22&&y>.78)||(x>.78&&y>.56))return true; // Minimap and speedometer.
  if(profile==='cockpit'&&(y>=.50||y<.08||x<.27))return true;
  // Conservative ego-car footprint for the tested, fixed rear-camera view.
  // A different zoom/yaw requires a different profile; this is not camera calibration.
  if(profile==='rear'&&y>=.58){
    const t=(y-.58)/.42;
    if(x>=.36-.06*t&&x<=.65+.17*t)return true;
  }
  return false;
}
