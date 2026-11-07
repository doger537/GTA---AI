import sys as _project_sys
from pathlib import Path as _ProjectPath
_project_sys.path.insert(0, str(_ProjectPath(__file__).resolve().parents[1]))
"""CPU-only offline comparison. Uses Node-exported features, never GTA inputs."""
import argparse, copy, json, math, time
from pathlib import Path
import numpy as np
import torch
from torch import nn
from torch.nn import functional as F

KEYS = ['w', 'a', 's', 'd', 'space', 'shift']
PROFILES = ['rgb-v1','rgb-hi-v1','gray-stack-v1','gray-mask-v1','gray-contrast-v1','gray-delta-v1']
PROTECTED = '2026-11-02T07-43-54-725Z'

def write_json(file, value):
    Path(file).write_text(json.dumps(value, indent=2, allow_nan=False), encoding='utf-8')

def load_cache(root):
    root = Path(root)
    meta = json.loads((root/'cache.json').read_text(encoding='utf-8'))
    shape = meta['shape']
    if meta['source_session'] == PROTECTED:
        raise ValueError('Protected recording may not be used in this search')
    if (root/'input.f32').stat().st_size != math.prod(shape)*4:
        raise ValueError('Incomplete feature cache')
    raw = np.memmap(root/'input.f32', dtype='<f4', mode='c', shape=tuple(shape))
    x = torch.from_numpy(raw).permute(0,3,1,2).contiguous()
    y = torch.tensor(meta['targets'], dtype=torch.long)
    if y.shape != (shape[0],6) or not torch.all((y==0)|(y==1)) or torch.any(y[:,0]&y[:,2]) or torch.any(y[:,1]&y[:,3]) or torch.any(y[:,5]):
        raise ValueError('Invalid control labels')
    labels = torch.stack([y[:,1]+2*y[:,3],y[:,0]+2*y[:,2],y[:,4]],1)
    return meta, x, y, labels

