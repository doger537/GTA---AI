# Compatibility only; canonical implementation: training/train-pilotnet.py
import runpy as _runpy, sys as _sys
from pathlib import Path as _Path
_root=_Path(__file__).resolve().parents[2]
_sys.path.insert(0,str(_root))
globals().update(_runpy.run_path(str(_root / "training/train-pilotnet.py"),run_name=__name__))
