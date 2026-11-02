"""Permission callback blocks until a durable owner decision, once only."""
import asyncio
from unittest.mock import patch
from app.acp_bridge import ApprovalClient
from acp.schema import ToolCall, PermissionOption, RequestPermissionResponse

async def check(decision):
    client = ApprovalClient(policy={'mode': 'selected', 'actions': ['files']}, job_id='job', worker_token='token')
    decisions = [None, decision]
    with patch('app.job_queue.worker_approval_policy', return_value={'policy': client.policy, 'revision': 0}), patch('app.job_queue.create_approval') as create, patch('app.job_queue.approval_decision', side_effect=lambda *args: decisions.pop(0)):
        task = asyncio.create_task(client.request_permission('session', ToolCall(tool_call_id='tool', title='Write file', kind='edit'),
            [PermissionOption(option_id='once', name='Approve once', kind='allow_once'), PermissionOption(option_id='always', name='Always', kind='allow_always')]))
        pending = await client.queue.get()
        assert pending['status'] == 'pending' and not task.done()
        create.assert_called_once()
        response = await task
        RequestPermissionResponse.model_validate(response)
        assert response['outcome'] == ({'outcome': 'selected', 'optionId': 'once'} if decision == 'approve' else {'outcome': 'cancelled'})
        assert (await client.queue.get())['status'] == ('approved' if decision == 'approve' else 'rejected')

asyncio.run(check('approve'))
asyncio.run(check('reject'))
print('ACP callback waits for decision and approves once or rejects')


async def team_environment_is_temporary():
    from app.acp_bridge import approval_child_environment
    from contextlib import asynccontextmanager
    import os
    @asynccontextmanager
    async def gateway(team, key):
        assert team == 'team' and key == 'test-key'
        yield 'http://127.0.0.1:12345'
    with patch.dict(os.environ, {'BOB_TEAM_ID': 'team', 'BOB_API_KEY': 'test-key', 'BOBSHELL_API_KEY': 'test-key'}), patch('app.acp_team_gateway.team_gateway', gateway):
        async with approval_child_environment('/tmp', '/tmp/search') as env:
            assert env['BOB_GATEWAY_URL'] == 'http://127.0.0.1:12345'
            assert 'BOB_GATEWAY_URL' not in os.environ
            assert 'DATABASE_URL' not in env
asyncio.run(team_environment_is_temporary())
print('Team adapter override is temporary and excludes database credentials')

async def conflicting_key_aliases():
    import os
    from app.acp_bridge import approval_child_environment
    with patch.dict(os.environ, {'BOB_TEAM_ID':'team','BOB_API_KEY':'canonical','BOBSHELL_API_KEY':'different'}):
        try:
            async with approval_child_environment('/tmp','/tmp/search'):
                raise AssertionError('Conflicting aliases should not execute')
        except RuntimeError as exc:
            assert 'both set but differ' in str(exc)
asyncio.run(conflicting_key_aliases())
print('Conflicting key aliases fail before execution, matching Bob precedence')
