"""Synthetic image-error reference pretraining. No GTA action labels are invented."""
import json,time
from pathlib import Path
import numpy as np
import torch
from torch import nn

def reference(x):
    return ((.8*x[:,0]+1.2*x[:,1]+.2*x[:,3])/(1+.3*x[:,2])).clamp(-.7,.7).unsqueeze(1)

def main():
    torch.set_num_threads(2);torch.manual_seed(21)
    out=Path(__file__).parent/'trained'/'geometry-guidance-v1'
    if out.exists():raise ValueError('Output exists; preserve previous model')
    out.mkdir(parents=True)
    model=nn.Sequential(nn.Linear(4,32),nn.Tanh(),nn.Linear(32,16),nn.Tanh(),nn.Linear(16,1),nn.Tanh())
    g=torch.Generator().manual_seed(21);x=torch.rand(16000,4,generator=g)*2-1;x[:,2]=(x[:,2]+1)/2;y=reference(x)
    vx=torch.rand(4000,4,generator=g)*2-1;vx[:,2]=(vx[:,2]+1)/2;vy=reference(vx)
    opt=torch.optim.Adam(model.parameters(),lr=.002);start=time.perf_counter()
    for epoch in range(16):
        for i in range(0,len(x),128):
            opt.zero_grad();loss=(model(x[i:i+128])-y[i:i+128]).square().mean();loss.backward();opt.step()
    model.eval()
    with torch.no_grad():pred=model(vx);mae=float((pred-vy).abs().mean());maximum=float((pred-vy).abs().max())
    if mae>.04:raise ValueError('Synthetic reference fit failed')
    torch.save(model.state_dict(),out/'weights.pt')
    torch.onnx.export(model,vx[:1],str(out/'model.onnx'),input_names=['geometry_state'],output_names=['steer'],opset_version=17,dynamo=False,dynamic_axes={'geometry_state':{0:'batch'},'steer':{0:'batch'}})
    fixtures=[[0,-.3,.2,0],[0,0,.2,0],[0,.3,.2,0]]
    with torch.no_grad():values=model(torch.tensor(fixtures)).flatten().tolist()
    report=dict(training_source='synthetic signed image-path errors; hand-specified reference function',training_examples=len(x),test_examples=len(vx),mae=mae,max_error=maximum,training_s=time.perf_counter()-start,features=['near_offset','far_offset','speed_kmh_div_120','curvature'],fixtures=fixtures,fixture_predictions=values,driving_enabled=False,limitations=['Not trained or calibrated on GTA steering response','Synthetic fit is not driving accuracy','No braking policy, metric clearance or GPS planner'])
    (out/'report.json').write_text(json.dumps(report,indent=2),encoding='utf-8');print(json.dumps(report),flush=True)

if __name__=='__main__':main()
