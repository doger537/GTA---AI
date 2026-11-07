import {test} from 'node:test';import {strict as assert} from 'node:assert';
import {observationTiming} from '../../packages/protocols/observation-timing.mjs';
test('observation timing remains optional for old bridges and preserves fractional milliseconds',()=>{
  assert.equal(observationTiming({}),null);
  const fields=['capture-work','acquire','encode','road','hud','map','road-resize','road-codec','pack','prepare'],headers=Object.fromEntries(fields.map((k,i)=>['x-obs-'+k+'-ms',String(i+.125)]));
  const t=observationTiming(headers);assert.equal(t.capture_work_ms,.125);assert.equal(t.prepare_ms,9.125);assert.equal(t.road_codec_ms,7.125);
  for(const invalid of ['', '-1','NaN','Infinity','1,25',undefined])assert.throws(()=>observationTiming({...headers,'x-obs-pack-ms':invalid}),/Invalid/);
});
