import sys as _project_sys
from pathlib import Path as _ProjectPath
_project_sys.path.insert(0, str(_ProjectPath(__file__).resolve().parents[2]))
"""Diagnose fixed GTA ONNX detections on five source-reviewed frames, offline only."""
import argparse,pathlib,json,sys,importlib.util,hashlib
p=argparse.ArgumentParser();p.add_argument('--protocol',required=True);p.add_argument('--assets',required=True);p.add_argument('--model',required=True);p.add_argument('--output',required=True);a=p.parse_args();out=pathlib.Path(a.output);out.mkdir(parents=True,exist_ok=False);protocol=json.loads(pathlib.Path(a.protocol).read_text());rows=protocol['rows'];old=sys.argv;sys.argv=[old[0],'--assets',a.assets,'--recording',rows[0]['root'],'--output',a.output]
spec=importlib.util.spec_from_file_location('candidate',pathlib.Path(__file__).parent.joinpath('compare-pretrained-candidates.py'));c=importlib.util.module_from_spec(spec);spec.loader.exec_module(c);sys.argv=old;sys.path.insert(0,str(pathlib.Path(a.assets)/'ort-packages'))
import onnxruntime as ort
opt=ort.SessionOptions();opt.enable_mem_pattern=False;opt.execution_mode=ort.ExecutionMode.ORT_SEQUENTIAL;opt.intra_op_num_threads=3;s=ort.InferenceSession(a.model,sess_options=opt,providers=['DmlExecutionProvider']);s.disable_fallback();results=[]
for f in rows:
 data=(pathlib.Path(f['root'])/f['file']).read_bytes();assert hashlib.sha256(data).hexdigest()==f['sha256'];im=c.cv2.imdecode(c.np.frombuffer(data,c.np.uint8),c.cv2.IMREAD_COLOR);h,w=im.shape[:2];r=min(640/w,640/h);rw,rh=round(w*r),round(h*r);left=(640-rw)//2;top=(640-rh)//2;raw=[]
 def adapter(x):
  values=s.run(None,{'images':x.numpy()});raw.extend(v.copy() for v in values);return c.torch.from_numpy(values[0]),[c.torch.from_numpy(values[1])]
 with c.torch.inference_mode():res=c.infer_gta(adapter,im)
 payload=dict(zip(['road','obstacle','ego'],[c.grid(x) for x in res[:3]]),gridWidth=128,gridHeight=128,vehicles=res[3]);(out/('truck-sequence-'+f['file']+'.json')).write_text(json.dumps(payload))
 pred=raw[0][0].T;rect=f['truck_patch'];cx=(rect[0]+rect[2])/2;cy=(rect[1]+rect[3])/2;diagnostic=[]
 for cls in [0,1,2,3,4]:
  candidates=[]
  for v in pred:
   x1=(float(v[0]-v[2]/2)-left)/r/w;y1=(float(v[1]-v[3]/2)-top)/r/h;x2=x1+float(v[2])/r/w;y2=y1+float(v[3])/r/h
   if x1<=cx<=x2 and y1<=cy<=y2:candidates.append({'score':float(v[4+cls]),'box':[x1,y1,x2,y2]})
  diagnostic.append({'class_id':cls,'top_containing_patch_center':sorted(candidates,key=lambda b:b['score'],reverse=True)[:3]})
 indices=[y*128+x for y in range(128) for x in range(128) if rect[0]<=(x+.5)/128<rect[2] and rect[1]<=(y+.5)/128<rect[3]]
 results.append({'file':f['file'],'truck_patch':rect,'cells':len(indices),'road':sum(payload['road'][i] for i in indices),'obstacle':sum(payload['obstacle'][i] for i in indices),'vehicles_containing_center':[b for b in payload['vehicles'] if b['x']<=cx<=b['x']+b['w'] and b['y']<=cy<=b['y']+b['h']],'raw_scores':diagnostic});print(f['file'],flush=True)
(out/'diagnostic.json').write_text(json.dumps({'protocol':protocol,'results':results,'warning':'Raw bbox containment is a diagnostic, not proof of matching the truck or an evaluated detector threshold. Defaults unchanged.'},indent=2))
