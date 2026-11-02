"""Bridge plugins/projects/tests/test_impact.py into repository test suite."""
import sys
from pathlib import Path

_ROOT = str(Path(__file__).resolve().parents[1])
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)
_PLUGIN_DIR = str(Path(__file__).resolve().parents[1] / 'plugins' / 'projects')
if _PLUGIN_DIR not in sys.path:
    sys.path.insert(0, _PLUGIN_DIR)

from plugins.projects.tests.test_impact import ImpactTests

__all__ = ['ImpactTests']

if __name__ == '__main__':
    import unittest
    unittest.main()
