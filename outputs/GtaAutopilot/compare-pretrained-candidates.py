"""Offline only. Isolated optional packages, fixed defaults, no game/input imports.
YOLOPv2 decoding follows CAIC-AD/YOLOPv2 (MIT), see third-party notice.
"""
import argparse,pathlib,sys,os,json,time,importlib,hashlib
p=argparse.ArgumentParser();p.add_argument('--assets',required=True);p.add_argument('--recording',required=True);p.add_argument('--output',required=True);p.add_argument('--frames',type=int,default=40);a=p.parse_args()
assets=pathlib.Path(a.assets);root=pathlib.Path(a.recording);outdir=pathlib.Path(a.output)
sys.path[:0]=[str(assets/'packages'),str(assets/'torchvision-packages')]
os.environ['YOLO_CONFIG_DIR']=str(assets/'config');os.environ['MPLCONFIGDIR']=str(assets/'mpl')
import numpy as np,torch,cv2,torchvision
from ultralytics.utils import ops
torch.set_num_threads(3)
samples=[json.loads(l) for l in (root/'samples.jsonl').read_text().splitlines() if l.strip()]
if not samples or not 1<=a.frames<=500:raise ValueError('Need nonempty recording and 1..500 frames')
count=min(a.frames,len(samples))
selected=[samples[int(i*(len(samples)-1)/(count-1))] for i in range(count)] if count>1 else samples[:1]
if any(not r['file'].endswith('.jpg') or pathlib.Path(r['file']).name!=r['file'] for r in selected):raise ValueError('Bad recorded paths')
def safe_type(name):
 if name=='set':return set
 if name=='NoneType':return type(None)
 raise ValueError('Unsupported dill type')
def gta_model():
 allowed=[set]
 for name in torch.serialization.get_unsafe_globals_in_checkpoint(assets/'gta_segment.pt'):
  if name=='dill._dill._load_type':allowed.append((safe_type,name));continue
  module,attr=name.rsplit('.',1)
  if not (module.startswith(('torch.nn.','ultralytics.nn.','ultralytics.utils.')) or module in ['ultralytics.utils','collections','types','builtins']):raise ValueError('Unapproved checkpoint global '+name)
  allowed.append(getattr(importlib.import_module(module),attr))
 with torch.serialization.safe_globals(allowed):ckpt=torch.load(assets/'gta_segment.pt',map_location='cpu',weights_only=True)
 model=(ckpt.get('ema') or ckpt['model']).float().eval()
 if list(model.names.values())!=['npc','other_car','player_car','road','road_line']:raise ValueError('Unexpected classes')
 return model
def tensor(image):return torch.from_numpy(np.ascontiguousarray(image[:,:,::-1].transpose(2,0,1))).float().unsqueeze(0)/255
def grid(mask):return cv2.resize(mask.astype(np.uint8),(128,128),interpolation=cv2.INTER_NEAREST).reshape(-1).tolist()
def infer_gta(model,image):
 h,w=image.shape[:2];ratio=min(640/w,640/h);rw,rh=round(w*ratio),round(h*ratio);left=(640-rw)//2;top=(640-rh)//2
 inp=cv2.copyMakeBorder(cv2.resize(image,(rw,rh)),top,640-rh-top,left,640-rw-left,cv2.BORDER_CONSTANT,value=(114,114,114))
 prediction=model(tensor(inp));detection=ops.non_max_suppression(prediction[0],conf_thres=.6,iou_thres=.7,nc=5)[0]
 masks=ops.process_mask(prediction[1][-1][0],detection[:,6:],detection[:,:4],(640,640),upsample=True).numpy() if len(detection) else np.zeros((0,640,640),dtype=bool)
 road=np.zeros((h,w),np.uint8);obstacle=road.copy();ego=road.copy();boxes=[]
 for d,mask in zip(detection,masks):
  cls=int(d[5]);native=cv2.resize(mask[top:top+rh,left:left+rw].astype(np.uint8),(w,h),interpolation=cv2.INTER_NEAREST)
  if cls==3:road|=native
  if cls in [0,1,2]:obstacle|=native
  if cls==2:ego|=native
  if cls in [0,1]:
   x1,y1,x2,y2=d[:4].tolist();boxes.append({'x':(x1-left)/ratio/w,'y':(y1-top)/ratio/h,'w':(x2-x1)/ratio/w,'h':(y2-y1)/ratio/h,'score':float(d[4]),'class_id':cls})
 return road,obstacle,ego,boxes
