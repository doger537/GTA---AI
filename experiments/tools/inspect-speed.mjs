import {readFile} from 'node:fs/promises';
import {SpeedReader} from '../../packages/perception/speed-reader.mjs';
const [image,roiFile]=process.argv.slice(2);
if(!image||!roiFile)throw Error('Usage: node inspect-speed.mjs image.jpg roi.json');
const config=JSON.parse(await readFile(roiFile,'utf8'));
const reader=await SpeedReader.create(config.speed_roi??config);
try{console.log(JSON.stringify(await reader.read(await readFile(image),performance.now())));}finally{await reader.close();}
