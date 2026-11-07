// Monotonic client deadline. Server receives the original capture-clock deadline.
export class DecisionLease {
  constructor({leaseMs=250,clock=()=>performance.now()}={}){if(!Number.isInteger(leaseMs)||leaseMs<20||leaseMs>250)throw Error('Lease must be20..250ms');Object.assign(this,{leaseMs,clock});this.sequence=-1;this.expires=0;this.captureDeadline=null;this.generation=null;}
  update(source){
    const now=this.clock();
    if(!Number.isFinite(now)||!source||!Number.isInteger(source.sequence)||source.sequence<0||!Number.isInteger(source.generation)||source.generation<0||!Number.isFinite(source.age_ms)||source.age_ms<0||source.age_ms>=450||!Number.isSafeInteger(source.capture_start_ms)||source.capture_start_ms<0)throw Error('Valid fresh source observation required');
    if(source.sequence<this.sequence||this.generation!==null&&source.generation!==this.generation)throw Error('Observation order/session changed');
    if(source.sequence>this.sequence&&this.captureDeadline!==null&&source.capture_start_ms+450<=this.captureDeadline)throw Error('Non-increasing capture time');
    const deadline=source.capture_start_ms+450;if(!Number.isSafeInteger(deadline))throw Error('Invalid capture deadline');
    if(source.sequence===this.sequence&&deadline!==this.captureDeadline)throw Error('Observation identity changed');
    const expires=Math.min(now+this.leaseMs,now+450-source.age_ms);
    const decisionDeadline=Math.min(deadline,Math.floor(source.capture_start_ms+source.age_ms+this.leaseMs));
    this.decisionDeadline=source.sequence===this.sequence?Math.min(this.decisionDeadline,decisionDeadline):decisionDeadline;
    this.expires=source.sequence===this.sequence?Math.min(this.expires,expires):expires;
    this.sequence=source.sequence;this.generation=source.generation;this.captureDeadline=deadline;
  }
  remaining(){return Math.floor(this.expires-this.clock());}
  wireSource(){if(this.sequence<0)throw Error('Decision source required');return {sequence:this.sequence,generation:this.generation,capture_start_ms:this.captureDeadline-450,decision_expires_ms:this.decisionDeadline};}
}
