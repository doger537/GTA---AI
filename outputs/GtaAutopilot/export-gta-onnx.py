"""Offline GTA export/parity/DirectML experiment. Never imports game or input code.
Reuses the exact saved comparison preprocessing/postprocessing via its model adapter.
"""
import argparse, pathlib, sys, json, time, hashlib, importlib.util
p=argparse.ArgumentParser();p.add_argument('--assets',required=True);p.add_argument('--recording',required=True);p.add_argument('--output',required=True);a=p.parse_args()
assets=pathlib.Path(a.assets);out=pathlib.Path(a.output);out.mkdir(parents=True,exist_ok=False)
# Adapter parses the same CLI; its experiment loop is guarded against import.
spec=importlib.util.spec_from_file_location('candidate',pathlib.Path(__file__).with_name('compare-pretrained-candidates.py'));c=importlib.util.module_from_spec(spec);spec.loader.exec_module(c)
sys.path.insert(0,str(assets/'ort-packages'))
import onnx, onnxruntime as ort
np,torch,cv2=c.np,c.torch,c.cv2
manifest=json.loads((assets/'experiment-manifest.json').read_text());frames=manifest['frames']
root=pathlib.Path(a.recording)
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
assert sha(assets/'gta_segment.pt')=='972d4ceac2a6c1e9169ba84d141bdbcd57f5f65d80a963918cb0ba7dd375bf3b'
for f in frames:assert sha(root/f['file'])==f['sha256']
protocol={'frames':frames,'opset':17,'shape':[1,3,640,640],'dtype':'float32','warmup':2,'passes':3,'threads':3,'raw_atol':1e-3,'raw_rtol':1e-4,'mask_max_disagreement':0.001,'box_atol':1e-4,'note':'criteria registered before measurements; masks compared at native and 128 grid resolution; numerical parity is not driving validation'}
(out/'protocol.json').write_text(json.dumps(protocol,indent=2))
model=c.gta_model()
class Export(torch.nn.Module):
 def __init__(self,m):super().__init__();self.m=m
 def forward(self,x):
  y=self.m(x);return y[0],y[1][-1]
wrapped=Export(model).eval()
def prep(im):
 h,w=im.shape[:2];r=min(640/w,640/h);rw,rh=round(w*r),round(h*r);l=(640-rw)//2;t=(640-rh)//2
 return c.tensor(cv2.copyMakeBorder(cv2.resize(im,(rw,rh)),t,640-rh-t,l,640-rw-l,cv2.BORDER_CONSTANT,value=(114,114,114)))
# Reuse original postprocessor unchanged by supplying raw outputs through a callable.
def post(raw,im):return c.infer_gta(lambda _: (torch.from_numpy(raw[0]),[torch.from_numpy(raw[1])]),im)
def payload(result):
 return dict(zip(['road','obstacle','ego'],[c.grid(m) for m in result[:3]]),vehicles=result[3])
images=[(root/f['file']).read_bytes() for f in frames]
with torch.inference_mode():
 x=prep(cv2.imdecode(np.frombuffer(images[0],np.uint8),cv2.IMREAD_COLOR));wrapped(x)
 torch.onnx.export(wrapped,x,str(out/'gta.onnx'),opset_version=17,input_names=['images'],output_names=['detections','prototypes'],dynamo=False)
 onnx.checker.check_model(str(out/'gta.onnx'),full_check=True)
 refs=[]
 for f,data in zip(frames,images):
  im=cv2.imdecode(np.frombuffer(data,np.uint8),cv2.IMREAD_COLOR);raw=[t.numpy() for t in wrapped(prep(im))];res=post(raw,im);saved=json.loads((assets/'results/gta'/(f['file']+'.json')).read_text())
  assert all(payload(res)[k]==saved[k] for k in ['road','obstacle','ego','vehicles']), 'PyTorch baseline drift'
  refs.append((raw,res));print('reference '+f['file'],flush=True)
summary={'protocol':protocol,'onnx_sha256':sha(out/'gta.onnx'),'checkpoint_sha256':sha(assets/'gta_segment.pt'),'versions':{'torch':torch.__version__,'onnx':onnx.__version__,'ort':ort.__version__},'providers_available':ort.get_available_providers(),'backends':{}}
for backend in ['CPUExecutionProvider','DmlExecutionProvider']:
 if backend not in ort.get_available_providers():raise RuntimeError('Missing '+backend)
 opt=ort.SessionOptions();opt.intra_op_num_threads=3;opt.inter_op_num_threads=1;opt.enable_mem_pattern=False;opt.execution_mode=ort.ExecutionMode.ORT_SEQUENTIAL;opt.enable_profiling=True;opt.profile_file_prefix=str(out/backend)
 session=ort.InferenceSession(str(out/'gta.onnx'),sess_options=opt,providers=[backend]);session.disable_fallback()
 def run(data):
  t=time.perf_counter();im=cv2.imdecode(np.frombuffer(data,np.uint8),cv2.IMREAD_COLOR);x=prep(im).numpy();pre=time.perf_counter();raw=session.run(None,{'images':x});infer=time.perf_counter();res=post(raw,im);pay=payload(res);end=time.perf_counter()
  return raw,res,pay,{'analysis_ms':(end-t)*1000,'inference_ms':(infer-pre)*1000}
 for _ in range(2):run(images[0])
 rows=[];parity=[]
 for repeat in range(3):
  for i,(f,data) in enumerate(zip(frames,images)):
   raw,res,pay,timing=run(data);rows.append(dict(file=f['file'],repeat=repeat,**timing))
   if repeat==0:
    rr,rs=refs[i];diff=[float(np.max(np.abs(v-r))) for v,r in zip(raw,rr)];close=[bool(np.allclose(v,r,atol=1e-3,rtol=1e-4)) for v,r in zip(raw,rr)];masks=[float(np.mean(v!=r)) for v,r in zip(res[:3],rs[:3])];grid=[sum(v!=r for v,r in zip(c.grid(vv),c.grid(rrr)))/16384 for vv,rrr in zip(res[:3],rs[:3])]
    boxes=len(res[3])==len(rs[3]) and all(b['class_id']==r['class_id'] and all(abs(b[k]-r[k])<=1e-4 for k in ['x','y','w','h','score']) for b,r in zip(res[3],rs[3]))
    parity.append(dict(file=f['file'],raw_max_abs=diff,raw_allclose=close,native_mask_disagreement=masks,grid_mask_disagreement=grid,boxes_close=boxes,passed=all(close) and max(masks+grid)<=.001 and boxes))
    (out/(backend+'-'+f['file']+'.json')).write_text(json.dumps(pay))
  print(backend+' pass '+str(repeat+1),flush=True)
 profile=session.end_profiling();events=json.loads(pathlib.Path(profile).read_text());providers={}
 for e in events:
  provider=e.get('args',{}).get('provider')
  if provider:providers[provider]=providers.get(provider,0)+1
 summary['backends'][backend]={'session_providers':session.get_providers(),'profile_provider_events':providers,'rows':rows,'parity':parity,'passed':all(r['passed'] for r in parity),'latency':{k:{'p50':float(np.percentile([r[k] for r in rows],50)),'p95':float(np.percentile([r[k] for r in rows],95))} for k in ['analysis_ms','inference_ms']}}
 (out/'summary.json').write_text(json.dumps(summary,indent=2));del session
print(json.dumps({k:{'passed':v['passed'],'latency':v['latency'],'profile':v['profile_provider_events']} for k,v in summary['backends'].items()},indent=2))
