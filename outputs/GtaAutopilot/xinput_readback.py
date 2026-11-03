"""Reads OS XInput; importing this module creates no controller."""
import ctypes,time
from functools import lru_cache
from ctypes import wintypes
class Gamepad(ctypes.Structure):
    _fields_=[('buttons',wintypes.WORD),('left_trigger',ctypes.c_ubyte),('right_trigger',ctypes.c_ubyte),('left_x',ctypes.c_short),('left_y',ctypes.c_short),('right_x',ctypes.c_short),('right_y',ctypes.c_short)]
class State(ctypes.Structure):
    _fields_=[('packet',wintypes.DWORD),('gamepad',Gamepad)]
@lru_cache(maxsize=1)
def _xinput_api():
    dll=ctypes.WinDLL('xinput1_4');dll.XInputGetState.argtypes=[wintypes.DWORD,ctypes.POINTER(State)];dll.XInputGetState.restype=wintypes.DWORD
    return dll,dll.XInputGetState
def read_state(slot):
    _,get_state=_xinput_api();s=State();code=get_state(slot,ctypes.byref(s));return dict(slot=slot,error=code,packet=s.packet,values={name:getattr(s.gamepad,name) for name,_ in Gamepad._fields_} if code==0 else None)
def device_slot(pad):
    from vgamepad.win import vigem_client as client
    from vgamepad.win.virtual_gamepad import check_err
    slot=ctypes.c_uint();check_err(client.vigem_target_x360_get_user_index(pad._busp,pad._devicep,ctypes.byref(slot)));return slot.value
def neutral_state(s):return s.get('error')==0 and s.get('values') is not None and not any(s['values'].values())
def initialize_neutral(pad,slot=None,read=read_state,sleep=time.sleep):
    pad.reset();pad.update();sleep(.05)
    if slot is None:slot=device_slot(pad)
    observed=read(slot);primed=False
    if not neutral_state(observed):
        # Change one quantization step, with zero pedals/buttons, then send neutral.
        pad.left_joystick(x_value=1,y_value=0);pad.update();sleep(.03);pad.reset();pad.update();primed=True
    for _ in range(20):
        observed=read(slot)
        if neutral_state(observed):return dict(slot=slot,initialization_step_used=primed,xinput=observed)
        pad.reset();pad.update();sleep(.05)
    raise RuntimeError('XInput neutral state could not be confirmed')
