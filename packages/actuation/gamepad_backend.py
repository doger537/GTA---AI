import sys as _project_sys
from pathlib import Path as _ProjectPath
_project_sys.path.insert(0, str(_ProjectPath(__file__).resolve().parents[2]))
"""Leased analog backend. No device is created unless --device=vgamepad is explicit."""
import argparse, json, math, sys, threading, time

class AnalogController:
    def __init__(self,pad,safety=lambda:True,clock=time.monotonic,owner=None):
        if owner is None and not isinstance(pad,MockPad):raise ValueError('Real pad requires source-deadline ownership')
        self.pad=pad;self.safety=safety;self.clock=clock;self.owner=owner;self.lock=threading.RLock();self.active=False;self.fault=None;self.command=None;self.source=None;self.source_deadline=None;self.deadline=0;self.last=clock();self.values=dict(steer=0.,throttle=0.,brake=0.);self.neutral()
    def neutral(self):
        self.values=dict(steer=0.,throttle=0.,brake=0.);self.pad.reset();self.pad.update()
    def stop(self,reason='stopped'):
        with self.lock:
            self.active=False;self.command=None;self.fault=reason;self.neutral()
            if self.owner is not None:self.owner.release_neutral()
    def arm(self):
        with self.lock:
            if not self.safety():raise ValueError('GTA focus required, F8 must be released')
            if self.owner is not None:
                if self.owner.owner_id is None:self.owner.reserve()
                self.owner.check()
                if not self.safety():self.stop('focus_lost_or_f8');raise ValueError('Focus/F8 changed during ownership check')
            self.neutral();self.active=True;self.command=None;self.source=None;self.source_deadline=None;self.fault=None;self.last=self.clock();self.deadline=self.last+.25
    def validate_source(self,source):
        names={'sequence','generation','capture_start_ms','decision_expires_ms'}
        if not isinstance(source,dict) or set(source)!=names or any(type(v) is not int or not 0<=v<=2**53-1 for v in source.values()):raise ValueError('Valid integer decision source required')
        if source['capture_start_ms']>2**53-451 or not source['capture_start_ms']<source['decision_expires_ms']<=source['capture_start_ms']+450:raise ValueError('Invalid source decision deadline')
        if self.owner is not None and source['generation']!=self.owner.generation:raise ValueError('Source control generation changed')
        if self.source is not None:
            if source['generation']!=self.source['generation'] or source['sequence']<self.source['sequence']:raise ValueError('Decision source order/session changed')
            if source['sequence']==self.source['sequence']:
                if source['capture_start_ms']!=self.source['capture_start_ms'] or source['decision_expires_ms']>self.source['decision_expires_ms']:raise ValueError('Same-source decision cannot be extended or changed')
            elif source['capture_start_ms']<=self.source['capture_start_ms']:raise ValueError('Non-increasing decision capture time')
    def set(self,data,source=None):
        with self.lock:
            if not self.active:raise ValueError('Explicit arm required')
            if self.clock()>=self.deadline:self.stop('lease_expired');raise ValueError('Lease expired; arm again')
            if not self.safety():self.stop('focus_lost_or_f8');raise ValueError('Focus lost or F8')
            if set(data)!={'steer','throttle','brake','duration_ms'}:raise ValueError('Unexpected command fields')
            for key,lo,hi in [('steer',-1,1),('throttle',0,1),('brake',0,1)]:
                v=data[key]
                if isinstance(v,bool) or not isinstance(v,(float,int)) or not math.isfinite(v) or not lo<=v<=hi:raise ValueError('Invalid '+key)
            duration=data['duration_ms']
            if type(duration) is not int or not 20<=duration<=250 or data['throttle']>0 and data['brake']>0:raise ValueError('Invalid lease or conflicting pedals')
            before=self.clock()
            if self.owner is not None or source is not None:
                try:self.validate_source(source)
                except Exception:
                    if self.owner is not None:self.stop('invalid_decision_source')
                    raise
            candidate=before+duration/1000
            if self.owner is not None:
                try:response=self.owner.check(duration,source)
                except Exception:self.stop('decision_rejected');raise
                if not self.safety():self.stop('focus_lost_or_f8');raise ValueError('Focus/F8 changed during ownership check')
                if self.clock()>=self.deadline:self.stop('lease_expired');raise ValueError('Lease expired during ownership check')
                remaining=response.get('remaining_ms') if isinstance(response,dict) else None
                if type(remaining) not in (int,float) or not math.isfinite(remaining) or not 0<remaining<=duration:self.stop('invalid_decision_deadline');raise ValueError('Invalid broker decision remaining time')
                # Start BEFORE the request, not at receipt: network delay can only shorten.
                candidate=min(candidate,before+remaining/1000)
            if source is not None:
                if self.source is not None and source['sequence']==self.source['sequence']:candidate=min(candidate,self.source_deadline)
                if self.clock()>=candidate:self.stop('decision_expired');raise ValueError('Decision expired before application')
                self.source=source.copy();self.source_deadline=candidate
            self.command=data.copy();self.deadline=candidate
    def tick(self):
        with self.lock:
            now=self.clock()
            if not self.active:
                if self.owner is not None and self.owner.owner_id is not None:
                    try:self.owner.check()
                    except Exception:self.stop('ownership_revoked')
                return
            if not self.safety():self.stop('focus_lost_or_f8');return
            if now>=self.deadline:self.stop('lease_expired');return
            if self.owner is not None:
                try:self.owner.check()
                except Exception:self.stop('ownership_revoked');return
                now=self.clock()
                if now>=self.deadline:self.stop('lease_expired');return
                if not self.safety():self.stop('focus_lost_or_f8');return
            dt=max(0,min(.1,now-self.last));self.last=now
            if self.command is None:return
            def slew(key,rate):
                old=self.values[key];target=self.command[key];return old+max(-rate*dt,min(rate*dt,target-old))
            self.values['steer']=slew('steer',1.5)
            # Release gas immediately when braking; brake is a real separate trigger.
            self.values['throttle']=0. if self.command['brake']>0 else slew('throttle',1.)
            self.values['brake']=self.command['brake']
            self.pad.left_joystick_float(x_value_float=self.values['steer'],y_value_float=0.)
            self.pad.right_trigger_float(value_float=self.values['throttle']);self.pad.left_trigger_float(value_float=self.values['brake']);self.pad.update()

