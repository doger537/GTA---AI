import sharp from 'sharp';
import {writeFile} from 'node:fs/promises';
import {Perception} from '../../packages/perception/perception.mjs';
const input=process.argv[2],output=process.argv[3];
const image=await sharp(input).extract({left:360,top:65,width:880,height:270}).jpeg().toBuffer();
const model=await Perception.load();const p=await model.analyze(image);
await writeFile(output,await model.overlay(image,p));console.log(JSON.stringify({...p,mask:undefined,lane:undefined,semantic:undefined}));
