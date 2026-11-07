import {test} from 'node:test';import {strict as assert} from 'node:assert';import sharp from 'sharp';
import {decodeFrame,frameImage} from '../../packages/perception/decoded-frame.mjs';import {Perception} from '../../packages/perception/perception.mjs';import {SemanticRoad} from '../../packages/perception/semantic-road.mjs';
import {createHash} from 'node:crypto';

async function capture(run,session){let tensor;session.run=async feeds=>{tensor=Object.values(feeds)[0];throw Error('captured input');};await assert.rejects(run(),/captured input/);return {dims:tensor.dims,data:tensor.data};}
function equalTensors(a,b,message){assert.deepEqual(a.dims,b.dims);const hash=t=>createHash('sha256').update(Buffer.from(t.data.buffer)).digest('hex');assert.equal(hash(a),hash(b),message);}

test('single decode preserves YOLOP and semantic tensors for patterned JPEG and alpha PNG',async()=>{
  const w=193,h=97,raw=Buffer.alloc(w*h*4);for(let i=0;i<raw.length;i++)raw[i]=(i*73+Math.floor(i/29))%256;
  for(const format of ['jpeg','png']){
    const bytes=await sharp(raw,{raw:{width:w,height:h,channels:4}})[format]().toBuffer(),original=Buffer.from(bytes),decoded=await decodeFrame(bytes);
    const ys={inputNames:['images']};
    for(const size of [640,64]){const vision=new Perception(ys,size,null,'rear');equalTensors(await capture(()=>vision.analyze(bytes),ys),await capture(()=>vision.analyze(bytes,{decodeOnce:true}),ys),format+' YOLOP '+size);}
    for(const size of [640,64]){
      let shared;const semantic={size:512,analyze:async(source,options)=>{shared=options.decodedFrame;return null;}},vision=new Perception(ys,size,semantic,'rear');
      await capture(()=>vision.analyze(bytes,{decodeOnce:true}),ys);
      assert.equal(!!shared,format==='jpeg'&&size===640,'shared decode eligibility');if(shared)assert.equal(shared.source,bytes);
    }
    if(format==='jpeg'){
      const ss={},semantic=new SemanticRoad(ss,512,{});
      for(const options of [{},{resizeMode:'aspect'},{resizeMode:'aspect',horizontalFlip:true}])equalTensors(await capture(()=>semantic.analyze(bytes,options),ss),await capture(()=>semantic.analyze(bytes,{...options,decodedFrame:decoded}),ss),format+' semantic');
    }
    assert.deepEqual(bytes,original);
  }
});

test('decoded frames cannot be reused for another source or invalid buffer geometry',async()=>{
  const bytes=await sharp({create:{width:20,height:12,channels:3,background:'red'}}).png().toBuffer(),decoded=await decodeFrame(bytes);
  assert.throws(()=>frameImage(Buffer.from(bytes),decoded),/mismatched/);
  assert.throws(()=>frameImage(bytes,{...decoded,width:21}),/Invalid/);
  assert.throws(()=>frameImage(bytes,{...decoded,channels:4}),/Invalid/);
  const vision=new Perception({},64,null,'rear');await assert.rejects(vision.analyze(bytes,{decodeOnce:'yes'}),/boolean/);
});

test('independent observations decode their own RGB without a stale-frame cache',async()=>{
  const make=color=>sharp({create:{width:10,height:10,channels:3,background:color}}).jpeg().toBuffer();
  const a=await make('red'),b=await make('blue'),da=await decodeFrame(a),db=await decodeFrame(b);
  assert.notDeepEqual(da.data,db.data);assert.notEqual(da.data,db.data);assert.equal(da.source,a);assert.equal(db.source,b);
});
