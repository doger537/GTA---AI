// Instrumentation is installed only by the profiler; application outputs are untouched.
export class LatencyTrace {
  constructor(){this.events=null;this.restore=[];}
  begin(){if(this.events)throw Error('Trace already active');this.events=[];this.start=performance.now();}
  end(){const events=this.events;this.events=null;return events;}
  wrap(object,key,label){
    const original=object[key],trace=this;
    object[key]=async function(...args){
      const events=trace.events,start=performance.now();
      try{return await original.apply(this,args);}finally{if(events)events.push({stage:label,start_ms:start-trace.start,end_ms:performance.now()-trace.start});}
    };
    this.restore.push(()=>{object[key]=original;});
  }
  close(){for(const restore of this.restore.reverse())restore();this.restore=[];this.events=null;}
}
export function percentiles(values){
  if(!values.length)return null;
  const sorted=[...values].sort((a,b)=>a-b),at=q=>sorted[Math.max(0,Math.ceil(q*sorted.length)-1)];
  return {n:sorted.length,min:sorted[0],p50:at(.5),p95:at(.95),max:sorted.at(-1),mean:values.reduce((a,b)=>a+b,0)/values.length};
}
export function stageSummary(rows){
  const groups=new Map();
  for(const row of rows){const totals=new Map();for(const e of row.events)totals.set(e.stage,(totals.get(e.stage)??0)+e.end_ms-e.start_ms);for(const [stage,total]of totals){if(!groups.has(stage))groups.set(stage,[]);groups.get(stage).push(total);}}
  return Object.fromEntries([...groups].map(([stage,values])=>[stage,percentiles(values)]));
}
