import {connectRecordingBridge} from './recording-bridge.mjs';
import {INTENTS} from './navigation-context.mjs';
const intent=process.argv[2],ttl=Number(process.argv[3]??5000);
if(intent&&!INTENTS.includes(intent))throw Error('Intent: lane_follow, straight, left, right, stop');
if(!Number.isInteger(ttl)||ttl<100||ttl>10000)throw Error('TTL must be 100..10000 ms');
const client=await connectRecordingBridge();
try{console.log(JSON.stringify(await client.navigation(intent?{intent,source:'user',ttl_ms:ttl}:undefined),null,2));}finally{client.close();}
