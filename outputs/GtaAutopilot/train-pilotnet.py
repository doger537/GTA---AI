"""PilotNet backbone with categorical heads for measured keyboard labels. Offline only."""
import argparse, copy, json, time
from pathlib import Path
import torch
from torch import nn
from torch.nn import functional as F
from ablation_train import load_cache, balance, evaluate, metrics, score, ExportModel, write_json, KEYS

class PilotNet(nn.Module):
    def __init__(self):
        super().__init__()
        self.conv=nn.Sequential(nn.Conv2d(4,24,5,2),nn.ELU(),nn.Conv2d(24,36,5,2),nn.ELU(),nn.Conv2d(36,48,5,2),nn.ELU(),nn.Conv2d(48,64,3),nn.ELU(),nn.Conv2d(64,64,3),nn.ELU(),nn.Dropout(.5))
        self.dense=nn.Sequential(nn.Flatten(),nn.Linear(1152,100),nn.ELU(),nn.Linear(100,50),nn.ELU(),nn.Linear(50,10),nn.ELU())
        self.heads=nn.ModuleList([nn.Linear(10,n) for n in [3,3,2]])
    def forward(self,x):
        x=self.dense(self.conv(x))
        return tuple(h(x) for h in self.heads)

def train(cache,out,epochs):
    out=Path(out)
    if out.exists():raise ValueError('Use a new experiment directory')
    tr,x,y,labels=load_cache(Path(cache)/'train');va,vx,vy,_=load_cache(Path(cache)/'validation')
    if tr.get('camera_profile','legacy_rear_unverified')!=va.get('camera_profile','legacy_rear_unverified'):raise ValueError('Do not mix camera profiles')
    if tr['source_session']==va['source_session'] or tr['input']!=dict(width=200,height=66,history=4,channels=4) or va['input']!=tr['input']:raise ValueError('Invalid PilotNet input or session split')
    out.mkdir(parents=True);(out/'epochs').mkdir()
    cfg=dict(architecture='pilotnet-categorical-v1',vision='pilotnet-gray-v1',input=tr['input'],target_keys=KEYS,traits=tr['traits'],source_dataset=tr['source_dataset'],source_session=tr['source_session'],validation_dataset=va['source_dataset'],validation_session=va['source_session'],camera_profile='legacy_rear_unverified',exposure_augmentation=False,driving_enabled=False,label_semantics='Measured keyboard categories, not measured analog steering angles',normalization='Node packs pixels /127.5 -1; model does not normalize twice')
    cfg['camera_profile']=tr.get('camera_profile','legacy_rear_unverified')
    write_json(out/'config.json',cfg);torch.manual_seed(42);model=PilotNet();opt=torch.optim.Adam(model.parameters(),lr=.0003);weights=[balance(labels[:,k],n) for k,n in enumerate([3,3,2])]
    gen=torch.Generator().manual_seed(42);history=[];best=None;begin=time.perf_counter()
    for epoch in range(1,epochs+1):
        model.train();order=torch.randperm(len(x),generator=gen);total=0
        for start in range(0,len(x),16):
            idx=order[start:start+16];opt.zero_grad();groups=model(x[idx]);loss=sum((F.cross_entropy(g,labels[idx,k],reduction='none')*weights[k][labels[idx,k]]).mean() for k,g in enumerate(groups));loss.backward();opt.step();total+=float(loss.detach())*len(idx)
        val,_=evaluate(model,vx,vy);row=dict(epoch=epoch,loss=total/len(x),validation=val,elapsed_s=time.perf_counter()-begin);history.append(row);torch.save(model.state_dict(),out/'epochs'/f'epoch-{epoch:03}.pt')
        if best is None or score(val)>score(best['validation']):best=copy.deepcopy(row);torch.save(model.state_dict(),out/'best.pt')
        write_json(out/'history.json',history);print(json.dumps(dict(epoch=epoch,loss=row['loss'],validation_exact=val['exact_match'],turn_brake_f1=score(val)[0],elapsed_s=row['elapsed_s'])),flush=True)
    model.load_state_dict(torch.load(out/'best.pt',weights_only=True));tm,_=evaluate(model,x,y);vm,_=evaluate(model,vx,vy);majority=(y.float().mean(0)>.5).long().expand(len(vy),-1)
    write_json(out/'report.json',dict(**cfg,epochs=epochs,best_epoch=best['epoch'],training_s=time.perf_counter()-begin,training=tm,validation=vm,majority_baseline=metrics(vy,majority),selection='Development mean F1 A/S/D then exact match; no protected session used',limitations=['No analog labels or hood-camera demonstrations','No GPS or obstacle avoidance guarantee','Offline matching is not driving quality']))
    export=ExportModel(model).eval();torch.onnx.export(export,vx[:1],str(out/'model.onnx'),input_names=['frames'],output_names=['steering','pedals','handbrake'],dynamic_axes={n:{0:'batch'} for n in ['frames','steering','pedals','handbrake']},opset_version=17,dynamo=False)
    with torch.no_grad():ref=[g[0].tolist() for g in export(vx[:1])]
    write_json(out/'onnx-reference.json',dict(source_example=0,groups=ref))

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('cache');p.add_argument('output');p.add_argument('--epochs',type=int,default=5);args=p.parse_args()
    if not 1<=args.epochs<=50:raise ValueError('Invalid epoch count')
    torch.set_num_threads(2);torch.set_num_interop_threads(1);torch.use_deterministic_algorithms(True);train(args.cache,args.output,args.epochs)
