import assert from 'node:assert/strict';import {readFile,writeFile} from 'node:fs/promises';
import {percentiles} from '../../packages/protocols/latency-trace.mjs';
const root=new URL('../runs/latency-2026-11-03/',import.meta.url),load=async name=>JSON.parse(await readFile(new URL(name+'.json',root),'utf8'));
const rounds=[],all=[[],[]];let equal=0;
for(let round=0;round<3;round++){
  const before=await load('replay-before-'+round),after=await load('replay-worker-'+round);
  assert.equal(before.rows.length,after.rows.length);
  for(let i=0;i<before.rows.length;i++){for(const key of ['state','geometry','decision','output_digest'])assert.deepEqual(after.rows[i][key],before.rows[i][key],`${round}:${i}:${key}`);equal++;}
  all[0].push(...before.rows);all[1].push(...after.rows);
  rounds.push({round,before:before.summary,after:after.summary,latency_reduction_fraction:1-after.summary.total_ms.p50/before.summary.total_ms.p50});
}
const before=await load('live-before-matched'),after=await load('live-worker-matched');
const live={frames_per_version:16,before:before.summary,after:after.summary,latency_reduction_fraction:1-after.summary.total_ms.p50/before.summary.total_ms.p50,caveat:'Sequential live passes, not identical images. Only replay output equivalence is exact.'};
const jsLog=await readFile(new URL('tests.log',root),'utf8'),pyLog=await readFile(new URL('python-tests.log',root),'utf8');
assert.match(jsLog,/# fail 0\b/);assert.match(pyLog,/\bOK\b/);
const checks={exact_replay_comparisons:equal,unique_replay_frame_pairs:16,actual_dml_models:['YOLOP 640','SegFormer 512'],output_fields_compared:['vehicle state including OCR candidates','road geometry','gate decision','hashes of road/probability/labels/YOLOP mask/lane','vehicle boxes and scanline rows'],js_tests_passed:Number(jsLog.match(/# pass (\d+)/)[1]),python_tests_passed:Number(pyLog.match(/Ran (\d+) tests/)[1]),game_commands_sent:false};
const result={scope:'Profile-guided worker scheduling, not a Rust rewrite or closed-loop driving test.',checks,replay:{rounds,combined_before_ms:percentiles(all[0].map(r=>r.total_ms)),combined_after_ms:percentiles(all[1].map(r=>r.total_ms))},live};
await writeFile(new URL('comparison.json',root),JSON.stringify(result,null,2));
console.log(JSON.stringify({checks,replay_before:result.replay.combined_before_ms,replay_after:result.replay.combined_after_ms,live_cycle_before:live.before.total_ms.p50,live_cycle_after:live.after.total_ms.p50,live_reduction_percent:live.latency_reduction_fraction*100,live_loop_p95_before:live.before.event_loop_delay_ms.p95,live_loop_p95_after:live.after.event_loop_delay_ms.p95},null,2));
