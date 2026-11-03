import sharp from 'sharp';
import {SpeedReader} from './speed-reader.mjs';
const svg=Buffer.from('<svg width="180" height="80"><rect width="180" height="80" fill="black"/><text x="20" y="64" fill="white" font-family="Arial" font-size="64">42</text></svg>');
const image=await sharp(svg).png().toBuffer();
const reader=await SpeedReader.create({left:0,top:0,width:180,height:80});
try{const r=await reader.read(image,1000);if(!r.valid||r.kmh!==42)throw Error(JSON.stringify(r));console.log(JSON.stringify({ok:true,known_speed_ocr:r}));}finally{await reader.close();}
