// Fixed development replay with nested timings. Never imports a bridge/actuator.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {PerformanceObserver,monitorEventLoopDelay} from 'node:perf_hooks';
import {isDeepStrictEqual} from 'node:util';
import {Perception} from './perception.mjs';
import {VehicleStateReader} from './vehicle-state.mjs';
import {hudProfile} from './hud-profile.mjs';
import {roadGeometry} from './road-guidance.mjs';
import {LatencyTrace,percentiles} from './latency-trace.mjs';
import {traceInferenceSession,inferenceParts} from './inference-trace.mjs';
const output=process.argv[2];await mkdir(output,{recursive:false});
const root='outputs/GtaAutopilot/observation-recordings/2026-11-03T07-08-56.123Z';
const samples=(await readFile(root+'/samples.jsonl','utf8')).trim().split('\n').map(JSON.parse);
const selected=Array.from({length:40},(_,i)=>samples[Math.floor(i*(samples.length-1)/39)]);
const saved='D:/GTA-AI-data/experiments/semantic-aspect-20261103';
const replay=JSON.parse(await readFile('D:/GTA-AI-data/experiments/semantic-followup-20261103/comparison.json','utf8'));
const data=await Promise.all(selected.map(async r=>({sample:r,road:await readFile(root+'/'+r.file),hud:await readFile(root+'/'+r.hud_file),reference:Object.fromEntries(await Promise.all(['square','aspect'].map(async mode=>[mode,JSON.parse(await readFile(`${saved}/${mode}/${r.file}.json`,'utf8'))])))})));
const start=performance.now(),gpu=[],gc=[],rows=[];
let gpuBuffer='',samplerError=null;
const sampler=spawn('nvidia-smi',['--query-gpu=timestamp,utilization.gpu,memory.used,power.draw,clocks.gr','--format=csv,noheader,nounits','-l','1'],{windowsHide:true});
sampler.stdout.on('data',b=>{gpuBuffer+=b.toString();const lines=gpuBuffer.split(/\r?\n/);gpuBuffer=lines.pop();for(const text of lines)if(text.trim())gpu.push({at_ms:performance.now()-start,text:text.trim()});});
sampler.on('error',e=>{samplerError=e.message;});sampler.stderr.on('data',()=>{});
const observer=new PerformanceObserver(list=>{for(const e of list.getEntries())gc.push({start_ms:e.startTime-start,duration_ms:e.duration,kind:e.detail?.kind});});observer.observe({entryTypes:['gc']});
const delay=monitorEventLoopDelay({resolution:10});delay.enable();let error=null;
try {
  const blocks=['square','aspect','aspect','square'];
  for(let block=0;block<blocks.length;block++) {
    const mode=blocks[block],v=await Perception.load({provider:'dml',cameraProfile:'rear'}),reader=await VehicleStateReader.create(hudProfile(data[0].sample.hud_geometry)),trace=new LatencyTrace();
    const analyze=v.semantic.analyze.bind(v.semantic);v.semantic.analyze=(bytes,opts)=>analyze(bytes,{...opts,resizeMode:mode});
    trace.wrap(v,'analyze','vision');trace.wrap(v.semantic,'analyze','semantic');
    trace.wrap(reader,'read','ocr');trace.wrap(reader.speed,'read','speed');trace.wrap(reader.speed.worker,'recognize','speed.recognize');trace.wrap(reader.worker,'recognize','gear.recognize');
    traceInferenceSession(trace,v.session,'yolop');traceInferenceSession(trace,v.semantic.session,'segformer');
    try {
      for(let i=0;i<2;i++)await Promise.all([v.analyze(data[0].road),reader.read(data[0].hud,data[0].sample.capture_start_ms)]);
      reader.speed.previous=null;
      for(const d of data) {
        delay.reset();const cpu=process.cpuUsage(),at=performance.now()-start;
        trace.begin();const [p,state]=await Promise.all([v.analyze(d.road),reader.read(d.hud,d.sample.capture_start_ms)]);
        const geometry=roadGeometry(p.semantic,'lane_follow'),total_ms=performance.now()-trace.start,events=trace.end(),used=process.cpuUsage(cpu),s=p.semantic;
        const expected=d.reference[mode],actual={gridWidth:s.gridWidth,gridHeight:s.gridHeight,rawRoad:[...s.rawRoad],road:[...s.road],obstacle:[...s.obstacle],corridorRoad:[...s.corridorRoad],corridorObstacle:[...s.corridorObstacle],vehicles:p.vehicles,labels:[...s.labels]};
        const parity=Object.entries(actual).every(([key,value])=>isDeepStrictEqual(value,expected[key]));
        const ocrExpected=replay.pipeline[mode].rows.find(r=>r.pass===0&&r.file===d.sample.file).state;
        const ocrParity=isDeepStrictEqual(state,ocrExpected);
        rows.push({mode,block,file:d.sample.file,at_ms:at,total_ms,events,inference:{yolop:inferenceParts(events,'yolop'),segformer:inferenceParts(events,'segformer')},event_loop_delay_ms:{p95:delay.percentile(95)/1e6,max:delay.max/1e6},process_cpu_ms:(used.user+used.system)/1000,geometry_valid:geometry.valid,parity,ocr_parity:ocrParity});
        if(!parity||!ocrParity)throw Error('Trace output parity failed');
      }
    } finally {trace.close();await reader.close();await Promise.allSettled([v.session.release(),v.semantic.session.release()]);}
    console.log(JSON.stringify({block,mode,frames:rows.length,slow:rows.filter(r=>r.total_ms>450).length}));
    await writeFile(output+'/trace.json',JSON.stringify({scope:'Offline compute trace, not live capture age. Native time includes ORT/driver wait, not GPU kernel-only time. GPU telemetry1s coarse. Data/parity frozen.',rows,gpu,gc},null,2));
    if(block===3&&!rows.some(r=>r.total_ms>450))blocks.push('square','aspect','aspect','square');
  }
} catch(e){error=e.message;throw e;}
finally {
  delay.disable();observer.disconnect();sampler.kill();
  await writeFile(output+'/trace.json',JSON.stringify({error,rows,gpu,gc,samplerError,elapsed_ms:performance.now()-start},null,2));
}
const summary={};for(const mode of ['square','aspect']){const rr=rows.filter(r=>r.mode===mode);summary[mode]={frames:rr.length,total_ms:percentiles(rr.map(r=>r.total_ms)),over450:rr.filter(r=>r.total_ms>450).length,output_parity:rr.every(r=>r.parity&&r.ocr_parity),native_ms:Object.fromEntries(['yolop','segformer'].map(model=>[model,percentiles(rr.map(r=>r.inference[model].native_ms))])),admission_ms:Object.fromEntries(['yolop','segformer'].map(model=>[model,percentiles(rr.map(r=>r.inference[model].admission_ms))]))};}
await writeFile(output+'/summary.json',JSON.stringify(summary,null,2));console.log(JSON.stringify(summary,null,2));
