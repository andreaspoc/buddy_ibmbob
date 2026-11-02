"""Private process scratch space and fail-closed configured directories."""
import os
from pathlib import Path
import stat
import tempfile
from functools import lru_cache
from threading import Lock

_scratch_lock = Lock()


@lru_cache(maxsize=None)
def _scratch(kind):
    # Keep the object alive until interpreter shutdown so cleanup owns the tree.
    return tempfile.TemporaryDirectory(prefix=f'bob-{kind}-')


def scratch_directory(kind):
    with _scratch_lock:
        return Path(_scratch(kind).name)


def private_directory(path):
    """Reject symlinks, untrusted parents and an existing nonprivate leaf."""
    path = Path(os.path.abspath(path))
    descriptor = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        for index, part in enumerate(path.parts[1:]):
            leaf = index == len(path.parts) - 2
            try:
                os.mkdir(part, mode=0o700, dir_fd=descriptor)
            except FileExistsError:
                pass
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                            dir_fd=descriptor)
            os.close(descriptor)
            descriptor = child
            info = os.fstat(descriptor)
            if info.st_uid not in (0, os.geteuid()):
                raise PermissionError('Scratch directory has an untrusted owner')
            if leaf:
                if info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) & 0o077:
                    raise PermissionError('Scratch directory must be owned by this user with mode 0700')
            elif info.st_mode & 0o022 and not info.st_mode & stat.S_ISVTX:
                raise PermissionError('Scratch directory has a shared writable parent')
        if path == Path('/'):
            raise PermissionError('The filesystem root is not a scratch directory')
    finally:
        os.close(descriptor)
    return path
