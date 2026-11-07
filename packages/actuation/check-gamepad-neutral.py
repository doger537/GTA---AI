import sys as _project_sys
from pathlib import Path as _ProjectPath
_project_sys.path.insert(0, str(_ProjectPath(__file__).resolve().parents[2]))
"""Real driver test: zero pedals/buttons; optional one minimum stick step."""
import json,time,importlib.metadata,argparse
from pathlib import Path
import vgamepad as vg
from packages.actuation.xinput_readback import initialize_neutral,read_state
from packages.actuation.input_ownership import BridgeOwner
from packages.actuation.gamepad_backend import windows_safety

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--pid',type=int,required=True);args=parser.parse_args()
    safe=windows_safety(args.pid)
    if not safe():raise ValueError('Focus GTA and release F8')
    owner=BridgeOwner(_ProjectPath(__file__).resolve().parents[2]/'apps/gta-control/connection.json',args.pid);owner.reserve()
    def permission():
        if not safe():raise ValueError('GTA focus/F8 changed during initialization')
        owner.check()
        if not safe():raise ValueError('GTA focus/F8 changed during initialization')
    before=[read_state(i) for i in range(4)];pad=None
    try:
        permission();pad=vg.VX360Gamepad();initialization=initialize_neutral(pad,permission=permission);permission()
    finally:
        if pad is not None:pad.reset();pad.update();del pad
        owner.release_neutral()
    time.sleep(.1)
    report=dict(vgamepad=importlib.metadata.version('vgamepad'),scope='Real ViGEmBus and XInput; zero pedals/buttons, at most one minimum stick step for initialization',passed=True,before=before,initialization=initialization,after=read_state(initialization['slot']))
    output=(_ProjectPath(__file__).resolve().parents[2] / 'experiments/runs')/'analog'/'installed-neutral.json';output.parent.mkdir(parents=True,exist_ok=True);output.write_text(json.dumps(report,indent=2),encoding='utf-8');print(json.dumps(report))

if __name__=='__main__':main()
