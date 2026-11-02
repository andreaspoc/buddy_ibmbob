"""Legacy import names alias installed feature modules without duplicate state.

The source-tree fallback supports embedded development; production images install
only the appropriate versioned feature distribution.
"""
import importlib
from pathlib import Path
import sys


def alias(name, target, feature):
    source = Path(__file__).resolve().parent.parent / 'plugins' / feature
    if source.is_dir() and str(source) not in sys.path:
        sys.path.insert(0, str(source))
    module = importlib.import_module(target)
    sys.modules[name] = module
