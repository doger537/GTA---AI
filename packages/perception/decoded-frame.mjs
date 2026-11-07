import sharp from 'sharp';

// Per-call only: never cache across observations or change the source timestamp.
export async function decodeFrame(bytes){
  const {data,info}=await sharp(bytes).removeAlpha().toColourspace('srgb').raw().toBuffer({resolveWithObject:true});
  if(info.channels!==3)throw Error('Expected decoded RGB frame');
  return Object.freeze({source:bytes,data,width:info.width,height:info.height,channels:3});
}

export function frameImage(bytes,decoded=null){
  if(!decoded)return sharp(bytes);
  const {data,width,height,channels}=decoded;
  if(decoded.source!==bytes||!Buffer.isBuffer(data)||!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1||channels!==3||data.length!==width*height*3)throw Error('Invalid or mismatched decoded frame');
  return sharp(data,{raw:{width,height,channels}});
}
