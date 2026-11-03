import {GAUGE_PROFILE} from './vehicle-state.mjs';
export function hudProfile(meta){
  if(!meta||!['full_width','full_height','left','top','width','height'].every(k=>Number.isInteger(meta[k]))||meta.full_width<10||meta.full_height<10||meta.left<0||meta.top<0||meta.width<=0||meta.height<=0||meta.left+meta.width>meta.full_width||meta.top+meta.height>meta.full_height)throw Error('Invalid native HUD geometry');
  const map=r=>{const x=Math.round(r.left*meta.full_width)-meta.left,y=Math.round(r.top*meta.full_height)-meta.top,w=Math.round(r.width*meta.full_width),h=Math.round(r.height*meta.full_height);if(x<0||y<0||x+w>meta.width||y+h>meta.height)throw Error('Gauge outside native HUD crop');return {...r,normalized:true,left:x/meta.width,top:y/meta.height,width:w/meta.width,height:h/meta.height};};
  return {speed:{...map(GAUGE_PROFILE.speed),padded_consensus:true,dash_cyan:true,single_glyph_confirmation:true},gear:{...map(GAUGE_PROFILE.gear),shape_confirmation:true}};
}
