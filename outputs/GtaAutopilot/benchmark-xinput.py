"""Read-only XInput timing. Never creates a virtual device or sends input."""
import importlib.util,json,statistics,time
from pathlib import Path
from xinput_readback import read_state

root=Path(__file__).parent/'runs'/'optimization-2026-11-02'
spec=importlib.util.spec_from_file_location('baseline_xinput',root/'baseline'/'xinput_readback.py')
baseline=importlib.util.module_from_spec(spec);spec.loader.exec_module(baseline)
slot=next((s for s in range(4) if read_state(s)['error']!=0),None)
if slot is None:raise RuntimeError('No disconnected XInput slot for repeatable read-only benchmark')
old=baseline.read_state(slot);new=read_state(slot)
assert old==new
timings=[[],[]];n=2000
for round in range(7):
    for which in ([1,0] if round%2 else [0,1]):
        function=read_state if which else baseline.read_state
        start=time.perf_counter()
        for _ in range(n):function(slot)
        timings[which].append((time.perf_counter()-start)*1000/n)
before,after=map(statistics.median,timings)
result=dict(scope='OS read of disconnected XInput slot; binding plus read only, not full actuator loop',before_ms=before,after_ms=after,speedup=before/after,iterations_per_round=n,rounds=7,outputs_equal=True,virtual_device_created=False,game_input_sent=False)
(root/'xinput-timing.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
print(json.dumps(result))
