import {test} from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import sharp from 'sharp';
import {detectZeroDash} from '../../packages/perception/zero-dash.mjs';import {loopSpeedGlyph,confirmLoopSpeed} from '../../packages/perception/loop-speed.mjs';import {hudProfile} from '../../packages/perception/hud-profile.mjs';
import {elevenGlyphs,confirmElevenSpeed} from '../../packages/perception/eleven-speed.mjs';
import {SpeedReader} from '../../packages/perception/speed-reader.mjs';
const manifest=JSON.parse(await readFile(new URL('../../fixtures/calibration-hud-20261108/labels.json',import.meta.url),'utf8'));
async function source(name){const image=await readFile(new URL('../../fixtures/'+(name==='nine'?'loop-speed-development':'calibration-hud-20261108')+'/'+name+'.png',import.meta.url)),meta=await sharp(image).metadata(),p=hudProfile(manifest.geometry).speed;const width=Math.round(p.width*meta.width),height=Math.round(p.height*meta.height),raw=await sharp(image).extract({left:Math.round(p.left*meta.width),top:Math.round(p.top*meta.height),width,height}).removeAlpha().raw().toBuffer();return {raw,width,height};}

test('real native six/eight/nine have the required closed loops; seven and dashes do not',async()=>{
 for(const [name,expected]of [['six','6'],['eight','8'],['nine','9'],['seven',null],['clear-zero',null],['shaded-zero',null],['reverse-zero',null]]){const {raw,width,height}=await source(name);assert.equal(loopSpeedGlyph(raw,width,height)?.text??null,expected,name);}
});

test('loop glyph check rejects blank, clipped, duplicated, open and unsupported loops',async()=>{
 const {raw,width,height}=await source('six');assert.equal(loopSpeedGlyph(Buffer.alloc(raw.length),width,height),null);assert.equal(loopSpeedGlyph(raw.subarray(3),width,height),null);
 const clipped=await sharp(raw,{raw:{width,height,channels:3}}).extract({left:33,top:5,width:11,height:24}).raw().toBuffer();assert.equal(loopSpeedGlyph(clipped,11,24),null);
 const doubled=Buffer.from(raw);for(let y=0;y<height;y++)for(let x=34;x<=42;x++)for(let c=0;c<3;c++)doubled[(y*width+x-20)*3+c]=raw[(y*width+x)*3+c];assert.equal(loopSpeedGlyph(doubled,width,height),null);
 // Symmetric 0 is unsupported. Upper loop plus right tail is 9, never 6;
 // the same upper loop with a left tail (P-like) is unsupported.
 for(const [bottom,tail,expected]of [[27,null,null],[14,39,'9'],[14,30,null]]){const b=Buffer.alloc(width*height*3);for(let y=4;y<=bottom;y++)for(let x=30;x<=39;x++)if(x===30||x===39||y===4||y===bottom)b.fill(255,(y*width+x)*3,(y*width+x+1)*3);if(tail!==null)for(let y=15;y<=27;y++)b.fill(255,(y*width+tail)*3,(y*width+tail+1)*3);assert.equal(loopSpeedGlyph(b,width,height)?.text??null,expected);}
 const open=Buffer.from(raw);for(let y=18;y<=20;y++)for(let x=34;x<=36;x++)open.fill(0,(y*width+x)*3,(y*width+x+1)*3);assert.equal(loopSpeedGlyph(open,width,height),null);
});

