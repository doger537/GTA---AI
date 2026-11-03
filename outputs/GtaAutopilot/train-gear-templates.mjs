import {readFile,writeFile} from 'node:fs/promises';
import {gearGlyph} from './gear-shape.mjs';import {GAUGE_PROFILE} from './vehicle-state.mjs';
const labels=JSON.parse(await readFile(new URL('./fixtures/gear-labels.json',import.meta.url))),templates=[];
for(const x of labels.rows.filter(x=>x.split==='dev')){
  const glyph=await gearGlyph(await readFile(new URL(`./recordings/${x.session}/${x.file}`,import.meta.url)),GAUGE_PROFILE.gear);
  if(glyph)templates.push({id:x.session+'/'+x.file,gear:x.gear,glyph:glyph.toString('base64')});
}
await writeFile(new URL('./models/gear-templates.json',import.meta.url),JSON.stringify({scope:'Fixed HUD, classes 1 2 3 4 R only. Templates from dev frames. Not a general gear recognizer.',templates},null,2));
console.log(JSON.stringify({templates:templates.length,classes:[...new Set(templates.map(t=>t.gear))]}));
