"""Synthetic authorization/MockPad tests, no game or real device."""
import copy
import os
from pathlib import Path
import subprocess
import sys
import unittest

from packages.actuation.gamepad_backend import AnalogController, MockPad, validate_authorization


def source(sequence=1):
    return dict(sequence=sequence, generation=7, capture_start_ms=1000+sequence*50, decision_expires_ms=1250+sequence*50)


def permit(scope='command', mode='diagnostic', tag=None, command=None):
    return dict(scope=scope, mode=mode, kind='gamepad', source=tag or source(), command=None if scope=='startup' else command or dict(steer=.2, throttle=0, brake=0))


class BackendDriveGate(unittest.TestCase):
    def controller(self, purpose='diagnostic'):
        self.now=0.;self.pad=MockPad();self.checks=[]
        parent=self
        class Owner:
            requires_gate=True
            generation=7
            owner_id='synthetic-test-owner'
            def check(self, duration_ms=None, source=None):
                parent.checks.append((duration_ms, source))
                return dict(remaining_ms=duration_ms if duration_ms else 250)
            def reserve(self):
                raise AssertionError('No implicit reservation')
            def release_neutral(self):
                parent.assertEqual(parent.pad.calls[-2:],[('reset',{}),('update',{})])
                self.owner_id=None
        self.owner=Owner()
        return AnalogController(self.pad,clock=lambda:self.now,owner=self.owner,purpose=purpose)

    def test_startup_needs_authorization_and_checks_its_source(self):
        c=self.controller()
        with self.assertRaisesRegex(ValueError,'authorization required'):c.arm()
        self.assertFalse(c.active)
        c.arm(permit('startup'));self.assertEqual(self.checks[-1],(None,source()))
        self.assertTrue(c.active)

    def test_command_missing_permit_neutralizes_and_does_not_apply_axes(self):
        c=self.controller();c.arm(permit('startup'))
        with self.assertRaisesRegex(ValueError,'authorization required'):
            c.set(dict(steer=.2,throttle=0,brake=0,duration_ms=200),source())
        self.assertFalse(c.active);self.assertIsNone(self.owner.owner_id)
        self.assertFalse(any(k in ('steer','gas','brake') for k,_ in self.pad.calls))

    def test_forged_mode_command_source_and_bad_types_are_rejected(self):
        command=dict(steer=.2,throttle=0,brake=0,duration_ms=200)
        for change in ['mode','command','source','boolean','extra','startup']:
            with self.subTest(change=change):
                p=permit()
                if change=='mode':p['mode']='autonomous'
                elif change=='command':p['command']['steer']=.3
                elif change=='source':p['source']['sequence']=2
                elif change=='boolean':p['source']['sequence']=True
                elif change=='extra':p['allowed']=True
                else:p['scope']='startup'
                with self.assertRaises(ValueError):validate_authorization(p,'diagnostic','command',source(),command)

    def test_diagnostic_pedals_and_calibration_limit_are_enforced_in_backend(self):
        for mode,command in [('diagnostic',dict(steer=0,throttle=.1,brake=0)),('calibration',dict(steer=.36,throttle=0,brake=0)),('autonomous',dict(steer=0,throttle=.46,brake=0))]:
            with self.subTest(mode=mode):
                c=self.controller(mode);c.arm(permit('startup',mode))
                with self.assertRaises(ValueError):c.set(command|dict(duration_ms=200),source(),permit(mode=mode,command=command))
                self.assertFalse(c.active)

    def test_bounded_session_clips_last_command_deadline(self):
        c=self.controller('calibration');c.arm(permit('startup','calibration'))
        command=dict(steer=0,throttle=.2,brake=0)
        for i in range(17):
            self.now=i*.15
            c.set(command|dict(duration_ms=200),source(i+1),permit(mode='calibration',tag=source(i+1),command=command))
        self.assertAlmostEqual(c.deadline,2.5)
        self.now=2.501;c.tick();self.assertFalse(c.active);self.assertEqual(c.values,dict(steer=0.,throttle=0.,brake=0.))

    def test_real_owner_cannot_omit_purpose(self):
        self.controller()
        with self.assertRaisesRegex(ValueError,'purpose required'):AnalogController(MockPad(),owner=self.owner)

    def test_prepare_handshake_is_required_before_windows_or_driver_access(self):
        root=Path(__file__).resolve().parents[2]
        args=[sys.executable,str(root/'packages/actuation/gamepad_backend.py'),'--device','vgamepad','--target-pid','123','--connection','must-not-read.json','--purpose','diagnostic']
        result=subprocess.run(args,input='',capture_output=True,text=True,timeout=10,creationflags=subprocess.CREATE_NO_WINDOW if os.name=='nt' else 0)
        self.assertNotEqual(result.returncode,0);self.assertIn('preparation required before device creation',result.stderr)
        self.assertNotIn('Cannot verify GTA',result.stderr);self.assertNotIn('No module named',result.stderr)


if __name__=='__main__':unittest.main()
