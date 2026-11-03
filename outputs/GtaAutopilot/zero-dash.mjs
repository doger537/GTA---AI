export function detectZeroDash(source,width,height,{cyan=false}={}){
  let xmin=width,ymin=height,xmax=-1,ymax=-1,ink=0;
  for(let i=0;i<width*height;i++){
    const r=source[i*3],g=source[i*3+1],b=source[i*3+2];
    if((Math.min(r,g,b)>205&&Math.max(r,g,b)-Math.min(r,g,b)<55)||(cyan&&g>190&&b>210&&b>r*1.1&&g>r*1.05)){const x=i%width,y=Math.floor(i/width);xmin=Math.min(xmin,x);xmax=Math.max(xmax,x);ymin=Math.min(ymin,y);ymax=Math.max(ymax,y);ink++;}
  }
  return ink>=4 && xmax-xmin+1>=4 && ymax-ymin+1<=Math.max(2,height*.15) && xmax-xmin+1>=2*(ymax-ymin+1);
}
