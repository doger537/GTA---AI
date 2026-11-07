import {test} from 'node:test';
import assert from 'node:assert/strict';
import {excludedByCamera} from '../../packages/perception/camera-profile.mjs';
test('Cockpit dashboard and HUD can never be used as road',()=>{
  for(let y=.5;y<=1;y+=.02)for(let x=0;x<=1;x+=.02)assert.equal(excludedByCamera(x,y,'cockpit'),true);
  assert.equal(excludedByCamera(.1,.9,'rear'),true);assert.equal(excludedByCamera(.9,.7,'rear'),true);
});
test('Visible road is retained and unknown profile never assumes cockpit',()=>{
  assert.equal(excludedByCamera(.5,.4,'cockpit'),false);
  assert.equal(excludedByCamera(.28,.7,'rear'),false);
  assert.equal(excludedByCamera(.5,.7,'unknown'),false);
});
test('Tested rear camera suppresses ego car, preserving visible left road',()=>{
  assert.equal(excludedByCamera(.57,.70,'rear'),true);assert.equal(excludedByCamera(.60,.85,'rear'),true);
  assert.equal(excludedByCamera(.34,.61,'rear'),false);assert.equal(excludedByCamera(.32,.80,'rear'),false);
});