def infer_yolop(model,image):
 canonical=cv2.resize(image,(1280,720));small=cv2.resize(canonical,(640,360));inp=cv2.copyMakeBorder(small,12,12,0,0,cv2.BORDER_CONSTANT,value=(114,114,114))
 (heads,anchors),road_logits,lane_logits=model(tensor(inp));decoded=[]
 for index,head in enumerate(heads):
  batch,channels,ny,nx=head.shape;values=head.reshape(batch,3,85,ny,nx).permute(0,1,3,4,2).sigmoid()
  gy,gx=torch.meshgrid(torch.arange(ny),torch.arange(nx),indexing='ij');xygrid=torch.stack((gx,gy),-1).reshape(1,1,ny,nx,2)
  centers=(2*values[...,:2]-.5+xygrid)*(8*2**index);sizes=(2*values[...,2:4])**2*anchors[index]
  decoded.append(torch.cat((centers,sizes,values[...,4:]),-1).reshape(-1,85))
 detection=torch.cat(decoded);scores,classes=(detection[:,5:]*detection[:,4:5]).max(1);keep=scores>=.3;detection=detection[keep];scores=scores[keep];classes=classes[keep]
 xyxy=torch.cat((detection[:,:2]-detection[:,2:4]/2,detection[:,:2]+detection[:,2:4]/2),1)
 indices=torchvision.ops.nms(xyxy+classes[:,None]*4096,scores,.45)[:300];boxes=[]
 for i in indices:
  x1,y1,x2,y2=xyxy[i].tolist();b={'x':x1/640,'y':(y1-12)/360,'w':(x2-x1)/640,'h':(y2-y1)/360,'score':float(scores[i]),'class_id':int(classes[i])}
  if b['y']+b['h']>.86 and b['x']<.65 and b['x']+b['w']>.35 and b['w']*b['h']>.10:continue
  boxes.append(b)
 # Same author-defined mask decoding: crop padding before bilinear upsampling/argmax.
 logits=torch.nn.functional.interpolate(road_logits[:,:,12:372,:],size=image.shape[:2],mode='bilinear',align_corners=False)
 road=logits.argmax(1)[0].numpy().astype(np.uint8);obstacle=np.zeros_like(road)
 return road,obstacle,np.zeros_like(road),boxes
if __name__ == '__main__':
 outdir.mkdir(parents=True,exist_ok=True);summary={}
 for name,load,fn in [('gta',gta_model,infer_gta),('yolopv2',lambda:torch.jit.load(str(assets/'yolopv2.pt'),map_location='cpu').eval(),infer_yolop)]:
  target=outdir/name;target.mkdir(exist_ok=True)
  if (target/'summary.json').exists():raise ValueError('Output exists; choose new output')
  model=load();warm=cv2.imdecode(np.frombuffer((root/selected[0]['file']).read_bytes(),np.uint8),cv2.IMREAD_COLOR)
  with torch.inference_mode():
   for _ in range(2):fn(model,warm)
   rows=[]
   for index,sample in enumerate(selected):
    data=(root/sample['file']).read_bytes();start=time.perf_counter();image=cv2.imdecode(np.frombuffer(data,np.uint8),cv2.IMREAD_COLOR);road,obstacle,ego,boxes=fn(model,image)
    payload={'gridWidth':128,'gridHeight':128,'road':grid(road),'obstacle':grid(obstacle),'ego':grid(ego),'vehicles':boxes};elapsed=(time.perf_counter()-start)*1000
    payload.update(file=sample['file'],analysis_ms=elapsed);(target/(sample['file']+'.json')).write_text(json.dumps(payload))
    rows.append({'file':sample['file'],'analysis_ms':elapsed});print(json.dumps({'model':name,'completed':index+1,'total':len(selected),'ms':round(elapsed,1)}),flush=True)
    if index in [2,6,25,37]:
     paint=image.copy();paint[road.astype(bool)]=(0,180,0);paint[obstacle.astype(bool)]=(0,0,255);paint[ego.astype(bool)]=(255,0,255)
     cv2.imencode('.jpg',cv2.addWeighted(image,.6,paint,.4,0))[1].tofile(str(target/(sample['file']+'.overlay.jpg')))
  summary[name]={'backend':'PyTorch CPU float32','threads':3,'warmup':2,'rows':rows};(target/'summary.json').write_text(json.dumps(summary[name],indent=2));del model
 (outdir/'candidate-summary.json').write_text(json.dumps(summary,indent=2))