test('nine uses its source orientation and two confident normalized six renderings',async()=>{
 const {raw,width,height}=await source('nine'),images=[],params=[],worker={setParameters:async p=>params.push(p),recognize:async image=>{images.push(image);return {data:{text:'6',confidence:95}};}};
 const r=await confirmLoopSpeed(worker,raw,width,height,[{text:'9',confidence:90}]);assert.equal(r.valid,true);assert.equal(r.text,'9');assert.deepEqual(r.candidates.map(c=>[c.height,c.rotation,c.text]),[[80,180,'6'],[100,180,'6']]);
 for(const [i,image]of images.entries()){const m=await sharp(image).metadata(),stats=await sharp(image).stats();assert.equal(m.height,[120,140][i]);assert.ok(stats.channels.some(c=>c.min===0&&c.max===255),'rotation must preserve nonblank source ink');}
 assert.equal(params.at(-1).tessedit_pageseg_mode,'7');
 const mirrored=await sharp(raw,{raw:{width,height,channels:3}}).flop().raw().toBuffer();assert.equal(loopSpeedGlyph(mirrored,width,height),null);
 for(const outputs of [[['6',95],['6',74]],[['6',95],['9',95]],[['0',95],['0',95]],[['6',95],['6',NaN]]]){const w={setParameters:async()=>{},recognize:async()=>{const [text,confidence]=outputs.shift();return {data:{text,confidence}};}};assert.equal((await confirmLoopSpeed(w,raw,width,height)).valid,false);}
 assert.equal((await confirmLoopSpeed({recognize:()=>{throw Error('Conflicting whole reading must veto');}},raw,width,height,[{text:'6',confidence:90}])).valid,false);
});

test('loop OCR requires two confident matching views and rejects whole-string conflict',async()=>{
 const {raw,width,height}=await source('six');
 for(const outputs of [[['6',95],['6',74]],[['6',95],['8',95]]]){const params=[],worker={setParameters:async p=>params.push(p),recognize:async()=>{const [text,confidence]=outputs.shift();return {data:{text,confidence}};}};assert.equal((await confirmLoopSpeed(worker,raw,width,height)).valid,false);assert.equal(params.at(-1).tessedit_pageseg_mode,'7');assert.equal(params.at(-1).tessedit_char_whitelist,'0123456789.-');}
 assert.equal((await confirmLoopSpeed({recognize:()=>{throw Error('No OCR allowed');}},raw,width,height,[{text:'5',confidence:90}])).valid,false);
 const params=[],worker={setParameters:async p=>params.push(p),recognize:async()=>{throw Error('OCR error');}};await assert.rejects(confirmLoopSpeed(worker,raw,width,height));assert.equal(params.at(-1).tessedit_pageseg_mode,'7');
});

test('subpixel dash requires a supported bright edge, never a bare dot or one stray pixel',()=>{
 const width=32,height=23,b=Buffer.alloc(width*height*3);for(let y=8;y<=10;y++)for(let x=20;x<=24;x++)b.fill(255,(y*width+x)*3,(y*width+x+1)*3);
 assert.equal(detectZeroDash(b,width,height,{antialias:true}),false);
 b.set([203,215,220],(9*width+19)*3);assert.equal(detectZeroDash(b,width,height,{antialias:true}),false);
 b.set([203,215,220],(10*width+19)*3);assert.equal(detectZeroDash(b,width,height),false);assert.equal(detectZeroDash(b,width,height,{antialias:true}),true);
});

test('native shaded dashes recover with edge evidence and numeric glyphs never become zero',async()=>{
 for(const name of ['shaded-zero','reverse-zero']){const {raw,width,height}=await source(name);assert.equal(detectZeroDash(raw,width,height,{cyan:true}),false);assert.equal(detectZeroDash(raw,width,height,{cyan:true,antialias:true}),true);}
 for(const name of ['six','eight','seven']){const {raw,width,height}=await source(name);assert.equal(detectZeroDash(raw,width,height,{cyan:true,antialias:true}),false);}
});

async function elevenSource(){const bytes=await readFile(new URL('../../fixtures/eleven-speed/eleven.png',import.meta.url)),p=hudProfile(manifest.geometry).speed,m=await sharp(bytes).metadata(),width=Math.round(p.width*m.width),height=Math.round(p.height*m.height);return {raw:await sharp(bytes).extract({left:Math.round(p.left*m.width),top:Math.round(p.top*m.height),width,height}).removeAlpha().raw().toBuffer(),width,height};}

