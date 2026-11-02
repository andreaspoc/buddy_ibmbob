"""Run readiness regressions using an existing Compose app and database.

Integration tests use disposable schemas and mocked agent/provider calls.
This is not a clean deployment, load test, or real provider smoke test.
"""
from pathlib import Path
import subprocess


def main():
    root = Path(__file__).resolve().parent.parent
    tests = (
        'test_auth_boundary.py', 'test_runner_security.py', 'test_streaming.py',
        'auth_boundary_integration.py', 'job_failure_recovery_integration.py',
        'postgres_storage_integration.py',
    )
    for name in tests:
        print('Checking ' + name, flush=True)
        with (root / 'tests' / name).open('rb') as source:
            subprocess.run(
                ['docker', 'compose', 'exec', '-T', '-e', 'BOB_FILE_STORAGE=postgres',
                 'bob-agent', 'python3', '-'],
                cwd=root, stdin=source, check=True,
            )


if __name__ == '__main__':
    main()
