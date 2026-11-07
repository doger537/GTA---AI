// Experimental image-space follower. It does NOT claim metric clearance or
// calibrated stopping distance, nor does it implement GPS junction planning.
const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
export class VisualFollower {
  constructor({targetKmh=12}={}){this.target=Math.min(15,targetKmh);this.previous=null;this.steer=0;this.blockedUntil=-Infinity;}
  update({vision:p,speed,ageMs,timeMs,profile}){
    const stop=reason=>({throttle:0,brake:1,steer:0,state:'STOP',reason});
    if(profile!=='rear')return stop('fixed_rear_camera_required');
    if(!Number.isFinite(ageMs)||ageMs>450)return stop('stale_frame');
    if(!speed.valid||!Number.isFinite(speed.kmh))return stop('speed_unreadable');
    if(speed.kmh>20)return stop('speed_outside_trial_range');
    if(!p.semantic||p.rows.length<3||p.road_fraction<.18)return stop('road_uncertain');
    // Pixel width shrinks toward the horizon; these are image-space gates,
    // not estimates of real clearance in metres.
    const rows=p.rows.filter(r=>r.y<=.54&&r.right-r.left>=(r.y<=.48?.10:.16));
    if(rows.length<2)return stop('no_visible_corridor');
    // Stay near the current projected heading. Do not aim for the middle of
    // all road lanes, which could be an oncoming lane.
    const targets=rows.map(r=>{const margin=Math.min(.05,(r.right-r.left)*.2);return clamp(.5,r.left+margin,r.right-margin);});
    const target=targets.reduce((a,b)=>a+b,0)/targets.length;
    if(Math.abs(target-.5)>.16)return stop('large_heading_correction_required');
    const dt=this.previous?Math.max(.05,(timeMs-this.previous.timeMs)/1000):.1;
    let danger=false;
    for(const b of p.vehicles){
      const center=b.x+b.w/2;
      if(Math.abs(center-target)>.15)continue;
      if(b.y+b.h>.50 || b.w>.23)danger=true;
      const match=this.previous?.vehicles.find(o=>Math.abs(o.x+o.w/2-center)<.06);
      if(match&&b.h>match.h){const growth=(b.h-match.h)/dt;const ttc=b.h/growth;if(ttc<3)danger=true;}
    }
    this.previous={timeMs,vehicles:p.vehicles};
    if(danger)this.blockedUntil=timeMs+1000;
    if(timeMs<this.blockedUntil)return stop('possible_obstacle_or_low_ttc');
    const goal=clamp((target-.5)*2,-.3,.3);
    this.steer+=clamp(goal-this.steer,-dt*.4,dt*.4);
    const error=this.target-speed.kmh;
    return {throttle:error>1?clamp(error/8,.15,.7):0,brake:error< -2?clamp(-error/10,0,.8):0,steer:this.steer,state:'FOLLOW',target_kmh:this.target,image_target_x:target};
  }
}
