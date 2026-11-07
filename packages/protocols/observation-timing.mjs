// Optional version-1 diagnostics. Durations nest; do not sum parent/child spans.
export function observationTiming(headers){
  const fields=['capture-work','acquire','encode','road','hud','map','road-resize','road-codec','pack','prepare'];
  const keys=fields.map(k=>'x-obs-'+k+'-ms');
  if(keys.every(k=>headers[k]===undefined))return null;
  if(keys.some(k=>typeof headers[k]!=='string'||!headers[k].trim()||!Number.isFinite(Number(headers[k]))||Number(headers[k])<0))throw Error('Invalid observation timing headers');
  return Object.fromEntries(fields.map((k,i)=>[k.replaceAll('-','_')+'_ms',Number(headers[keys[i]])]));
}
