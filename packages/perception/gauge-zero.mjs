import sharp from 'sharp';
export async function gaugeAtZero(bytes,c){
  if(!c)return false;
  const image=sharp(bytes),m=await image.metadata(),cx=Math.round(c.center_x*m.width),cy=Math.round(c.center_y*m.height),r=Math.round(c.radius*m.width);
  const raw=await image.extract({left:cx-r,top:cy-r,width:r*2,height:r*2}).removeAlpha().raw().toBuffer();
  let sumX=0,sumY=0,count=0;
  for(let y=0;y<r*2;y++)for(let x=0;x<r*2;x++){
    const i=(y*r*2+x)*3,R=raw[i],G=raw[i+1],B=raw[i+2],dx=x-r,dy=y-r,d=Math.hypot(dx,dy);
    if(d>r*.3&&d<r*.95&&R>165&&G<R*.65&&B>70){sumX+=dx;sumY+=dy;count++;}
  }
  if(count<8)return false;
  const angle=Math.atan2(sumY,sumX)*180/Math.PI;
  return angle>=c.angle_min&&angle<=c.angle_max;
}
