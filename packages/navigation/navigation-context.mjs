export const INTENTS=['lane_follow','straight','left','right','stop'];
export function navigationAtFrame(command,startMs,endMs){
  if(!command?.valid||!INTENTS.includes(command.intent)||!['user','planner','gps','human_review'].includes(command.source))return {valid:false,intent:'unknown',reason:'no_explicit_navigation'};
  if(![startMs,endMs,command.issued_ms,command.expires_ms].every(Number.isFinite)||startMs>endMs||command.issued_ms>startMs||command.expires_ms<endMs)return {valid:false,intent:'unknown',reason:'navigation_outside_capture_interval'};
  return {...command,valid:true};
}
export function annotationAtFrame(annotations,session,start,end){
  if(annotations?.session!==session)return {valid:false,intent:'unknown',reason:'annotation_session_mismatch'};
  const matching=(annotations.intervals??[]).filter(a=>a.start_ms<=start&&a.end_ms>=end);
  if(matching.length!==1)return {valid:false,intent:'unknown',reason:matching.length?'ambiguous_annotations':'unannotated'};
  const a=matching[0];return navigationAtFrame({valid:true,intent:a.intent,source:'human_review',issued_ms:a.start_ms,expires_ms:a.end_ms},start,end);
}
