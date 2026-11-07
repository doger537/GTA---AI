import sys as _project_sys
from pathlib import Path as _ProjectPath
_project_sys.path.insert(0, str(_ProjectPath(__file__).resolve().parents[2]))
"""Offline GTA ONNX inference for a frozen source-image review protocol."""
import argparse,pathlib,json,sys,importlib.util,hashlib
p=argparse.ArgumentParser();p.add_argument('--annotations',required=True);p.add_argument('--assets',required=True);p.add_argument('--model',required=True);p.add_argument('--output',required=True);a=p.parse_args();out=pathlib.Path(a.output);out.mkdir(parents=True,exist_ok=False)
rows=json.loads(pathlib.Path(a.annotations).read_text(encoding='utf-8'))['rows'];argv=sys.argv;sys.argv=[argv[0],'--assets',a.assets,'--recording',rows[0]['root'],'--output',a.output]
spec=importlib.util.spec_from_file_location('candidate',pathlib.Path(__file__).parent.joinpath('compare-pretrained-candidates.py'));c=importlib.util.module_from_spec(spec);spec.loader.exec_module(c);sys.argv=argv;sys.path.insert(0,str(pathlib.Path(a.assets)/'ort-packages'))
import onnxruntime as ort
opt=ort.SessionOptions();opt.enable_mem_pattern=False;opt.execution_mode=ort.ExecutionMode.ORT_SEQUENTIAL;opt.intra_op_num_threads=3
assert 'DmlExecutionProvider' in ort.get_available_providers()
session=ort.InferenceSession(a.model,sess_options=opt,providers=['DmlExecutionProvider']);session.disable_fallback()
for f in rows:
 data=(pathlib.Path(f['root'])/f['file']).read_bytes();assert hashlib.sha256(data).hexdigest()==f['sha256']
 def model(x):
  det,proto=session.run(None,{'images':x.numpy()});return c.torch.from_numpy(det),[c.torch.from_numpy(proto)]
 with c.torch.inference_mode():
  image=c.cv2.imdecode(c.np.frombuffer(data,c.np.uint8),c.cv2.IMREAD_COLOR);road,obstacle,ego,boxes=c.infer_gta(model,image)
 payload={'gridWidth':128,'gridHeight':128,'road':c.grid(road),'obstacle':c.grid(obstacle),'ego':c.grid(ego),'vehicles':boxes}
 (out/(f['set']+'-'+f['file']+'.json')).write_text(json.dumps(payload));print(f['set']+' '+f['file'],flush=True)
