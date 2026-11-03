"""Real driver test: zero pedals/buttons; optional one minimum stick step."""
import json,time,importlib.metadata
from pathlib import Path
import vgamepad as vg
from xinput_readback import initialize_neutral,read_state

def main():
    before=[read_state(i) for i in range(4)];pad=vg.VX360Gamepad()
    try:initialization=initialize_neutral(pad)
    finally:pad.reset();pad.update();del pad
    time.sleep(.1)
    report=dict(vgamepad=importlib.metadata.version('vgamepad'),scope='Real ViGEmBus and XInput; zero pedals/buttons, at most one minimum stick step for initialization',passed=True,before=before,initialization=initialization,after=read_state(initialization['slot']))
    output=Path(__file__).parent/'runs'/'analog'/'installed-neutral.json';output.parent.mkdir(parents=True,exist_ok=True);output.write_text(json.dumps(report,indent=2),encoding='utf-8');print(json.dumps(report))

if __name__=='__main__':main()
