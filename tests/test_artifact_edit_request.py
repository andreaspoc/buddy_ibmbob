"""Exercise artifact edit routing without requiring a running database."""
import ast
import json
from pathlib import Path, PurePosixPath
import re
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, AsyncMock


def function_from(path, name, namespace):
    node = next(node for node in ast.parse(Path(path).read_text()).body
                if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == name)
    node.decorator_list = []
    node.returns = None
    node.args.defaults = []
    for arg in node.args.args:
        arg.annotation = None
    exec(compile(ast.Module(body=[node], type_ignores=[]), path, 'exec'), namespace)
    return namespace[name]


class HTTPError(Exception):
    def __init__(self, status_code, detail):
        self.status_code, self.detail = status_code, detail


class ArtifactEditTests(unittest.IsolatedAsyncioTestCase):
    def setup_route(self, saved=True):
        async def run_in_threadpool(fn, *args):
            return fn(*args)
        storage = SimpleNamespace(get_file=Mock(return_value={'content': b'<html></html>'} if saved else None))
        storage.validate_path = function_from('app/postgres_storage.py', 'validate_path',
                                              {'PurePosixPath': PurePosixPath, 'RESERVED': {'.bob'}})
        namespace = {
            'presentation_intent': lambda *args: {'presentation': False}, 'Path': Path, 're': re, 'HTTPException': HTTPError, 'storage': storage,
            'workspace_for': Mock(return_value='/tmp'), 'storage_scope': Mock(return_value='session:owned'),
            'list_modes': lambda: [{'slug': 'agent'}], 'list_skills': lambda: [],
            'build_html_edit_guidance': function_from('app/presentation.py', 'build_html_edit_guidance', {'json': json}),
            'read_history': lambda *args: [{'type': 'done', 'session_id': 'old-task'}],
            'execute_event_hooks': AsyncMock(return_value=(True, '', None)),
            'run_in_threadpool': run_in_threadpool, 'job_queue': SimpleNamespace(enqueue=Mock(return_value='job')),
            'workspace_key': lambda *args: 'owned', 'append_history': Mock(), 'touch_session': Mock(),
            'StreamingResponse': lambda *args, **kwargs: kwargs,
            '_stream_job_events': lambda *args: None,
        }
        return function_from('app/main.py', 'chat_stream', namespace), namespace

    def request(self, path='reports/deck.html'):
        return SimpleNamespace(edit_artifact_path=path, prompt='Make slide 3 simpler and create a new chart',
            ui_language='en',
            workspace_id='owned', mode='presentation', agent_name='remote', skill_name='presentation-buddy',
            preset_id='preset', session_id='old-task', template_id=None, slide_count=None,
            presentation_format='html', agent_context_id=None,
            approval_policy=SimpleNamespace(mode='selected', model_dump=lambda: {'mode': 'selected', 'actions': ['files']}))

    async def test_existing_file_bypasses_generation_and_resumption(self):
        route, namespace = self.setup_route()
        await route(self.request(), None, {'username': 'owner'})
        payload = namespace['job_queue'].enqueue.call_args.args[-1]
        self.assertEqual(payload['mode'], 'agent')
        self.assertEqual(payload['edit_artifact_path'], 'reports/deck.html')
        self.assertIsNone(payload['session_id'])
        self.assertIsNone(payload['agent_name'])
        self.assertIsNone(payload['skill_name'])
        self.assertIn('reports/deck.html', payload['bob_prompt'])
        self.assertIn('Patch only affected sections', payload['bob_prompt'])
        self.assertEqual(payload['approval_policy']['mode'], 'selected')
        namespace['storage'].get_file.assert_called_once_with('owner', 'session:owned', 'reports/deck.html')

    async def test_stream_header_is_valid_and_matches_frontend(self):
        route, _ = self.setup_route()
        response = await route(self.request(), None, {'username': 'owner'})
        self.assertEqual(response['headers']['X-Bob-Job-Id'], 'job')
        for name in response['headers']:
            self.assertRegex(name, r"^[!#$%&'*+.^_`|~0-9A-Za-z-]+$")
        self.assertIn("res.headers.get('X-Bob-Job-Id')", Path('web/src/App.tsx').read_text())

    async def test_new_deck_does_not_read_or_overwrite_old_presentation(self):
        import uuid
        route, namespace = self.setup_route()
        namespace.update({
            'uuid': uuid,
            'presentation_intent': lambda *args: {'presentation': True, 'format': 'html', 'slide_count': 4},
            'list_modes': lambda: [{'slug': 'agent'}, {'slug': 'presentation'}],
            'get_presentation_template': lambda _: {'title': 'Custom'},
            'build_html_presentation_prompt': Mock(return_value='Generate new deck'),
        })
        request = self.request()
        request.edit_artifact_path = None
        request.agent_name = None
        request.skill_name = None
        request.preset_id = None
        request.template_id = 'custom-catalog-theme'
        request.slide_count = 4
        await route(request, None, {'username': 'owner'})
        payload = namespace['job_queue'].enqueue.call_args.args[-1]
        self.assertRegex(payload['presentation_output_path'], r'^presentation-[a-f0-9]{32}\.html$')
        self.assertEqual(payload['presentation_format'], 'html')
        call = namespace['build_html_presentation_prompt'].call_args.kwargs
        self.assertFalse(call['existing'])
        self.assertEqual(call['output_path'], payload['presentation_output_path'])
        namespace['storage'].get_file.assert_not_called()
        self.assertEqual(namespace['append_history'].call_args.args[-1]['presentation_output_path'], payload['presentation_output_path'])

    async def test_missing_artifact_never_enqueues(self):
        route, namespace = self.setup_route(saved=False)
        with self.assertRaises(HTTPError) as error:
            await route(self.request(), None, {'username': 'owner'})
        self.assertEqual(error.exception.status_code, 404)
        namespace['job_queue'].enqueue.assert_not_called()

    async def test_invalid_paths_and_formats_never_enqueue(self):
        for path in ('../deck.html', '/deck.html', '.bob/deck.html', 'deck.pptx'):
            route, namespace = self.setup_route()
            with self.subTest(path=path), self.assertRaises(HTTPError) as error:
                await route(self.request(path), None, {'username': 'owner'})
            self.assertEqual(error.exception.status_code, 422)
            namespace['job_queue'].enqueue.assert_not_called()
