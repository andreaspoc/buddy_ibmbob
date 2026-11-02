#!/usr/bin/env python3
"""Package the Bob ACP / Buddy application into a standalone distribution zip file.

Excludes heavy/transient files like node_modules, cache directories, and test artifacts.
Preserves Unix file permissions. Excludes credentials, private data, and symlinks.
"""

import os
import zipfile
from pathlib import Path

SOURCE_DIR = Path(__file__).resolve().parent.parent
OUTPUT_ZIP = SOURCE_DIR / "bob-acp.zip"

EXCLUDE_DIRS = {
    "node_modules",
    "__pycache__",
    ".pytest_cache",
    ".git",
    ".bob-private",
    ".venv",
    ".cache",
    "users",
    "backups",
    "tests",
    "test",
    "__tests__",
    "artifacts",
    "reports",
    "coverage",
}

EXCLUDE_FILES = {
    ".DS_Store",
    ".env",
    "runtime.env",
    "bob-acp.zip",
    "buddy-installation.json",
    "coverage.xml",
}

EXCLUDE_EXTENSIONS = {
    ".pyc",
    ".pyo",
    ".dump",
    ".log",
    ".zip",
}


def is_test_file(path):
    """Keep development suites out of the application distribution."""
    name = path.name
    return (name.startswith('test_') and path.suffix == '.py' or
            name.endswith(('_test.py', '_test.go')) or
            '.test.' in name or '.spec.' in name or
            path.as_posix() == 'bindings/nodejs/test.js')


def build_zip():
    print(f"Packaging {SOURCE_DIR} -> {OUTPUT_ZIP}")
    if OUTPUT_ZIP.exists():
        OUTPUT_ZIP.unlink()

    total_files = 0
    total_bytes = 0

    with zipfile.ZipFile(OUTPUT_ZIP, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as zipf:
        for root, dirs, files in os.walk(SOURCE_DIR, followlinks=False):
            # Prune excluded directories
            dirs[:] = [d for d in dirs if d not in EXCLUDE_DIRS]
            if Path(root) == SOURCE_DIR / "workspace":
                # Only ship reusable workspace instructions, not generated documents.
                dirs[:] = [d for d in dirs if d == ".bob"]
                files = [f for f in files if f in {"AGENTS.md", "README.md"}]

            if Path(root) == SOURCE_DIR / "workspace" / ".bob":
                # Personal MCP/agent settings may embed tokens; runtime rebuilds them.
                files = []
                dirs[:] = [d for d in dirs if d in {"rules", "rules-agent", "skills"}]

            for file_name in files:
                if (file_name.startswith(".env") and not file_name.endswith(".example")) or file_name in EXCLUDE_FILES or any(file_name.endswith(ext) for ext in EXCLUDE_EXTENSIONS):
                    continue

                full_path = Path(root) / file_name
                rel_path = full_path.relative_to(SOURCE_DIR)
                if is_test_file(rel_path):
                    continue
                arcname = f"bob-acp/{rel_path.as_posix()}"

                if full_path.is_symlink():
                    # Do not distribute links to files outside the application.
                    continue
                zinfo = zipfile.ZipInfo.from_file(full_path, arcname=arcname)
                mode = full_path.stat().st_mode
                zinfo.external_attr = (mode & 0xFFFF) << 16
                zinfo.compress_type = zipfile.ZIP_DEFLATED
                with open(full_path, "rb") as f:
                    zipf.writestr(zinfo, f.read())
                total_bytes += full_path.stat().st_size

                total_files += 1

    zip_size = OUTPUT_ZIP.stat().st_size
    print("Archive created successfully!")
    print(f"  Files included: {total_files}")
    print(f"  Uncompressed size: {total_bytes / (1024 * 1024):.2f} MB")
    print(f"  Compressed size:   {zip_size / (1024 * 1024):.2f} MB")
    print(f"  Output location:   {OUTPUT_ZIP}")


if __name__ == "__main__":
    build_zip()
