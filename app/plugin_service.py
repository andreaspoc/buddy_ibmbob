"""Compatibility factory; each plugin owns its application entry point."""
import os
import importlib
from pathlib import Path
import sys


def create_app(service=None):
    service = service or os.getenv('BUDDY_PLUGIN_SERVICE', '')
    if service not in {'office', 'people', 'projects', 'decisions'}:
        raise ValueError('BUDDY_PLUGIN_SERVICE must be office, people, projects or decisions')
    source = Path(__file__).resolve().parent.parent / 'plugins' / service
    if source.is_dir() and str(source) not in sys.path:
        sys.path.insert(0, str(source))
    return importlib.import_module(f'buddy_{service}.service').create_app()
