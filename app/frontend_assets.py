"""Serve hashed assets retained for browser tabs opened before a deployment."""
from pathlib import Path
from fastapi.staticfiles import StaticFiles


def frontend_assets(current: Path, archive: Path | None = None) -> StaticFiles:
    files = StaticFiles(directory=current, check_dir=False)
    # StaticFiles applies its normal path traversal and symlink checks to both
    # directories. Current release files always take precedence.
    files.all_directories.append(str(archive if archive is not None else Path.home() / '.bob' / 'frontend-assets'))
    return files
