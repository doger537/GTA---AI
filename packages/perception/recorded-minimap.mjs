// Decode the recorded lossless minimap, not the road JPEG. No capture or bridge.
export async function decodeMinimap(bytes){
  const {default:sharp}=await import('sharp');
  const {data,info}=await sharp(bytes).removeAlpha().greyscale().raw().toBuffer({resolveWithObject:true});
  return {width:info.width,height:info.height,data};
}

// Both offline entry points use the same encoded-image contract. Missing files
// and invalid PNGs are explicit unavailable signals; other I/O errors propagate.
export async function recordedMinimap(resolveBytes,decoder=decodeMinimap){
  if(!decoder)return {image:null,present:false,reason:'minimap_decoder_missing'};
  let bytes;
  try{bytes=await resolveBytes();}
  catch(error){if(error.code==='ENOENT')return {image:null,present:false,reason:'minimap_file_missing'};throw error;}
  try{return {image:await decoder(bytes),present:true,reason:null};}
  catch{return {image:null,present:true,reason:'minimap_decode_failed'};}
}
