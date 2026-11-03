import sharp from 'sharp';
import {readFile} from 'node:fs/promises';
const c=JSON.parse(await readFile(new URL('./screen-config.json',import.meta.url),'utf8')).speed_roi;
const img=sharp(process.argv[2]),m=await img.metadata();
const roi={left:Math.round(c.left*m.width),top:Math.round(c.top*m.height),width:Math.round(c.width*m.width),height:Math.round(c.height*m.height)};
await img.extract(roi).resize({width:640,kernel:'nearest'}).png().toFile(process.argv[3]);console.log(roi);
