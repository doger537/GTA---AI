import {frameAge} from './bridge-client.mjs';

export function observationGeometry(o) {
  return JSON.stringify({hud:Object.fromEntries(['full_width','full_height','left','top','width','height'].map(k=>[k,o.hud.hud[k]])),minimap:Object.fromEntries(['left','top','width','height'].map(k=>[k,o.minimap.region[k]]))});
}

export function validateObservation(o,{generation,clock=()=>performance.now(),maxAgeMs=450}={}) {
  if(!o||o.source!=='single_capture'||o.capture_skew_ms!==0||!Number.isSafeInteger(o.sequence)||o.sequence<1||!Number.isSafeInteger(o.generation)||o.generation<0)throw Error('Invalid single-source observation');
  if(generation!==undefined&&o.generation!==generation)throw Error('Observation generation changed');
  if(!Number.isSafeInteger(o.capture_start_ms)||!Number.isSafeInteger(o.capture_end_ms)||o.capture_start_ms<0||o.capture_end_ms<o.capture_start_ms||o.capture_end_ms-o.capture_start_ms>maxAgeMs)throw Error('Invalid observation capture interval');
  for(const [name,mime] of [['road','image/jpeg'],['hud','image/png'],['minimap','image/png']]){
    const part=o[name];
    if(!part||!Buffer.isBuffer(part.bytes)||part.bytes.length===0||part.mimeType!==mime||part.sequence!==o.sequence||part.capture_start_ms!==o.capture_start_ms||part.capture_end_ms!==o.capture_end_ms||part.generation!==o.generation)throw Error('Mixed observation component: '+name);
    const age=frameAge(part,clock());if(!Number.isFinite(age)||age<0||age>maxAgeMs)throw Error('Stale observation component: '+name);
    if(part.frame_age_ms<o.capture_end_ms-o.capture_start_ms)throw Error('Observation age precedes capture completion');
  }
  const h=o.hud.hud,m=o.minimap.region;
  if(!h||!m||!['full_width','full_height','left','top','width','height'].every(k=>Number.isSafeInteger(h[k]))||h.full_width<10||h.full_height<10||h.left<0||h.top<0||h.width<1||h.height<1||h.left+h.width>h.full_width||h.top+h.height>h.full_height)throw Error('Invalid observation HUD geometry');
  if(!['left','top','width','height'].every(k=>Number.isSafeInteger(m[k]))||m.left<0||m.top<0||m.width<1||m.height<1||m.left+m.width>h.full_width||m.top+m.height>h.full_height)throw Error('Invalid observation minimap geometry');
  return Math.max(...['road','hud','minimap'].map(k=>frameAge(o[k],clock())));
}

// One packet per iteration. No fallback to independently captured /frame or /hud.
export class ObservationStream {
  constructor(client,{clock=()=>performance.now(),ownerKind=null}={}){this.client=client;this.clock=clock;this.ownerKind=ownerKind;this.generation=null;this.last=null;this.geometry=null;this.fault=null;}
  ready(s){return s?.target_found===true&&s.foreground===true&&typeof s.busy==='boolean'&&Number.isSafeInteger(s.generation)&&s.generation>=0&&(!s.busy||this.ownerKind!==null&&s.input_owner===this.ownerKind)&&(!s.input_owner||s.input_owner===this.ownerKind);}
  async read(){
    if(this.fault)throw Error('Observation session latched: '+this.fault);
    try{
      const before=await this.client.status();
      if(!this.ready(before))throw Error('Focused idle capture target required');
      const generation=this.generation??before.generation;if(before.generation!==generation)throw Error('Capture session stopped');
      const o=await this.client.observation();validateObservation(o,{generation,clock:this.clock});
      const key=observationGeometry(o);
      if(this.geometry!==null&&key!==this.geometry)throw Error('Observation geometry changed');
      if(this.last&&(o.sequence<=this.last.sequence||o.capture_start_ms<=this.last.capture_start_ms))throw Error('Non-increasing observation');
      const after=await this.client.status();
      if(!this.ready(after)||after.generation!==generation)throw Error('Capture interrupted');
      validateObservation(o,{generation,clock:this.clock});
      this.generation=generation;this.geometry=key;this.last={sequence:o.sequence,capture_start_ms:o.capture_start_ms};this.status=after;return o;
    }catch(error){this.fault=error.message;throw error;}
  }
}
