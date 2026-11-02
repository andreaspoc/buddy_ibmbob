"""Verify shared user quotas on Learning inference helpers.

Exercises assistant completion, quiz draft creation, and grading with synthetic
fixtures and budget spies. No live models, network or user data are used.
"""
import asyncio
import sys
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch
from uuid import uuid4

learning_dir = Path(__file__).resolve().parents[1] / 'plugins' / 'learning'
if str(learning_dir) not in sys.path:
    sys.path.insert(0, str(learning_dir))

from app.agent_budget import BudgetExceeded, RunBudget
from buddy_learning.assistant import completion
from buddy_learning.quiz_ai import create_draft, suggest_grades
from buddy_learning.quizzes import automatic_written_grades


class LearningQuotaTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.budget = RunBudget('synthetic-learning-owner')
        self.consume = AsyncMock()
        self.budget.consume = self.consume

        self.fake_connection = SimpleNamespace(
            initialize=AsyncMock(),
            new_session=AsyncMock(return_value=SimpleNamespace(session_id='sess-1')),
            prompt=AsyncMock(return_value=SimpleNamespace(stop_reason='end_turn')),
        )
        self.fake_process = SimpleNamespace(returncode=0)

        fake_conn = self.fake_connection
        fake_proc = self.fake_process

        class FakeAgentProcess:
            def __init__(self, client, *args, **kwargs):
                self.client = client
            async def __aenter__(self):
                self.client.text_chunks.append('{"reply":"Synthetic learning reply"}')
                return fake_conn, fake_proc
            async def __aexit__(self, *args):
                pass

        class FakeChildEnv:
            def __init__(self, *args, **kwargs):
                pass
            async def __aenter__(self):
                return {}
            async def __aexit__(self, *args):
                pass

        self.FakeAgentProcess = FakeAgentProcess
        self.FakeChildEnv = FakeChildEnv

    async def test_assistant_completion_missing_budget_denied(self):
        with self.assertRaises(PermissionError):
            await completion('Synthetic prompt')
        self.consume.assert_not_called()

    async def test_assistant_completion_exhausted_quota_fails_before_model(self):
        self.consume.side_effect = BudgetExceeded('Synthetic learning quota exhausted')
        with patch('buddy_learning.assistant.approval_agent_process', self.FakeAgentProcess), \
             patch('buddy_learning.assistant.approval_child_environment', self.FakeChildEnv):
            with self.assertRaises(BudgetExceeded):
                await completion('Synthetic prompt', budget=self.budget)
        self.consume.assert_awaited_once_with('inference')
        self.fake_connection.prompt.assert_not_called()

    async def test_assistant_completion_consumes_quota_on_success(self):
        with patch('buddy_learning.assistant.approval_agent_process', self.FakeAgentProcess), \
             patch('buddy_learning.assistant.approval_child_environment', self.FakeChildEnv):
            reply = await completion('Synthetic prompt', budget=self.budget)
        self.assertEqual(reply, '{"reply":"Synthetic learning reply"}')
        self.consume.assert_awaited_once_with('inference')

    async def test_create_draft_missing_budget_denied(self):
        with self.assertRaises(PermissionError):
            await create_draft({'title': 'B', 'chapters': []}, 'Draft', 1, uuid4())
        self.consume.assert_not_called()

    async def test_create_draft_exhausted_quota_fails_before_model(self):
        self.consume.side_effect = BudgetExceeded('Synthetic learning quota exhausted')
        with patch('buddy_learning.quiz_ai.approval_agent_process', self.FakeAgentProcess), \
             patch('buddy_learning.quiz_ai.approval_child_environment', self.FakeChildEnv):
            with self.assertRaises(BudgetExceeded):
                await create_draft({'title': 'B', 'chapters': []}, 'Draft', 1, uuid4(), budget=self.budget)
        self.consume.assert_awaited_once_with('inference')
        self.fake_connection.prompt.assert_not_called()

    async def test_suggest_grades_missing_budget_denied(self):
        questions = [{'id': 'q1', 'type': 'text', 'question': 'Q', 'answer': 'A', 'rubric': 'R', 'points': 5}]
        answers = {'q1': 'User answer'}
        with self.assertRaises(PermissionError):
            await suggest_grades(questions, answers)
        self.consume.assert_not_called()

    async def test_suggest_grades_exhausted_quota_fails_before_model(self):
        self.consume.side_effect = BudgetExceeded('Synthetic learning quota exhausted')
        questions = [{'id': 'q1', 'type': 'text', 'question': 'Q', 'answer': 'A', 'rubric': 'R', 'points': 5}]
        answers = {'q1': 'User answer'}
        with patch('buddy_learning.quiz_ai.approval_agent_process', self.FakeAgentProcess), \
             patch('buddy_learning.quiz_ai.approval_child_environment', self.FakeChildEnv):
            with self.assertRaises(BudgetExceeded):
                await suggest_grades(questions, answers, budget=self.budget)
        self.consume.assert_awaited_once_with('inference')
        self.fake_connection.prompt.assert_not_called()

    async def test_completed_submission_does_not_consume_quota(self):
        row = {
            'username': 'synthetic-learner',
            'questions': [{'id': 'q1', 'type': 'text', 'points': 5}],
            'answers': {'q1': 'Answer'},
            'grades': {'q1': {'score': 5, 'feedback': 'Good', 'method': 'administrator'}},
        }
        provider = AsyncMock()
        graded = await automatic_written_grades(row, provider=provider, budget=self.budget)
        self.assertEqual(graded, row['grades'])
        provider.assert_not_called()
        self.consume.assert_not_called()


if __name__ == '__main__':
    unittest.main()
