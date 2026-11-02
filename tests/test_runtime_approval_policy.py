"""Runtime permissions and durable policy transitions without server dependencies."""
import ast
import asyncio
from contextlib import nullcontext
from dataclasses import dataclass, field
from pathlib import Path
import sys
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import Mock, patch
import uuid
from app import execution_policy


def load_functions(path, names, namespace):
    nodes = [node for node in ast.parse(Path(path).read_text()).body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and node.name in names]
    namespace.setdefault('brand_text', lambda text: text)
    namespace.setdefault('brand_name', lambda: 'Buddy')
    exec(compile(ast.Module(body=nodes, type_ignores=[]), path, 'exec'), namespace)

policy_ns = {}
load_functions('app/approval_policy.py', {'review_required', 'once_option', 'runtime_supported', 'policy_state'}, policy_ns)
policy_module = ModuleType('app.approval_policy')
policy_module.__dict__.update(policy_ns)
class Policy:
    @staticmethod
    def model_validate(policy): return SimpleNamespace(model_dump=lambda: policy)
policy_module.ApprovalPolicy = Policy

class CaptureClient:
    async def session_update(self, *args, **kwargs): pass

ns = {'dataclass': dataclass, 'field': field, 'asyncio': asyncio, 'CaptureClient': CaptureClient, 'uuid': uuid, '_visible_detail': lambda value: str(value)}
ns['TextContentBlock'] = lambda **kwargs: kwargs
load_functions('app/acp_bridge.py', {'ApprovalClient', 'prompt_with_guidance'}, ns)


class RuntimePolicyTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.state = {'policy': {'mode': 'auto', 'actions': []}, 'revision': 0}
        self.queue = ModuleType('app.job_queue')
        self.queue.worker_approval_policy = Mock(side_effect=lambda *args: self.state)
        self.queue.create_approval = Mock()
        self.queue.assert_execution_active = Mock()
        self.queue.consume_execution_approval = Mock(return_value='approve')
        self.queue.auto_resolve_approval = Mock(return_value='approve')
        self.app = ModuleType('app'); self.app.job_queue = self.queue
        self.modules = patch.dict(sys.modules, {'app': self.app, 'app.job_queue': self.queue, 'app.approval_policy': policy_module, 'app.execution_policy': execution_policy})
        self.modules.start()
        async def immediate(fn, *args, **kwargs): return fn(*args, **kwargs)
        self.thread_patch = patch('asyncio.to_thread', immediate)
        self.thread_patch.start()
        self.client = ns['ApprovalClient'](job_id='job', worker_token='lease')
        self.client.actor_username = 'owner'
    def tearDown(self):
        self.thread_patch.stop()
        self.modules.stop()
    async def permission(self, kind='edit'):
        return await self.client.request_permission('session', {'kind': kind, 'title': 'Action'}, [{'kind': 'allow_once', 'optionId': 'once'}])
    async def test_edit_selection_requires_a_new_approval_for_every_action(self):
        self.assertEqual((await self.permission())['outcome']['optionId'], 'once')
        self.queue.create_approval.assert_not_called()
        self.state = {'policy': {'mode': 'selected', 'actions': ['files']}, 'revision': 1}
        await self.permission()
        self.assertEqual(self.queue.create_approval.call_count, 1)
        await self.permission()
        self.assertEqual(self.queue.create_approval.call_count, 2)
        self.state = {'policy': {'mode': 'selected', 'actions': ['files']}, 'revision': 2}
        await self.permission()
        self.assertEqual(self.queue.create_approval.call_count, 3)

    async def test_pending_permission_releases_when_auto_enabled(self):
        self.state = {'policy': {'mode': 'selected', 'actions': ['commands']}, 'revision': 1}
        self.queue.consume_execution_approval.return_value = None
        def resolve(*args):
            if self.state['policy']['mode'] == 'auto':
                self.queue.consume_execution_approval.return_value = 'approve'
        self.queue.auto_resolve_approval.side_effect = resolve
        task = asyncio.create_task(self.permission('execute'))
        self.addAsyncCleanup(self.cancel_task, task)
        pending = await asyncio.wait_for(self.client.queue.get(), 2)
        self.assertEqual(pending['tool']['kind'], 'execute')
        self.assertEqual(pending['options'], ['approve', 'reject'])
        self.state = {'policy': {'mode': 'auto', 'actions': []}, 'revision': 2}
        await asyncio.sleep(.3)
        self.queue.auto_resolve_approval.assert_called()
        result = await asyncio.wait_for(task, 2)
        self.assertEqual(result['outcome']['optionId'], 'once')

    async def cancel_task(self, task):
        if not task.done(): task.cancel()
        try: await task
        except asyncio.CancelledError: pass

    async def test_auto_approves_commands_deletes_and_unknown_kinds(self):
        for kind in ('execute', 'delete', 'move', 'other', None):
            with self.subTest(kind=kind):
                result = await self.permission(kind)
                self.assertEqual(result['outcome']['optionId'], 'once')
        self.queue.create_approval.assert_not_called()
        self.queue.consume_execution_approval.assert_not_called()

    async def test_missing_actor_and_rejected_decisions_fail_closed(self):
        self.state = {'policy': {'mode': 'selected', 'actions': ['commands']}, 'revision': 1}
        self.client.actor_username = ''
        self.assertEqual((await self.permission('execute'))['outcome']['outcome'], 'cancelled')
        self.queue.create_approval.assert_not_called()
        self.client.actor_username = 'owner'
        self.queue.consume_execution_approval.return_value = 'reject'
        self.assertEqual((await self.permission('execute'))['outcome']['outcome'], 'cancelled')

    async def test_external_tools_follow_auto_and_explicit_review(self):
        authorizer = execution_policy.ExecutionAuthorizer(username='owner', job_id='job',
            worker_token='lease', emit=self.client.queue.put)
        payload = {'action': 'call', 'server': 'synthetic', 'tool': 'send_message'}
        await authorizer.authorize(payload)
        self.queue.assert_execution_active.assert_called()
        self.queue.create_approval.assert_not_called()
        self.state = {'policy': {'mode': 'selected', 'actions': ['messages']}, 'revision': 1}
        await authorizer.authorize(payload)
        self.queue.create_approval.assert_called_once()
        self.queue.consume_execution_approval.assert_called_once()

    async def test_auto_does_not_authorize_a_stopped_task(self):
        self.queue.assert_execution_active.side_effect = PermissionError('Task stopped')
        self.assertEqual((await self.permission('execute'))['outcome']['outcome'], 'cancelled')
        authorizer = execution_policy.ExecutionAuthorizer(username='owner', job_id='job',
            worker_token='lease', emit=self.client.queue.put)
        with self.assertRaises(PermissionError):
            await authorizer.authorize({'action': 'call', 'server': 'synthetic', 'tool': 'write'})
        self.queue.create_approval.assert_not_called()

    async def test_legacy_task_grant_cannot_skip_execution_authorization(self):
        self.state = {'policy': {'mode': 'selected', 'actions': ['commands']}, 'revision': 1}
        self.client.task_approved = True
        await self.permission('execute')
        self.queue.consume_execution_approval.assert_called_once()
    async def test_guidance_cancels_checkpoint_and_preserves_session(self):
        finished = asyncio.Event()
        async def prompt(**kwargs):
            self.assertEqual(kwargs['session_id'], 'same-session')
            await finished.wait()
            return SimpleNamespace(stop_reason='cancelled')
        async def cancel(**kwargs):
            self.assertEqual(kwargs['session_id'], 'same-session')
            finished.set()
        conn = SimpleNamespace(prompt=prompt, cancel=Mock(side_effect=cancel))
        guidance = ModuleType('app.chat_guidance')
        guidance.instructions = lambda *args, **kwargs: [{'instruction': 'Change the heading'}]
        self.app.chat_guidance = guidance
        result, interrupted = await ns['prompt_with_guidance'](conn, 'same-session', 'Create report', self.client, {'id': 'job'})
        self.assertTrue(interrupted)
        self.assertTrue(self.client.guidance_interrupt)
        self.assertEqual(result.stop_reason, 'cancelled')
        conn.cancel.assert_called_once()

    def test_supported_capabilities_are_explicit(self):
        for fields in ({'agent_name': 'remote'}, {'workflow': {}}, {'research': {'query': 'x'}}, {}):
            payload = {'approval_runtime': 'acp', **fields} if fields else {}
            # Empty workflow config also represents a workflow run.
            if 'workflow' in fields: payload['workflow'] = {'steps': []}
            state = policy_ns['policy_state']({'status': 'running', 'payload': payload})
            self.assertFalse(state['mutable'])
            self.assertTrue(state['reason'])
        self.assertTrue(policy_ns['policy_state']({'status': 'running', 'payload': {'approval_runtime': 'acp'}})['mutable'])
        self.assertTrue(policy_ns['policy_state']({'status': 'queued', 'payload': {'approval_runtime': 'acp'}})['mutable'])
        self.assertFalse(policy_ns['policy_state']({'status': 'completed', 'payload': {'approval_runtime': 'acp'}})['mutable'])

