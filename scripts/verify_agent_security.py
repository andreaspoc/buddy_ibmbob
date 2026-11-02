"""Repeatable security gate. All provider, service and user data fixtures are synthetic."""
import argparse
import os
from pathlib import Path
import subprocess
import sys
import unittest


MODULES = (
    'tests.test_execution_boundary', 'tests.test_agent_phase_security',
    'tests.test_runtime_approval_policy', 'tests.test_task_approval',
    'tests.approval_policy_test', 'tests.test_agent_sandbox',
    'tests.test_agent_budget', 'tests.test_knowledge_quota',
    'tests.test_mcp_discovery_limits', 'tests.test_project_memory_security',
    'tests.test_mcp_redaction', 'tests.test_people_generation_quota',
    'tests.test_specialist_quota',
)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--require-sandbox', action='store_true',
                        help='Also run the real namespace gate; unavailable isolation fails the command')
    options = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    os.chdir(root)
    sys.path.insert(0, str(root))
    suite = unittest.defaultTestLoader.loadTestsFromNames(MODULES)
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    if not result.wasSuccessful():
        return 1
    if options.require_sandbox:
        subprocess.run([sys.executable, '-m', 'app.agent_sandbox'], cwd=root, check=True)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
