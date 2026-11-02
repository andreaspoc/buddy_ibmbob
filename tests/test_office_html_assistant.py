"""Native HTML Buddy plans retain text-node identity and cannot run markup."""
import json
from unittest import TestCase
from unittest.mock import patch
from uuid import uuid4
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import ValidationError
from app import office_assistant as oa


class HtmlAssistantTests(TestCase):
    def plan(self, actions=None, kind='html', extension='html'):
        return oa.parse_plan(json.dumps({'version': 1, 'kind': kind, 'reply': 'Review proposed changes',
            'actions': actions if actions is not None else [{'type': 'html_update_text', 'index': 3, 'old_text': 'Old heading', 'text': 'New heading'}]}), extension)

    def context(self):
        return oa.Context(kind='html', html_nodes=[{'index': 3, 'text': 'Old heading', 'tag': 'h1'}])

    def test_identity_and_extension(self):
        for extension in ('html', 'htm'):
            plan = self.plan(extension=extension)
            oa.validate_context_plan(plan, self.context())
        for context in (oa.Context(kind='html'), oa.Context(kind='html', html_nodes=[{'index': 3, 'text': 'Stale', 'tag': 'h1'}]), oa.Context(kind='word')):
            with self.assertRaises(ValueError):
                oa.validate_context_plan(self.plan(), context)
        with self.assertRaises(ValueError):
            self.plan([{'type': 'insert_blocks', 'position': 'end', 'blocks': [{'type': 'paragraph', 'text': 'Wrong editor'}]}])
        with self.assertRaises(ValueError):
            self.plan([], kind='word')
        oa.validate_context_plan(self.plan([]), oa.Context(kind='html'))

    def test_bounded_context_and_actions(self):
        for fields in ({'index': 0}, {'index': 2001}, {'text': 'x' * 4001}, {'execute': 'evil()'}):
            action = {'type': 'html_update_text', 'index': 3, 'old_text': 'Old heading', 'text': 'New'}
            with self.assertRaises(ValueError):
                self.plan([{**action, **fields}])
        with self.assertRaises(ValueError):
            oa.validate_context_plan(self.plan([a.model_dump() for a in self.plan().actions] * 2), self.context())
        for nodes in ([{'index': 1, 'text': 'x', 'tag': 'p'}] * 2,
                      [{'index': i, 'text': 'x' * 4000, 'tag': 'p'} for i in range(1, 9)],
                      [{'index': i, 'text': '', 'tag': 'p'} for i in range(1, 202)]):
            with self.assertRaises(ValidationError):
                oa.Context(kind='html', html_nodes=nodes)

    def test_policy_and_streaming_route(self):
        req = oa.Draft(prompt='Improve the heading', context=self.context())
        content = oa.completion_for(req, 'html').messages[0].content
        self.assertIn('never executable HTML', content)
        self.assertIn('Questions, explanations and summaries return actions:[]', content)
        self.assertIn('"html_nodes":', content)
        app = FastAPI()
        app.include_router(oa.router)
        app.dependency_overrides[oa.current_user] = lambda: {'username': 'html-test'}
        async def source(req, language, on_text):
            result = self.plan().model_dump_json()
            await on_text(result)
            return result
        oa.office_ai._active.clear()
        with patch.dict('os.environ', {'BOB_API_KEY': 'test-secret'}), patch.object(oa, 'owned_extension', return_value='html'), patch.object(oa.office_ai, 'run_acp', side_effect=source):
            with TestClient(app) as client:
                result = client.post(f'/api/office/assistant/files/{uuid4()}/draft', json=req.model_dump())
        self.assertEqual(result.status_code, 200)
        events = [json.loads(line) for line in result.text.splitlines()]
        self.assertEqual(events[-1]['type'], 'done')
        self.assertEqual(next(e['plan'] for e in events if e['type'] == 'plan')['kind'], 'html')


if __name__ == '__main__':
    from unittest import main
    main()
