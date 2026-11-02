"""Synthetic tests: long lessons translate in batches and failures are never reported as success."""
import asyncio
import json
import unittest
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException
from app.agent_budget import BudgetExceeded
from buddy_learning import service

TEACHER = {'username': 'fixture-teacher', 'is_admin': False}
COMPLETION = 'buddy_learning.assistant.completion'


def steps(count, size=3000):
    return [{'id': f's{index}', 'kind': 'text', 'title': f'Part {index}', 'text': 'x' * size} for index in range(count)]


def input_json(prompt):
    return json.loads(prompt.split('Input JSON:\n', 1)[1])


async def greek(prompt, **_):
    source = input_json(prompt)
    if 'title' in source:
        source['title'] = 'Τίτλος'
    for step in source.get('steps', []):
        step['title'] = 'Ελληνικά ' + step['id']
    return json.dumps(source, ensure_ascii=False)


def translate(payload):
    return asyncio.run(service._translate_json_payload('lesson', 'el', payload, 'u'))


class StepBatchTests(unittest.TestCase):
    def test_empty_steps_make_no_batches(self):
        self.assertEqual(service._step_batches([]), [])

    def test_batches_keep_order_and_respect_the_limit(self):
        source = steps(7)
        batches = service._step_batches(source)
        self.assertEqual([step for batch in batches for step in batch], source)
        self.assertGreater(len(batches), 1)
        for batch in batches:
            self.assertLessEqual(len(json.dumps(batch)), service.TRANSLATION_BATCH_CHARS + 50)

    def test_single_oversized_step_stays_whole(self):
        self.assertEqual(len(service._step_batches(steps(1, service.TRANSLATION_BATCH_CHARS * 2))), 1)


class BatchedTranslationTests(unittest.TestCase):
    def test_long_lesson_is_split_and_reassembled_in_order(self):
        completion = AsyncMock(side_effect=greek)
        with patch(COMPLETION, completion):
            result = translate({'title': 'Title', 'description': '', 'steps': steps(7)})
        self.assertGreater(completion.await_count, 1)
        self.assertEqual(result['title'], 'Τίτλος')
        self.assertEqual([step['id'] for step in result['steps']], [f's{index}' for index in range(7)])
        self.assertTrue(all(step['title'].startswith('Ελληνικά') for step in result['steps']))
        for call in completion.await_args_list:
            self.assertLess(len(call.args[0]), service.TRANSLATION_BATCH_CHARS + 2000)

    def test_short_lesson_uses_one_call(self):
        completion = AsyncMock(side_effect=greek)
        with patch(COMPLETION, completion):
            translate({'title': 'Title', 'steps': steps(1)})
        self.assertEqual(completion.await_count, 1)

    def test_timed_out_batch_is_retried_and_earlier_work_is_kept(self):
        calls = []
        async def flaky(prompt, **kwargs):
            calls.append(prompt)
            if len(calls) == 2:
                raise TimeoutError()
            return await greek(prompt, **kwargs)
        completion = AsyncMock(side_effect=flaky)
        with patch(COMPLETION, completion):
            result = translate({'title': 'Title', 'steps': steps(7)})
        self.assertEqual(calls[1], calls[2])
        self.assertEqual(len(result['steps']), 7)

    def test_batch_that_fails_twice_fails_the_translation(self):
        with patch(COMPLETION, AsyncMock(side_effect=TimeoutError())) as completion, self.assertRaises(TimeoutError):
            translate({'title': 'Title', 'steps': steps(1)})
        self.assertEqual(completion.await_count, 2)

    def test_lost_steps_are_rejected(self):
        with patch(COMPLETION, AsyncMock(return_value='{"title": "T", "steps": []}')), self.assertRaisesRegex(ValueError, 'number of steps'):
            translate({'title': 'Title', 'steps': steps(1)})

    def test_missing_steps_are_rejected(self):
        with patch(COMPLETION, AsyncMock(return_value='{"title": "T"}')), self.assertRaisesRegex(ValueError, 'number of steps'):
            translate({'title': 'Title', 'steps': steps(1)})

    def test_quota_failure_is_not_retried(self):
        with patch(COMPLETION, AsyncMock(side_effect=BudgetExceeded('Quota used'))) as completion, self.assertRaises(BudgetExceeded):
            translate({'title': 'Title', 'steps': steps(1)})
        self.assertEqual(completion.await_count, 1)


class TranslateContentRouteTests(unittest.TestCase):
    def request(self, payload=None):
        return service.TranslateContentRequest(kind='lesson', target_language='el', payload=payload or {'title': 'Title', 'steps': steps(7)})

    def test_manual_translation_of_a_long_lesson_uses_batches_and_the_long_limit(self):
        from buddy_learning.assistant import TRANSLATION_SECONDS
        completion = AsyncMock(side_effect=greek)
        with patch(COMPLETION, completion):
            result = asyncio.run(service.translate_content(self.request(), TEACHER))
        self.assertEqual(result['language'], 'el')
        self.assertEqual(len(result['translated']['steps']), 7)
        self.assertGreater(completion.await_count, 1)
        self.assertTrue(all(call.kwargs['timeout'] == TRANSLATION_SECONDS for call in completion.await_args_list))

    def test_manual_translation_repairs_quotes_inside_text(self):
        reply = '{"title": "Urgency ("Act now!") warning"}'
        with patch(COMPLETION, AsyncMock(return_value=reply)):
            result = asyncio.run(service.translate_content(self.request({'title': 'x'}), TEACHER))
        self.assertIn('Act now!', result['translated']['title'])

    def test_manual_translation_errors_keep_their_status(self):
        for error, status in ((BudgetExceeded('Quota used'), 429), (TimeoutError(), 502)):
            with patch(COMPLETION, AsyncMock(side_effect=error)), self.assertRaises(HTTPException) as caught:
                asyncio.run(service.translate_content(self.request(), TEACHER))
            self.assertEqual(caught.exception.status_code, status)

    def test_oversized_request_is_refused_before_any_call(self):
        with patch(COMPLETION, AsyncMock()) as completion, self.assertRaises(HTTPException) as caught:
            asyncio.run(service.translate_content(self.request({'title': 'x' * 65001}), TEACHER))
        self.assertEqual(caught.exception.status_code, 422)
        completion.assert_not_called()


if __name__ == '__main__':
    unittest.main()
