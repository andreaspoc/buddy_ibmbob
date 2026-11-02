"""Synthetic CLI responses only; no host policy or networking changes."""
import json
from pathlib import Path
import sys
from unittest import TestCase

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from buddy_tetragon.engine import Engine, EngineError, compile_policy, exact_paths, policy_name, run_cli

RULE = {'id': '11111111-1111-4111-8111-111111111111', 'name': 'Synthetic test',
        'kind': 'file', 'paths': ['/synthetic/secret'], 'binaries': ['/synthetic/cat']}
NAME = policy_name(RULE['id'])


def live(state='TP_STATE_ENABLED', mode='TP_MODE_ENFORCE', **extra):
    return {'name': NAME, 'state': state, 'mode': mode, **extra}


class CompilerTests(TestCase):
    def test_compiler_exact_binary_and_file_scope_and_preventive_override(self):
        policy = compile_policy(RULE)
        hook = policy['spec']['lsmhooks'][0]
        self.assertEqual(hook['hook'], 'file_open')
        self.assertEqual(hook['selectors'][0]['matchBinaries'][0], {'operator': 'In', 'values': RULE['binaries']})
        self.assertEqual(hook['selectors'][0]['matchArgs'][0]['operator'], 'Equal')
        self.assertEqual(hook['selectors'][0]['matchActions'], [{'action': 'Override', 'argError': -13}])
        self.assertNotIn('hostSelector', policy['spec'])

    def test_executable_uses_lsm_binprm_not_post_exec_kill(self):
        policy = compile_policy(RULE | {'kind': 'exec'})
        self.assertEqual(policy['spec']['lsmhooks'][0]['hook'], 'bprm_check_security')
        self.assertEqual(policy['spec']['lsmhooks'][0]['args'], [{'index': 0, 'type': 'linux_binprm'}])

    def test_invalid_scope_fails_closed(self):
        for value in ('/', '/etc/', '/etc//shadow', '/etc/../shadow', '/etc/./shadow', '/etc/*', 'relative', '//root/file', '/a\nfile', '/a\0file', '/a\\file'):
            with self.subTest(value=repr(value)), self.assertRaises(ValueError):
                exact_paths([value])
        for values in ([], ['ok'], None, ['/' + 'a' * 513], ['/a'] * 33):
            with self.subTest(values=values), self.assertRaises(ValueError):
                exact_paths(values)
        with self.assertRaises(ValueError):
            compile_policy(RULE | {'binaries': []})
        with self.assertRaises(ValueError):
            compile_policy(RULE | {'kind': 'shell'})

    def test_id_rejects_command_injection_and_unmanaged_name(self):
        for value in ('--help', '../secret', 'one; touch /tmp/a', '', RULE['id'].upper() + 'a'):
            with self.subTest(value=value), self.assertRaises(ValueError):
                policy_name(value)


