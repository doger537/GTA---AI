import sys as _project_sys
from pathlib import Path as _ProjectPath
_project_sys.path.insert(0, str(_ProjectPath(__file__).resolve().parents[2]))
import unittest
import torch
from training.ablation_train import Controls,decode,augment_exposure,score,metrics

class Checks(unittest.TestCase):
    def test_decoding_never_conflicts(self):
        for s in range(3):
            for p in range(3):
                for h in range(2):
                    groups=[torch.nn.functional.one_hot(torch.tensor([i]),n).float() for i,n in zip([s,p,h],[3,3,2])]
                    y=decode(groups)[0];self.assertFalse(y[0] and y[2]);self.assertFalse(y[1] and y[3])
    def test_input_shapes(self):
        for h,w,c in [(45,80,12),(72,128,12),(72,128,4)]:
            m=Controls(dict(height=h,width=w,channels=c));out=m(torch.zeros(2,c,h,w));self.assertEqual([list(x.shape) for x in out],[[2,3],[2,3],[2,2]])
    def test_augmentation_has_no_fake_motion_and_preserves_mask(self):
        meta=dict(input=dict(width=128,height=72),traits=dict(motion=True,mask=True))
        x=torch.zeros(2,4,72,128)
        a=augment_exposure(x,meta,torch.Generator().manual_seed(42));b=augment_exposure(x,meta,torch.Generator().manual_seed(42))
        self.assertTrue(torch.equal(a,b));self.assertTrue(torch.all(a[:,1:]==0));self.assertTrue(torch.allclose(a[:,0,70,64],torch.full((2,),128/127.5-1)))
        self.assertTrue(torch.all(x==0))
    def test_selection_cannot_win_on_gas_alone(self):
        low={'per_key':[{'f1':1},{'f1':0},{'f1':0},{'f1':0}], 'exact_match':1}
        high={'per_key':[{'f1':.5},{'f1':.2},{'f1':.2},{'f1':.2}], 'exact_match':.1}
        self.assertGreater(score(high),score(low))
    def test_no_positive_action_has_no_fictitious_recall(self):
        r=metrics(torch.zeros(2,6).long(),torch.zeros(2,6).long());self.assertEqual(r['exact_match'],1);self.assertIsNone(r['per_key'][1]['recall'])

if __name__=='__main__':
    torch.set_num_threads(2);unittest.main()