def same_pad(h,w,k,s):
    ph=max(0,(math.ceil(h/s)-1)*s+k-h);pw=max(0,(math.ceil(w/s)-1)*s+k-w)
    return (pw//2,pw-pw//2,ph//2,ph-ph//2)

class Controls(nn.Module):
    def __init__(self, spec):
        super().__init__()
        h,w,c=spec['height'],spec['width'],spec['channels']
        self.pad1=same_pad(h,w,5,4);h=math.ceil(h/4);w=math.ceil(w/4)
        self.pad2=same_pad(h,w,3,2);h=math.ceil(h/2);w=math.ceil(w/2)
        self.conv1=nn.Conv2d(c,8,5,4);self.conv2=nn.Conv2d(8,12,3,2)
        self.dense=nn.Linear(h*w*12,32);self.heads=nn.ModuleList([nn.Linear(32,n) for n in [3,3,2]])
        for i,layer in enumerate([self.conv1,self.conv2,self.dense,*self.heads]):
            torch.manual_seed(43+i);nn.init.xavier_uniform_(layer.weight);nn.init.zeros_(layer.bias)
    def forward(self,x):
        x=F.relu(self.conv1(F.pad(x,self.pad1)));x=F.relu(self.conv2(F.pad(x,self.pad2)))
        x=F.relu(self.dense(x.flatten(1)))
        return tuple(h(x) for h in self.heads)

class ExportModel(nn.Module):
    def __init__(self,model):
        super().__init__();self.model=model
    def forward(self,x):
        return tuple(F.softmax(y,dim=1) for y in self.model(x))

def mask_for(spec):
    h,w=spec['height'],spec['width']
    y=(torch.arange(h)+.5)/h*.55+.20;x=(torch.arange(w)+.5)/w
    yy,xx=torch.meshgrid(y,x,indexing='ij');t=(yy-.58)/.42
    return ((xx>.78)&(yy>.56))|((yy>=.58)&(xx>=.36-.06*t)&(xx<=.65+.17*t))

def augment_exposure(x,meta,generator):
    x=x.clone();n=len(x)
    enabled=(torch.rand((n,1,1,1),generator=generator)<.8).float()
    gain=1+enabled*(torch.rand((n,1,1,1),generator=generator)*1.0-.4)
    offset=enabled*(torch.rand((n,1,1,1),generator=generator)*.4-.2)
    if meta['traits']['motion']:
        x[:,0:1]=(((x[:,0:1]+1)*.5*gain+offset).clamp(0,1))*2-1
        x[:,1:]=(x[:,1:]*gain).clamp(-1,1)
    else:
        x=(((x+1)*.5*gain+offset).clamp(0,1))*2-1
    if meta['traits']['mask']:
        mask=mask_for(meta['input']);x[:,:,mask]=128/127.5-1
        if meta['traits']['motion']:x[:,1:,mask]=0
    return x

def decode(groups):
    s,p,h=[g.argmax(1) for g in groups]
    return torch.stack([p==1,s==1,p==2,s==2,h==1,torch.zeros_like(s,dtype=torch.bool)],1).long()

def metrics(y,p):
    per=[]
    for k,name in enumerate(KEYS):
        a=y[:,k].bool();b=p[:,k].bool()
        tp=int((a&b).sum());fp=int((~a&b).sum());fn=int((a&~b).sum());tn=int((~a&~b).sum())
        per.append(dict(key=name,positive_examples=tp+fn,tp=tp,fp=fp,fn=fn,tn=tn,precision=tp/(tp+fp) if tp+fp else None,recall=tp/(tp+fn) if tp+fn else None,f1=2*tp/(2*tp+fp+fn) if tp+fn else None))
    supported=[v['f1'] for v in per if v['f1'] is not None]
    return dict(samples=len(y),exact_match=float((y==p).all(1).float().mean()),macro_f1_supported=sum(supported)/len(supported) if supported else None,per_key=per)

def score(result):
    # Predeclared development criterion prioritizes steering and brake over W.
    vals=[result['per_key'][k]['f1'] for k in [1,2,3] if result['per_key'][k]['f1'] is not None]
    return (sum(vals)/len(vals) if vals else 0,result['exact_match'])

@torch.no_grad()
def evaluate(model,x,y):
    model.eval();pred=[]
    for start in range(0,len(x),64):pred.append(decode(model(x[start:start+64])))
    p=torch.cat(pred);return metrics(y,p),p

def balance(labels,classes):
    counts=torch.bincount(labels,minlength=classes).float()
    raw=torch.where(counts>0,(len(labels)/(classes*counts.clamp_min(1))).sqrt().clamp_max(4),0)
    return raw/((raw*counts).sum()/len(labels))

def train_run(cache_root,profile,out,epochs,aug=False):
    out=Path(out);out.mkdir(parents=True,exist_ok=True);(out/'epochs').mkdir(exist_ok=True)
    tr,x,y,labels=load_cache(Path(cache_root)/profile/'train');va,vx,vy,_=load_cache(Path(cache_root)/profile/'validation')
    if tr['source_session']==va['source_session']:raise ValueError('Sessions must differ')
    cfg=dict(architecture='torch-categorical-controls-v1',vision=profile,input=tr['input'],traits=tr['traits'],heads=dict(steering=['straight','left','right'],pedals=['coast','accelerate','brake_or_reverse'],handbrake=['released','held']),target_keys=KEYS,source_dataset=tr['source_dataset'],source_session=tr['source_session'],validation_dataset=va['source_dataset'],validation_session=va['source_session'],seed=42,exposure_augmentation=aug,driving_enabled=False,backend='PyTorch CPU',torch_version=torch.__version__,threads=torch.get_num_threads())
    write_json(out/'config.json',cfg)
    model=Controls(tr['input']);optimizer=torch.optim.Adam(model.parameters(),lr=.001)
    weights=[balance(labels[:,k],n) for k,n in enumerate([3,3,2])]
    order=torch.randperm(len(x),generator=torch.Generator().manual_seed(42));generator=torch.Generator().manual_seed(105)
    best=None;history=[];begin=time.perf_counter()
    for epoch in range(1,epochs+1):
        model.train();loss_sum=0
        for start in range(0,len(x),16):
            idx=order[start:start+16];batch=x[idx]
            if aug:batch=augment_exposure(batch,tr,generator)
            optimizer.zero_grad();outputs=model(batch)
            loss=sum((F.cross_entropy(g,labels[idx,k],reduction='none')*weights[k][labels[idx,k]]).mean() for k,g in enumerate(outputs))
            if not torch.isfinite(loss):raise ValueError('Nonfinite loss')
            loss.backward();optimizer.step();loss_sum+=float(loss.detach())*len(idx)
        result,_=evaluate(model,vx,vy)
        row=dict(epoch=epoch,loss=loss_sum/len(x),validation=result,elapsed_s=time.perf_counter()-begin)
        history.append(row);torch.save(model.state_dict(),out/'epochs'/f'epoch-{epoch:03}.pt')
        if best is None or score(result)>score(best['validation']):
            best=copy.deepcopy(row);torch.save(model.state_dict(),out/'best.pt')
        write_json(out/'history.json',history)
        print(json.dumps(dict(profile=profile,augmentation=aug,epoch=epoch,loss=row['loss'],turn_brake_f1=score(result)[0],exact=result['exact_match'],elapsed_s=row['elapsed_s'])),flush=True)
    model.load_state_dict(torch.load(out/'best.pt',weights_only=True));train_metrics,_=evaluate(model,x,y);val_metrics,pred=evaluate(model,vx,vy)
    majority=(y.float().mean(0)>.5).long().expand(len(vy),-1)
    report=dict(**cfg,best_epoch=best['epoch'],epochs_completed=len(history),selection='mean validation F1 for A/S/D; exact match breaks ties; protected session never used',training_s=time.perf_counter()-begin,train_samples=len(x),validation_samples=len(vx),training=train_metrics,validation=val_metrics,majority_baseline=metrics(vy,majority),class_weights=[w.tolist() for w in weights],conflicts=int(((pred[:,0]&pred[:,2])|(pred[:,1]&pred[:,3])).sum()),limitations=['Development validation has been inspected in prior experiments','CPU framework/init differs from old TensorFlow.js runs; compare new runs to new baseline','Offline button matching does not establish driving quality','S includes braking and reverse'])
    exported=ExportModel(model).eval();probe=vx[:1]
    torch.onnx.export(exported,probe,str(out/'model.onnx'),input_names=['frames'],output_names=['steering','pedals','handbrake'],dynamic_axes={'frames':{0:'batch'},'steering':{0:'batch'},'pedals':{0:'batch'},'handbrake':{0:'batch'}},opset_version=17,dynamo=False)
    with torch.no_grad():reference=[g[0].tolist() for g in exported(probe)]
    write_json(out/'onnx-reference.json',dict(source_example=0,groups=reference))
    write_json(out/'report.json',report);return report

def main():
    p=argparse.ArgumentParser();p.add_argument('cache');p.add_argument('output');p.add_argument('--epochs',type=int,default=8);args=p.parse_args()
    if not 1<=args.epochs<=100:raise ValueError('epochs must be 1..100')
    torch.set_num_threads(2);torch.set_num_interop_threads(1);torch.use_deterministic_algorithms(True)
    root=Path(args.output)
    if root.exists() and any(root.iterdir()):raise ValueError('Output directory must be new or empty; previous experiments are preserved')
    root.mkdir(parents=True,exist_ok=True)
    protocol=dict(profiles=PROFILES,epochs=args.epochs,training='2026-11-01T17-32-01-342Z',development_validation='2026-11-01T16-49-20-088Z',protected_session=PROTECTED,selection='mean development F1 for A/S/D, then exact match',notes='Every profile is trained from scratch; selected profile gets one separate exposure-augmentation run. No protected-session selection.')
    write_json(root/'protocol.json',protocol);reports=[]
    for profile in PROFILES:
        reports.append(train_run(args.cache,profile,root/profile,args.epochs));write_json(root/'comparison.json',reports)
    winner=max(reports,key=lambda r:score(r['validation']))
    augmented=train_run(args.cache,winner['vision'],root/(winner['vision']+'-exposure'),args.epochs,True)
    reports.append(augmented);write_json(root/'comparison.json',reports)
    selected=max([winner,augmented],key=lambda r:score(r['validation']))
    selected_name=selected['vision']+('-exposure' if selected['exposure_augmentation'] else '')
    write_json(root/'selection.json',dict(directory=selected_name,criterion=protocol['selection'],protected_session_used=False,driving_enabled=False))
    print(json.dumps(dict(phase='done',selected=selected_name)),flush=True)

if __name__=='__main__':main()
