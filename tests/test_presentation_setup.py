"""Presentation requests cannot enqueue work before setup is supplied."""
import unittest
from unittest.mock import patch, MagicMock
from fastapi import HTTPException
from starlette.requests import Request
from app.main import StreamRequest, chat_stream


class PresentationSetupTests(unittest.IsolatedAsyncioTestCase):
    async def test_setup_required_with_web_search_and_direct_requests(self):
        for skill in (None, 'research-buddy', 'presentation-buddy'):
            for mode in ('agent', 'presentation'):
                for fields, expected in (({}, 'template'), ({'template_id': 'purple-starter'}, 'number of slides')):
                    with self.subTest(skill=skill, mode=mode, fields=fields):
                        req = StreamRequest(prompt='create me an interactive html presentation to explain this. Also include costs.',
                                            skill_name=skill, mode=mode, **fields)
                        with patch('app.presentation.list_presentation_templates', return_value=[]), \
                             patch('app.main.job_queue._connect', return_value=MagicMock()), \
                             patch('app.main.storage.get_file', return_value=None), \
                             patch('app.main.storage_scope', return_value='scope'), \
                             patch('app.main.job_queue.find_submission', return_value=None), \
                             patch('app.main.workspace_for', return_value='/tmp'), \
                             patch('app.main.list_skills', return_value=[{'name': 'research-buddy'}, {'name': 'presentation-buddy'}]), \
                             patch('app.main.list_modes', return_value=[{'slug': 'agent'}, {'slug': 'presentation'}]):
                            with self.assertRaises(HTTPException) as error:
                                await chat_stream(req, Request({'type':'http', 'method':'POST', 'path':'/', 'headers':[]}), {'username': 'test'})
                            self.assertEqual(error.exception.status_code, 422)
                            self.assertEqual(error.exception.detail['code'], 'presentation_setup_required')
                            self.assertTrue(error.exception.detail['presentation'])
                            self.assertIsInstance(error.exception.detail['templates'], list)


if __name__ == '__main__':
    unittest.main()
