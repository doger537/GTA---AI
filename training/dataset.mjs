export const TARGET_KEYS=['w','a','s','d','space','shift'];
import {navigationAtFrame} from '../packages/navigation/navigation-context.mjs';
const canonical=keys=>[...new Set(keys)].sort().join(',');
export function validateTimeline(events,start){
  let sequence=0,time=start;
  for(const e of events){
    if(e.sequence!==++sequence||!Number.isFinite(e.time_ms)||e.time_ms<time||typeof e.down!=='boolean'||![...TARGET_KEYS,'f8'].includes(e.key))throw Error('Invalid keyboard event timeline');
    time=e.time_ms;
  }
}
export function prepareExamples(rows,{trimStartMs=4000,history=4,maxGapMs=250,guardMs=10,input=null,events=[],endMs=Infinity}={}){
  if(!rows.length)return {examples:[],rejected:{empty:1}};
  if(input)validateTimeline(events,input.started_ms);
  const first=rows[0].capture_start_ms,examples=[],rejected={};let cursor=0;
  const held=new Set(input?.initial_keys??[]);
  const reject=reason=>{rejected[reason]=(rejected[reason]??0)+1;};
  for(let i=0;i<rows.length;i++){
    const r=rows[i];
    if(!/^\d+\.jpg$/.test(r.file)||![r.capture_start_ms,r.capture_end_ms].every(Number.isFinite)||r.capture_end_ms<r.capture_start_ms||(i&&r.capture_start_ms<=rows[i-1].capture_start_ms))throw Error('Invalid frame timeline or filename');
    if(r.capture_start_ms-first<trimStartMs){reject('trimmed_camera_start');continue;}
    if(i<history-1){reject('missing_history');continue;}
    const sequence=rows.slice(i-history+1,i+1);
    if(sequence.some((f,j)=>j&&f.capture_start_ms-sequence[j-1].capture_start_ms>maxGapMs)){reject('history_gap');continue;}
    let keys;
    if(input){
      if(r.capture_start_ms-guardMs<input.started_ms||r.capture_end_ms+guardMs>endMs){reject('outside_event_coverage');continue;}
      while(cursor<events.length&&events[cursor].time_ms<r.capture_start_ms-guardMs){const e=events[cursor++];if(e.down)held.add(e.key);else held.delete(e.key);}
      if(events[cursor]?.time_ms<=r.capture_end_ms+guardMs){reject('event_near_capture');continue;}
      keys=[...held];
      if(canonical(keys)!==canonical(r.keys_before)||canonical(keys)!==canonical(r.keys_after)){reject('event_snapshot_mismatch');continue;}
    }else{
      if(!r.label_stable||canonical(r.keys_before)!==canonical(r.keys_after)){reject('ambiguous_snapshot');continue;}
      keys=r.keys_before;
    }
    if(keys.some(k=>!TARGET_KEYS.includes(k))||(keys.includes('w')&&keys.includes('s'))||(keys.includes('a')&&keys.includes('d'))){reject('conflicting_or_unsupported_keys');continue;}
    examples.push({frames:sequence.map(f=>f.file),time_ms:r.capture_end_ms-first,keys:TARGET_KEYS.filter(k=>keys.includes(k)),targets:TARGET_KEYS.map(k=>Number(keys.includes(k))),label_source:input?'keyboard_events_checked_against_snapshots':'legacy_snapshots_provisional',navigation:navigationAtFrame(r.navigation,r.capture_start_ms,r.capture_end_ms)});
  }
  return {examples,rejected};
}