class EngineTests(TestCase):
    def engine(self, responses):
        self.commands = []
        self.documents = []
        def runner(command):
            self.commands.append(command)
            if command[4] == 'add':
                self.documents.append(json.loads(Path(command[5]).read_text()))
            response = responses.pop(0)
            if isinstance(response, Exception):
                raise response
            return response if isinstance(response, str) else json.dumps(response)
        return Engine(executable='/synthetic/tetra', runner=runner)

    def test_status_requires_live_output_and_ignores_other_domains(self):
        engine = self.engine([{'policies': [live(), live(domain='static'), live(namespace='other'), {'name': 'external-policy'}]}])
        status = engine.status()
        self.assertTrue(status['connected'])
        self.assertEqual(len(status['policies']), 1)
        self.assertEqual(status['policies'][0]['state'], 'enabled')
        self.assertEqual(self.commands[0], ['/synthetic/tetra', '--server-address', 'unix:///var/run/tetragon/tetragon.sock', 'tracingpolicy', 'list', '-o', 'json'])

    def test_enum_numbers_and_missing_unknown_state_never_assume_loaded(self):
        engine = self.engine([{'policies': [live(state=1, mode=1), live(state=None, mode=None)]}])
        records = engine.list_policies()
        self.assertEqual(records[0]['state'], 'enabled')
        self.assertEqual(records[1]['state'], 'unknown')
        self.assertEqual(records[1]['mode'], 'unknown')

    def test_disconnected_and_malformed_responses(self):
        for response in (EngineError('Offline'), 'not-json', '[]', '{"policies":false}', '{"policies":[null]}'):
            with self.subTest(response=response):
                self.assertFalse(self.engine([response]).status()['connected'])

    def test_raw_error_not_exposed(self):
        engine = self.engine([{'policies': [live(error='synthetic secret')] }])
        self.assertNotIn('synthetic secret', json.dumps(engine.status()))

    def test_add_compiled_policy_and_read_back_enforce_state(self):
        engine = self.engine([{'policies': []}, 'accepted', {'policies': [live()]}])
        self.assertEqual(engine.add(compile_policy(RULE))['state'], 'enabled')
        self.assertEqual(self.documents, [compile_policy(RULE)])
        self.assertEqual(self.commands[1][-2:], ['--mode', 'enforce'])
        self.assertFalse(Path(self.commands[1][5]).exists())

    def test_add_rejects_monitor_loading_and_unknown(self):
        for state, mode in [('TP_STATE_LOADING', 'TP_MODE_ENFORCE'), ('TP_STATE_ENABLED', 'TP_MODE_MONITOR'), ('TP_STATE_ENABLED', None), ('TP_STATE_PARTIALLY_ENABLED', 'TP_MODE_ENFORCE')]:
            with self.subTest(state=state, mode=mode), self.assertRaises(EngineError):
                self.engine([{'policies': []}, 'accepted', {'policies': [live(state=state, mode=mode)]}]).add(compile_policy(RULE))

    def test_add_rejects_arbitrary_policy_and_existing_policy(self):
        engine = self.engine([])
        policy = compile_policy(RULE)
        policy['spec']['kprobes'] = []
        with self.assertRaises(ValueError):
            engine.add(policy)
        self.assertEqual(self.commands, [])
        engine = self.engine([{'policies': [live()]}])
        with self.assertRaises(EngineError):
            engine.add(compile_policy(RULE))
        self.assertEqual(len(self.commands), 1)

    def test_remove_checks_absence_and_cannot_delete_external(self):
        engine = self.engine([{'policies': [live()]}, 'deleted', {'policies': []}])
        engine.remove(NAME)
        self.assertEqual(self.commands[1][-2:], ['delete', NAME])
        with self.assertRaises(ValueError):
            engine.remove('external-policy')
        engine = self.engine([{'policies': [live()]}, 'deleted', {'policies': [live()]}])
        with self.assertRaises(EngineError):
            engine.remove(NAME)

    def test_remove_missing_policy_is_idempotent(self):
        engine = self.engine([{'policies': []}])
        engine.remove(NAME)
        self.assertEqual(len(self.commands), 1)

    def test_remote_socket_and_relative_executable_rejected(self):
        for address in ('http://host', 'localhost:54321', 'unix:///a/../b', 'unix:////a', 'unix:///a?b'):
            with self.subTest(address=address), self.assertRaises(EngineError):
                Engine(address=address)
        with self.assertRaises(EngineError):
            Engine(executable='tetra')


class SubprocessTests(TestCase):
    def test_failure_output_is_not_returned(self):
        with self.assertRaises(EngineError) as error:
            run_cli([sys.executable, '-c', 'import sys; print("synthetic secret"); sys.exit(1)'])
        self.assertNotIn('synthetic secret', str(error.exception))

    def test_output_limit_and_timeout(self):
        with self.assertRaises(EngineError):
            run_cli([sys.executable, '-c', 'print("x"*100000)'], max_bytes=100)
        with self.assertRaises(EngineError):
            run_cli([sys.executable, '-c', 'import time; time.sleep(1)'], timeout=.03)
        self.assertEqual(run_cli([sys.executable, '-c', 'print("ok")']), 'ok\n')
