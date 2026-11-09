export function detectZeroDash(source,width,height,{cyan=false,antialias=false}={}){
  let xmin=width,ymin=height,xmax=-1,ymax=-1,ink=0;
  for(let i=0;i<width*height;i++){
    const r=source[i*3],g=source[i*3+1],b=source[i*3+2];
    if((Math.min(r,g,b)>205&&Math.max(r,g,b)-Math.min(r,g,b)<55)||(cyan&&g>190&&b>210&&b>r*1.1&&g>r*1.05)){const x=i%width,y=Math.floor(i/width);xmin=Math.min(xmin,x);xmax=Math.max(xmax,x);ymin=Math.min(ymin,y);ymax=Math.max(ymax,y);ink++;}
  }
  const w=xmax-xmin+1,h=ymax-ymin+1;
  if(ink<4||w<4||h>Math.max(2,height*.15))return false;
  if(w>=2*h)return true;
  // A subpixel edge can leave a 5x3 bright core. Keep the old core thresholds
  // and aspect requirement; accept one extra edge column only with at least
  // two consecutive near-white pixels (not an OCR dash or a bare square dot).
  if(!antialias||w+1<2*h)return false;
  for(const x of [xmin-1,xmax+1]){
    if(x<0||x>=width)continue;let consecutive=0;
    for(let y=ymin;y<=ymax;y++){
      const i=(y*width+x)*3,r=source[i],g=source[i+1],b=source[i+2];
      consecutive=Math.min(r,g,b)>=200&&Math.max(r,g,b)-Math.min(r,g,b)<55?consecutive+1:0;
      if(consecutive>=Math.max(2,h-1))return true;
    }
  }
  return false;
}