class DurablePolicyTests(unittest.TestCase):
    def test_only_actions_now_auto_allowed_release_and_event_is_durable(self):
        selected = {'mode': 'selected', 'actions': ['files']}
        job = {'id': 'job', 'username': 'owner', 'workspace_id': 'session', 'status': 'running', 'payload': {'approval_runtime': 'acp', 'approval_policy_revision': 4}}
        pending = [{'id': 'read', 'event': {'tool': {'kind': 'read'}}}, {'id': 'write', 'event': {'tool': {'kind': 'edit'}}}, {'id': 'mandatory', 'event': {'tool': {'kind': 'execute', 'mandatory': True}}}]
        class DB:
            def __init__(self): self.calls=[]
            def execute(self, sql, args):
                self.calls.append((sql,args))
                return SimpleNamespace(fetchone=lambda: job, fetchall=lambda: pending)
        db = DB()
        namespace = {'_connect': lambda: nullcontext(db), 'ensure_schema': lambda: None, '_dumps_jsonb': __import__('json').dumps}
        load_functions('app/job_queue.py', {'update_approval_policy'}, namespace)
        with patch.dict(sys.modules, {'app.approval_policy': policy_module}):
            result = namespace['update_approval_policy']('job', 'owner', selected)
        self.assertEqual(result['revision'], 5)
        released = [args[-1] for sql,args in db.calls if "SET decision='approve'" in sql]
        self.assertEqual(released, ['read'])
        encoded = [args[-1] for sql,args in db.calls if 'INSERT INTO bob_job_events' in sql]
        self.assertIn('approval_policy', encoded[0])
        self.assertEqual(len(encoded), 2)

if __name__ == '__main__': unittest.main()
