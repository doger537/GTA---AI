import {readFile,writeFile} from 'node:fs/promises';
import {Perception} from './perception.mjs';
const [input,output='perception.jpg']=process.argv.slice(2);
if(!input)throw Error('Usage: node inspect.mjs input.jpg output.jpg');
const model=await Perception.load(),bytes=await readFile(input);
await model.analyze(bytes); // warm-up
const p=await model.analyze(bytes);
await writeFile(output,await model.overlay(bytes,p));
console.log(JSON.stringify({...p,mask:undefined,lane:undefined,semantic:undefined}));
