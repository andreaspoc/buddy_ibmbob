"""Bridge plugins/tetragon/tests/test_engine.py into repository test suite."""
import sys
from pathlib import Path

_ROOT = str(Path(__file__).resolve().parents[1])
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)
_PLUGIN_DIR = str(Path(__file__).resolve().parents[1] / 'plugins' / 'tetragon')
if _PLUGIN_DIR not in sys.path:
    sys.path.insert(0, _PLUGIN_DIR)

from plugins.tetragon.tests.test_engine import CompilerTests, EngineTests, SubprocessTests

__all__ = ['CompilerTests', 'EngineTests', 'SubprocessTests']

if __name__ == '__main__':
    import unittest
    unittest.main()
