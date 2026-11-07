import http from 'node:http';
import { readFile } from 'node:fs/promises';
import {observationTiming} from './observation-timing.mjs';

export function frameAge(frame,now=performance.now()) {
  const {frame_age_ms:age,delivery_ms:delivery,received_at_ms:received}=frame;
  if(![age,delivery,received,now].every(Number.isFinite)||age<0||delivery<0||now<received)return Infinity;
  return age+delivery+now-received;
}

export async function connect(configFile = new URL('../../apps/gta-control/connection.json', import.meta.url)) {
  const config = JSON.parse((await readFile(configFile, 'utf8')).replace(/^\uFEFF/, ''));
  const url = new URL(config.url);
  if (url.hostname !== '127.0.0.1' || url.protocol !== 'http:') throw new Error('Expected local GTA Control URL');
  return new GtaClient(config);
}

export class GtaClient {
  constructor(config) {
    Object.defineProperty(this,'physical_input',{value:true});
    this.url = config.url;
    this.token = config.token;
    this.agent = new http.Agent({ keepAlive: true, maxSockets: 2, maxFreeSockets: 1 });
    // Stop has a separate connection so it never queues behind a long action.
    this.controlAgent = new http.Agent({ keepAlive: true, maxSockets: 1, maxFreeSockets: 1 });
  }
  request(path, payload) {
    const body = payload === undefined ? undefined : Buffer.from(JSON.stringify(payload));
    const started = performance.now();
    return new Promise((resolve, reject) => {
      const request = http.request(new URL(path, this.url), {
        method: body ? 'POST' : 'GET',
        agent: path === '/stop' ? this.controlAgent : this.agent,
        headers: {
          Authorization: `Bearer ${this.token}`,
          Connection: 'keep-alive',
          ...(body ? { 'Content-Type': 'application/json', 'Content-Length': body.length } : {}),
        },
      }, response => {
        const headersAt = performance.now();
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('error', reject);
        response.on('aborted', () => reject(new Error('Incomplete response; action outcome unknown')));
        response.on('end', () => {
          const bodyAt=performance.now();
          const bytes = Buffer.concat(chunks);
          const concatAt=performance.now();
          if (response.statusCode !== 200) {
            reject(new Error(`GTA Control HTTP ${response.statusCode}: ${bytes.toString('utf8')}`));
            return;
          }
          resolve({ bytes, headers: response.headers, roundtrip_ms: Math.round(performance.now() - started), delivery_ms: performance.now()-headersAt, received_at_ms:performance.now(),transport_timing:{headers_ms:headersAt-started,body_ms:bodyAt-headersAt,concat_ms:concatAt-bodyAt,request_ms:concatAt-started} });
        });
      });
      // Never retry actions automatically: a lost response does not mean input was not sent.
      request.setTimeout(8000, () => request.destroy(new Error('Request timed out; action outcome unknown')));
      request.on('error', reject);
      request.end(body);
    });
  }
  async json(path, payload) { const result = await this.request(path, payload); return JSON.parse(result.bytes.toString('utf8')); }
  status() { return this.json('/status'); }
  captureStatus() { return this.json('/capture-status'); }
  stop() { return this.json('/stop', {}); }
  armInput(kind,generation,target_pid) { return this.json('/control/arm',{kind,generation,...(target_pid===undefined?{}:{target_pid})}); }
  releaseInput(owner_id) { return this.json('/control/release',{owner_id}); }
  action(payload) { return this.json('/action', payload); }
  hold(payload) { return this.json('/hold', payload); }
  startRecording() { return this.json('/record/start',{}); }
  navigation(command) { return command===undefined?this.json('/navigation'):this.json('/navigation',command); }
  recordingEvents(session,after_sequence=0,finish=false) { return this.json(finish?'/record/end':'/record/events',{session,after_sequence}); }
  async frame() { return this.image(await this.request('/frame')); }
  async observation() {
    const result=await this.request('/observation'),h=result.headers;
    if(h['x-observation-version']!=='1')throw Error('Unsupported observation protocol');
    const lengths=['x-road-bytes','x-hud-bytes','x-minimap-bytes'].map(k=>Number(h[k]));
    if(lengths.some(n=>!Number.isSafeInteger(n)||n<=0)||lengths.reduce((a,b)=>a+b,0)!==result.bytes.length)throw Error('Invalid observation payload lengths');
    const {bytes:packed,mimeType:unused,...timing}=this.image(result);
    if(!Number.isInteger(timing.sequence)||timing.sequence<1||![timing.capture_start_ms,timing.capture_end_ms,timing.frame_age_ms].every(Number.isFinite)||timing.capture_start_ms<0||timing.capture_end_ms<timing.capture_start_ms||timing.frame_age_ms<0)throw Error('Invalid observation timeline');
    const generation=Number(h['x-generation']);if(!Number.isInteger(generation)||generation<0)throw Error('Invalid observation generation');
    const geometry=Object.fromEntries(['full_width','full_height','left','top','width','height'].map(k=>[k,Number(h['x-hud-'+k.replaceAll('_','-')])]));
    const map=Object.fromEntries(['left','top','width','height'].map(k=>[k,Number(h['x-minimap-'+k])]));
    const valid=r=>Object.values(r).every(Number.isInteger)&&r.left>=0&&r.top>=0&&r.width>0&&r.height>0&&r.left+r.width<=geometry.full_width&&r.top+r.height<=geometry.full_height;
    if(!valid(geometry)||!valid(map)||geometry.full_width<10||geometry.full_height<10)throw Error('Invalid observation geometry');
    const part=(start,end,mimeType)=>({...timing,generation,bytes:packed.subarray(start,end),mimeType});
    return {...timing,generation,source:'single_capture',capture_skew_ms:0,encoding_parallel:h['x-obs-encoding-parallel']==='true',server_timing:observationTiming(h),road:part(0,lengths[0],'image/jpeg'),hud:{...part(lengths[0],lengths[0]+lengths[1],'image/png'),hud:geometry},minimap:{...part(lengths[0]+lengths[1],packed.length,'image/png'),region:map}};
  }
  async hud() { const r=await this.request('/hud'),frame=this.image(r),h=r.headers;return {...frame,hud:{full_width:Number(h['x-hud-full-width']),full_height:Number(h['x-hud-full-height']),left:Number(h['x-hud-left']),top:Number(h['x-hud-top']),width:Number(h['x-hud-width']),height:Number(h['x-hud-height'])}}; }
  async step(payload) { return this.image(await this.request('/step', payload)); }
  image(result) {
    const h = result.headers;
    return {
      bytes: result.bytes,
      mimeType: String(h['content-type']??'image/jpeg').split(';')[0],
      roundtrip_ms: result.roundtrip_ms,
      delivery_ms: result.delivery_ms,
      received_at_ms: result.received_at_ms,
      transport_timing:result.transport_timing??null,
      frame_age_ms: Number(h['x-frame-age-ms']),
      sequence: Number(h['x-frame-sequence']),
      capture_start_ms: Number(h['x-capture-start-ms']),
      capture_end_ms: Number(h['x-capture-end-ms']),
      keys_before: h['x-keys-before']===undefined?null:String(h['x-keys-before']).split(',').filter(Boolean),
      keys_after: h['x-keys-after']===undefined?null:String(h['x-keys-after']).split(',').filter(Boolean),
      navigation:h['x-nav-intent']===undefined?null:{intent:h['x-nav-intent'],source:h['x-nav-source'],valid:h['x-nav-valid']==='true',sequence:Number(h['x-nav-sequence']),issued_ms:Number(h['x-nav-issued-ms']),expires_ms:Number(h['x-nav-expires-ms'])},
      connection_id: Number(h['x-connection-id']),
      ...(h['x-action-ms'] === undefined ? {} : {
        action_ms: Number(h['x-action-ms']),
        capture_ms: Number(h['x-capture-ms']),
        total_ms: Number(h['x-total-ms']),
        interrupted: h['x-action-interrupted'] === 'true',
      }),
    };
  }
  close() { this.agent.destroy(); this.controlAgent.destroy(); }
}
