// Same arithmetic/order as the original RGB -> ImageNet NCHW loop.
export function imageNetTensor(raw,pixels){
  const tensor=new Float32Array(3*pixels);
  for(let i=0;i<pixels;i++){const p=i*3;tensor[i]=(raw[p]/255-.485)/.229;tensor[pixels+i]=(raw[p+1]/255-.456)/.224;tensor[2*pixels+i]=(raw[p+2]/255-.406)/.225;}
  return tensor;
}