class MockPad:
    def __init__(self):self.calls=[]
    def reset(self):self.calls.append(('reset',{}))
    def update(self):self.calls.append(('update',{}))
    def left_joystick_float(self,**kw):self.calls.append(('steer',kw))
    def right_trigger_float(self,**kw):self.calls.append(('gas',kw))
    def left_trigger_float(self,**kw):self.calls.append(('brake',kw))

def windows_safety(pid):
    import ctypes
    from ctypes import wintypes
    user=ctypes.WinDLL('user32',use_last_error=True)
    user.GetForegroundWindow.restype=wintypes.HWND
    user.GetWindowThreadProcessId.argtypes=[wintypes.HWND,ctypes.POINTER(wintypes.DWORD)]
    kernel=ctypes.WinDLL('kernel32',use_last_error=True)
    kernel.OpenProcess.argtypes=[wintypes.DWORD,wintypes.BOOL,wintypes.DWORD];kernel.OpenProcess.restype=wintypes.HANDLE
    kernel.QueryFullProcessImageNameW.argtypes=[wintypes.HANDLE,wintypes.DWORD,wintypes.LPWSTR,ctypes.POINTER(wintypes.DWORD)]
    kernel.CloseHandle.argtypes=[wintypes.HANDLE]
    handle=kernel.OpenProcess(0x1000,False,pid)
    if not handle:raise ValueError('Cannot verify GTA process')
    try:
        name=ctypes.create_unicode_buffer(32768);length=wintypes.DWORD(len(name))
        if not kernel.QueryFullProcessImageNameW(handle,0,name,ctypes.byref(length)):raise ValueError('Cannot verify GTA process name')
        from pathlib import Path
        exe=Path(name.value).name.lower()
        if not exe.startswith('gta5') or not exe.endswith('.exe'):raise ValueError('Only GTA5 process is supported')
    finally:kernel.CloseHandle(handle)
    def safe():
        target=wintypes.DWORD();user.GetWindowThreadProcessId(user.GetForegroundWindow(),ctypes.byref(target))
        return target.value==pid and not(user.GetAsyncKeyState(0x77)&0x8000)
    return safe

