import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {SemanticRoad} from './semantic-road.mjs';
import {Perception} from './perception.mjs';
const probes=JSON.parse(await readFile(new URL('./road-probes.json',import.meta.url),'utf8'));
const semantic=await SemanticRoad.load(),old=await Perception.load({roadModel:'yolop'});
const results=[],summary={old:{correct:0,total:0,false_road:0,missed_road:0},new:{correct:0,total:0,false_road:0,missed_road:0}};
const dest=new URL('./runs/road-benchmark/',import.meta.url);await mkdir(dest,{recursive:true});
const warmup=await readFile(new URL(probes.frames[0].file,import.meta.url));await semantic.analyze(warmup);await old.analyze(warmup);
for(const test of probes.frames){
  const bytes=await readFile(new URL(test.file,import.meta.url));
  const s=await semantic.analyze(bytes,{cameraProfile:test.profile}),o=await old.analyze(bytes);
  const points=test.points.map(([x,y,expected])=>{
    const {n,top,left,rw,rh}=o.letterbox;
    const oi=Math.min(n-1,Math.floor(top+y*rh))*n+Math.min(n-1,Math.floor(left+x*rw));
    const next=semantic.sample(s,x,y),before=o.mask[oi]===1;
    for(const [name,value] of [['old',before],['new',next.road]]){summary[name].total++;if(value===expected)summary[name].correct++;else if(value)summary[name].false_road++;else summary[name].missed_road++;}
    return {x,y,expected,old:before,new:next.road,semantic_class:next.label};
  });
  results.push({name:test.name,profile:test.profile,role:test.role??'development_check',old_ms:o.inference_ms,new_ms:s.inference_ms,points});
  await writeFile(new URL(test.name+'-old.jpg',dest),await old.overlay(bytes,o));
  await writeFile(new URL(test.name+'-new.jpg',dest),await semantic.overlay(bytes,s));
}
const report={scope:probes.description,summary,results};await writeFile(new URL('report.json',dest),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
