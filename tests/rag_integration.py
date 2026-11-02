"""Compatibility entry point for the isolated shared-library integration check.

Run in bob-agent: python3 tests/rag_integration.py
For stdin execution use tests/shared_knowledge_integration.py directly.
"""
from pathlib import Path
import runpy

if __name__ == "__main__":
    runpy.run_path(str(Path(__file__).with_name("shared_knowledge_integration.py")), run_name="__main__")