def main():
    p=argparse.ArgumentParser();p.add_argument('--device',choices=['mock','vgamepad'],default='mock');p.add_argument('--target-pid',type=int);p.add_argument('--connection');args=p.parse_args()
    owner=None
    if args.device=='vgamepad':
        if not args.target_pid or args.target_pid<=0 or not args.connection:raise ValueError('Explicit GTA process id and bridge connection file required')
        safety=windows_safety(args.target_pid)
        if not safety():raise ValueError('Focus GTA and release F8 before creating the device')
        import vgamepad as vg
        from packages.actuation.input_ownership import BridgeOwner
        owner=BridgeOwner(args.connection,args.target_pid);owner.reserve()
        from packages.actuation.xinput_readback import initialize_neutral,read_state
        def permission():
            if not safety():raise ValueError('GTA focus/F8 changed during initialization')
            owner.check()
            if not safety():raise ValueError('GTA focus/F8 changed during initialization')
        pad=None
        try:
            permission();pad=vg.VX360Gamepad();initialization=initialize_neutral(pad,permission=permission);permission()
        except Exception:
            if pad is not None:pad.reset();pad.update()
            owner.release_neutral();raise
    else:pad=MockPad();safety=lambda:True
    controller=AnalogController(pad,safety,owner=owner);done=threading.Event()
    def watchdog():
        while not done.wait(.02):
            try:controller.tick()
            except Exception as e:
                done.set()
                try:controller.stop('backend_error')
                finally:print(json.dumps(dict(event='fault',error=str(e))),flush=True);return
    worker=threading.Thread(target=watchdog,daemon=True);worker.start()
    print(json.dumps(dict(event='ready',device=args.device,physical_device=args.device=='vgamepad',initialization=initialization if args.device=='vgamepad' else None)),flush=True)
    try:
        for line in sys.stdin:
            try:
                if done.is_set():raise ValueError('Watchdog unavailable')
                request=json.loads(line);op=request.get('op')
                if op=='arm':controller.arm()
                elif op=='command':controller.set(request['command'],request.get('source'))
                elif op=='stop':controller.stop()
                elif op=='pause_pulse':
                    if args.device!='vgamepad':raise ValueError('Pause diagnostic requires the real device')
                    with controller.lock:
                        if not controller.active or controller.command is None or controller.source is None or not safety() or controller.clock()>=controller.deadline:raise ValueError('Active source-timed lease required')
                        owner.check()
                        if not safety() or controller.deadline-controller.clock()<.06:raise ValueError('Fresh focused lease required for pause pulse')
                        try:pad.press_button(button=vg.XUSB_BUTTON.XUSB_GAMEPAD_START);pad.update();time.sleep(.06)
                        finally:pad.release_button(button=vg.XUSB_BUTTON.XUSB_GAMEPAD_START);pad.update()
                elif op!='status':raise ValueError('Unknown operation')
                with controller.lock:
                    response=dict(ok=True,active=controller.active,fault=controller.fault,values=controller.values.copy())
                    if args.device=='vgamepad':response['xinput']=read_state(initialization['slot'])
            except Exception as e:controller.stop('invalid_request');response=dict(ok=False,error=str(e))
            print(json.dumps(response,allow_nan=False),flush=True)
    finally:
        done.set();worker.join(timeout=1);controller.stop('stdin_closed')

if __name__=='__main__':main()
