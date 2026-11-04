import {readFile} from 'node:fs/promises';

export const DIGIT_WIDTH=16,DIGIT_HEIGHT=28;
// Native pixels only: never infer splits through touching ink or a clipped edge.
export function extractHudDigits(source,width,height){
  if(!Number.isInteger(width)||!Number.isInteger(height)||width<3||height<3||source.length!==width*height*3)return null;
  const ink=new Uint8Array(width*height),columns=new Uint8Array(width),boxes=[];
  for(let i=0;i<ink.length;i++)if(Math.min(source[i*3],source[i*3+1],source[i*3+2])>210){ink[i]=1;columns[i%width]=1;}
  let start=-1;
  for(let x=0;x<=width;x++){
    if(x<width&&columns[x]){if(start<0)start=x;}
    else if(start>=0){
      let top=height,bottom=-1;
      for(let y=0;y<height;y++)for(let xx=start;xx<x;xx++)if(ink[y*width+xx]){top=Math.min(top,y);bottom=Math.max(bottom,y);}
      const b={left:start,top,width:x-start,height:bottom-top+1};
      if(start<1||x>=width||top<1||bottom>=height-1||b.height<10||b.width<2||b.width/b.height>.85)return null;
      boxes.push(b);start=-1;
    }
  }
  if(boxes.length<1||boxes.length>3)return null;
  const top=Math.min(...boxes.map(b=>b.top)),bottom=Math.max(...boxes.map(b=>b.top+b.height));
  if(boxes.some(b=>Math.abs(b.top-top)>2||Math.abs(b.top+b.height-bottom)>2))return null;
  return {ink,width,height,boxes};
}

export function digitVector(segmented,box){
  const scale=Math.min(DIGIT_WIDTH/box.width,DIGIT_HEIGHT/box.height),w=Math.max(1,Math.round(box.width*scale)),h=Math.max(1,Math.round(box.height*scale));
  const left=Math.floor((DIGIT_WIDTH-w)/2),top=Math.floor((DIGIT_HEIGHT-h)/2),out=new Uint8Array(DIGIT_WIDTH*DIGIT_HEIGHT);
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){
    const sx=box.left+Math.min(box.width-1,Math.floor((x+.5)*box.width/w)),sy=box.top+Math.min(box.height-1,Math.floor((y+.5)*box.height/h));
    out[(top+y)*DIGIT_WIDTH+left+x]=segmented.ink[sy*segmented.width+sx];
  }
  return out;
}

export function digitSimilarity(a,b){
  let intersection=0,total=0;for(let i=0;i<a.length;i++){intersection+=!!a[i]&&!!b[i]?1:0;total+=(a[i]?1:0)+(b[i]?1:0);}
  return total?2*intersection/total:0;
}

export function decodeDigitModel(json){
  if(json.version!==1||json.width!==DIGIT_WIDTH||json.height!==DIGIT_HEIGHT||!Number.isInteger(json.input?.width)||!Number.isInteger(json.input?.height)||json.input.width<3||json.input.height<10||json.min_score!==.90||json.min_margin!==.08||!Array.isArray(json.prototypes)||json.prototypes.length<10||json.prototypes.length>40)throw Error('Unsupported HUD digit model');
  const prototypes=json.prototypes.map(p=>{
    const vector=Uint8Array.from(Buffer.from(p.vector,'base64'));
    if(!/^\d$/.test(p.digit)||vector.length!==DIGIT_WIDTH*DIGIT_HEIGHT||!vector.some(Boolean)||vector.some(v=>v>1))throw Error('Invalid digit prototype');
    return {...p,vector};
  });
  if(new Set(prototypes.map(p=>p.digit)).size!==10)throw Error('Missing digit class');
  return {...json,prototypes};
}

export async function loadDigitModel(){return decodeDigitModel(JSON.parse(await readFile(new URL('./config/hud-digit-prototypes.json',import.meta.url),'utf8')));}

export function matchHudDigits(source,width,height,model){
  if(width!==model.input.width||height!==model.input.height)return {valid:false,reason:'unsupported_native_geometry',digits:[]};
  const segmented=extractHudDigits(source,width,height);if(!segmented)return {valid:false,reason:'incomplete_or_touching_digits',digits:[]};
  const digits=segmented.boxes.map(box=>{
    const vector=digitVector(segmented,box),scores=new Map();
    for(const p of model.prototypes)scores.set(p.digit,Math.max(scores.get(p.digit)??0,digitSimilarity(vector,p.vector)));
    const ranked=[...scores].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0])),[digit,score]=ranked[0],margin=score-ranked[1][1];
    return {digit,score,margin,box,valid:score>=model.min_score&&margin>=model.min_margin};
  });
  const text=digits.map(d=>d.digit).join(''),valid=digits.every(d=>d.valid)&&/^[1-9]\d{0,2}$/.test(text)&&Number(text)<=200;
  return {valid,text:valid?text:'',digits,reason:valid?'digit_prototypes_agree':'weak_or_ambiguous_digit'};
}

// Similarity is not OCR confidence. The model only confirms an existing exact,
// confident whole-string OCR value; it never invents a speed from shape alone.
export function confirmDigitModel(match,views){
  if(!match.valid)return {...match,valid:false};
  const supporters=views.filter(v=>v&&v.text===match.text&&Number.isFinite(v.confidence)&&v.confidence>=75);
  if(!supporters.length)return {...match,valid:false,reason:'no_exact_confident_ocr_support'};
  return {...match,confidence:Math.max(...supporters.map(v=>v.confidence)),reason:'whole_ocr_and_digit_model_agree'};
}