test('eleven requires two complete headed upright ones, never one, three, touching, clipped or shifted ink',async()=>{
 const {raw,width,height}=await elevenSource(),shape=elevenGlyphs(raw,width,height);assert.equal(shape.boxes.length,2);
 assert.equal(elevenGlyphs(Buffer.alloc(raw.length),width,height),null);assert.equal(elevenGlyphs(raw.subarray(3),width,height),null);
 const one=Buffer.from(raw),first=shape.boxes[0];for(let y=first.top;y<first.top+first.height;y++)one.fill(0,(y*width+first.left)*3,(y*width+first.left+first.width)*3);assert.equal(elevenGlyphs(one,width,height),null);
 const joined=Buffer.from(raw);joined.fill(255,(12*width+36)*3,(12*width+37)*3);assert.equal(elevenGlyphs(joined,width,height),null);
 const three=Buffer.from(raw);for(let y=0;y<height;y++)for(let x=30;x<36;x++)three.set(raw.subarray((y*width+x)*3,(y*width+x+1)*3),(y*width+x-7)*3);assert.equal(elevenGlyphs(three,width,height),null);
 const clipped=await sharp(raw,{raw:{width,height,channels:3}}).extract({left:30,top:5,width:13,height:24}).raw().toBuffer();assert.equal(elevenGlyphs(clipped,13,24),null);
 const shifted=Buffer.from(one),second=shape.boxes[1];for(let y=second.top;y<second.top+second.height;y++)shifted.fill(0,(y*width+second.left)*3,(y*width+second.left+second.width)*3);for(let y=first.top;y<first.top+first.height;y++)for(let x=0;x<first.width;x++){shifted.set(raw.subarray((y*width+first.left+x)*3,(y*width+first.left+x+1)*3),(y*width+first.left+x)*3);shifted.set(raw.subarray((y*width+second.left+x)*3,(y*width+second.left+x+1)*3),((y+3)*width+second.left+x)*3);}assert.equal(elevenGlyphs(shifted,width,height),null);
 const bars=Buffer.alloc(raw.length);for(const x of [30,37])for(let y=5;y<29;y++)bars.fill(255,(y*width+x)*3,(y*width+x+3)*3);assert.equal(elevenGlyphs(bars,width,height),null);
 for(const name of ['six','eight','nine','seven','clear-zero']){const s=await source(name);assert.equal(elevenGlyphs(s.raw,s.width,s.height),null,name);}
});

test('eleven requires four confident one readings and rejects different whole numbers',async()=>{
 const {raw,width,height}=await elevenSource(),params=[],images=[],worker={setParameters:async p=>params.push(p),recognize:async image=>{images.push(image);return {data:{text:'1',confidence:90}};}};
 const r=await confirmElevenSpeed(worker,raw,width,height,[{text:'1',confidence:95}]);assert.equal(r.valid,true);assert.equal(r.text,'11');assert.equal(images.length,4);assert.deepEqual(r.glyphs.flatMap(g=>g.candidates.map(c=>c.height)),[80,100,80,100]);assert.equal(params.at(-1).tessedit_pageseg_mode,'7');
 for(const outputs of [[['1',90],['1',74]],[['1',90],['7',90]],[['1',90],['1',90],['1',90],['1',NaN]]]){const p=[],w={setParameters:async v=>p.push(v),recognize:async()=>{const [text,confidence]=outputs.shift();return {data:{text,confidence}};}};assert.equal((await confirmElevenSpeed(w,raw,width,height)).valid,false);assert.equal(p.at(-1).tessedit_char_whitelist,'0123456789.-');}
 for(const text of ['0','10','12','17','111'])assert.equal((await confirmElevenSpeed({recognize:()=>{throw Error('Whole reading must veto before OCR');}},raw,width,height,[{text,confidence:90}])).valid,false,text);
 const p=[],broken={setParameters:async v=>p.push(v),recognize:async()=>{throw Error('OCR failed');}};await assert.rejects(confirmElevenSpeed(broken,raw,width,height));assert.equal(p.at(-1).tessedit_pageseg_mode,'7');
});

test('source eleven cannot collapse to one even when both whole-string OCR views agree confidently',async()=>{
 const bytes=await readFile(new URL('../../fixtures/eleven-speed/eleven.png',import.meta.url));
 for(const weak of [false,true]){let calls=0;const worker={setParameters:async()=>{},recognize:async()=>({data:{text:'1',confidence:weak&&++calls===4?74:95}}),terminate:async()=>{}},reader=new SpeedReader(worker,hudProfile(manifest.geometry).speed);const r=await reader.read(bytes,1000);assert.equal(r.valid,!weak);assert.equal(r.kmh,weak?null:11);if(weak)assert.equal(r.rejection_reason,'ocr_unconfirmed');}
});
