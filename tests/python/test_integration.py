import sys as _project_sys
from pathlib import Path as _ProjectPath
_project_sys.path.insert(0, str(_ProjectPath(__file__).resolve().parents[2]))
import importlib.util,unittest,ctypes
from unittest.mock import patch
from pathlib import Path
import torch
from packages.actuation.gamepad_backend import AnalogController,MockPad
from packages.actuation.xinput_readback import initialize_neutral,read_state,_xinput_api,State
spec=importlib.util.spec_from_file_location('pilot',Path(__file__).parent.joinpath('../../training/train-pilotnet.py'));pilot=importlib.util.module_from_spec(spec);spec.loader.exec_module(pilot)

class Integration(unittest.TestCase):
    def test_xinput_function_binding_is_cached_but_states_are_fresh(self):
        class Function:
            calls=0
            def __call__(self,slot,pointer):
                self.calls+=1
                state=ctypes.cast(pointer,ctypes.POINTER(State)).contents
                state.packet=self.calls;state.gamepad.left_x=slot
                return 0
        class Library:
            XInputGetState=Function()
        _xinput_api.cache_clear()
        try:
            with patch('packages.actuation.xinput_readback.ctypes.WinDLL',return_value=Library()) as loader:
                a=read_state(1);b=read_state(2)
                self.assertEqual(loader.call_count,1)
                self.assertEqual((a['packet'],b['packet']),(1,2))
                self.assertEqual((a['values']['left_x'],b['values']['left_x']),(1,2))
        finally:_xinput_api.cache_clear()
    def test_initial_neutral_is_not_primed_unnecessarily(self):
        pad=MockPad();state=dict(error=0,values=dict(left_x=0,right_trigger=0))
        r=initialize_neutral(pad,slot=0,read=lambda _:state,sleep=lambda _:None);self.assertFalse(r['initialization_step_used'])
        self.assertTrue(all(name in ['reset','update'] for name,_ in pad.calls))
    def test_initial_nonzero_driver_axes_are_primed_and_verified(self):
        class Pad(MockPad):
            def left_joystick(self,**kw):self.calls.append(('minimum_step',kw))
        pad=Pad();states=iter([dict(error=0,values=dict(left_x=-3356)),dict(error=0,values=dict(left_x=0))])
        r=initialize_neutral(pad,slot=0,read=lambda _:next(states),sleep=lambda _:None);self.assertTrue(r['initialization_step_used']);self.assertIn(('minimum_step',dict(x_value=1,y_value=0)),pad.calls)
        self.assertTrue(all(name not in ['gas','brake'] for name,_ in pad.calls))
    def test_unconfirmed_real_neutral_refuses_startup(self):
        class Pad(MockPad):
            def left_joystick(self,**kw):pass
        with self.assertRaises(RuntimeError):initialize_neutral(Pad(),slot=0,read=lambda _:dict(error=1167,values=None),sleep=lambda _:None)
    def setup_controller(self):
        self.now=0.;self.focus=True;self.pad=MockPad();return AnalogController(self.pad,lambda:self.focus,lambda:self.now)
    def command(self,**kw):return dict(steer=.5,throttle=.3,brake=0.,duration_ms=250)|kw
    def test_slew_uses_elapsed_time(self):
        c=self.setup_controller();c.arm();c.set(self.command());self.now=.02;c.tick();self.assertAlmostEqual(c.values['steer'],.03);self.assertAlmostEqual(c.values['throttle'],.02)
        self.now=.04;c.tick();self.assertAlmostEqual(c.values['steer'],.06)
    def test_expiry_neutralizes_without_parent_and_latches(self):
        c=self.setup_controller();c.arm();c.set(self.command());self.now=.02;c.tick();self.now=.26;c.tick();self.assertFalse(c.active);self.assertEqual(c.values,dict(steer=0,throttle=0,brake=0))
        with self.assertRaises(ValueError):c.set(self.command())
    def test_no_late_heartbeat_resurrection(self):
        c=self.setup_controller();c.arm();c.set(self.command());self.now=.26
        with self.assertRaises(ValueError):c.set(self.command())
        self.assertFalse(c.active)
    def test_focus_loss_resets(self):
        c=self.setup_controller();c.arm();c.set(self.command());self.focus=False;c.tick();self.assertFalse(c.active);self.assertEqual(c.values['throttle'],0)
    def test_pedals_are_exclusive_and_brake_is_separate(self):
        c=self.setup_controller();c.arm()
        with self.assertRaises(ValueError):c.set(self.command(brake=.2))
        c.set(self.command(throttle=0,brake=.4));self.now=.02;c.tick();self.assertEqual(c.values['throttle'],0);self.assertEqual(c.values['brake'],.4);self.assertIn(('brake',{'value_float':.4}),self.pad.calls)
    def test_reject_nan_and_long_lease(self):
        c=self.setup_controller();c.arm()
        for kw in [dict(steer=float('nan')),dict(duration_ms=500),dict(throttle=True)]:
            with self.assertRaises(ValueError):c.set(self.command(**kw))
    def test_pilotnet_shape_and_dropout_eval(self):
        m=pilot.PilotNet().eval();x=torch.zeros(2,4,66,200)
        with torch.no_grad():a=m(x);b=m(x)
        self.assertEqual([list(v.shape) for v in a],[[2,3],[2,3],[2,2]]);self.assertTrue(all(torch.equal(u,v) for u,v in zip(a,b)))

if __name__=='__main__':torch.set_num_threads(2);unittest.main()
