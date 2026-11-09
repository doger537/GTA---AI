import {test} from 'node:test';import {strict as assert} from 'node:assert';
import {emptyLabelFile,validateLabelFile,SCENE_KINDS} from '../../packages/perception/label-template.mjs';

test('the template starts empty and refuses to invent values',()=>{
 const file=emptyLabelFile({session:'s1',files:['000000.jpg','000010.jpg']});
 assert.equal(file.frames.length,2);
 assert.deepEqual(file.frames[0].points,[]);
 assert.equal(file.frames[0].scene.kind,null);
 assert.equal(file.frames[0].scene.camera_yaw,null);
 assert.match(file.instructions.join(' '),/do not guess/);
 assert.throws(()=>emptyLabelFile({files:[]}),/nonempty/);
 assert.throws(()=>emptyLabelFile({files:['../x.jpg']}),/bare name/);
});

test('an empty template is valid, but a guessed or broken point is rejected',()=>{
 const empty=emptyLabelFile({files:['000000.jpg']});
 assert.equal(validateLabelFile(empty).ok,true);
 const bad=structuredClone(empty);
 bad.frames[0].points.push({x:.5,y:.5,expected:'hazard'});
 assert.equal(validateLabelFile(bad).ok,false);
 assert.match(validateLabelFile(bad).problems[0],/known kind/);
 bad.frames[0].points[0].kind='curb';
 bad.frames[0].points.push({x:1.4,y:.2,expected:'road'});
 assert.match(validateLabelFile(bad).problems[0],/inside 0\.\.1/);
 bad.frames[0].scene.kind='beach';
 assert.ok(validateLabelFile(bad).problems.some(p=>/scene\.kind/.test(p)));
 for(const kind of SCENE_KINDS){const ok=structuredClone(empty);ok.frames[0].scene.kind=kind;assert.equal(validateLabelFile(ok).ok,true);}
});

test('a label from another recording or a duplicate frame is caught',()=>{
 const file=emptyLabelFile({files:['000000.jpg']});
 file.frames.push({...file.frames[0]});
 const result=validateLabelFile(file);
 assert.equal(result.ok,false);
 assert.ok(result.problems.some(p=>/duplicate/.test(p)));
 const foreign=emptyLabelFile({files:['000999.jpg']});
 assert.equal(validateLabelFile(foreign,{knownFiles:new Set(['000000.jpg'])}).ok,false);
 assert.equal(validateLabelFile(foreign,{knownFiles:new Set(['000999.jpg'])}).ok,true);
});
