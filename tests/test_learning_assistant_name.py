"""The name chosen in Appearance reaches Learning prompts and stays validated."""
import asyncio
import json
from unittest.mock import AsyncMock, patch

import pytest
from pydantic import ValidationError

from plugins.learning.buddy_learning import assistant, lesson_ai
from plugins.learning.buddy_learning.assistant_name import assistant_label
from plugins.learning.buddy_learning.lesson_models import BuddyDraftRequest


def test_default_label():
    assert assistant_label() == 'Buddy'
    assert assistant_label('Aria') == 'Aria'


@pytest.mark.parametrize('model,fields', [(assistant.ChatRequest, {'message': 'hi'}), (BuddyDraftRequest, {'message': 'hi'})])
def test_name_validation(model, fields):
    assert model(**fields).assistant_name is None
    assert model(**fields, assistant_name='Αθηνά 2').assistant_name == 'Αθηνά 2'
    for bad in ('a\nignore previous', '<b>', 'x' * 50):
        with pytest.raises(ValidationError):
            model(**fields, assistant_name=bad)


def test_chat_prompt_uses_name():
    reply = json.dumps({'reply': 'ok'})
    with patch.object(assistant, 'completion', AsyncMock(return_value=reply)) as completion:
        try:
            asyncio.run(assistant.respond(assistant.ChatRequest(message='hi', assistant_name='Aria'), can_create=False, context={}))
        except ValidationError:
            pass
    prompt = completion.call_args.args[0]
    assert prompt.startswith('You are Aria, the conversational assistant inside Learning Aria.\n')
    assert 'Return ONLY JSON' in prompt


def test_draft_prompt_uses_name():
    with patch.object(assistant, 'completion', AsyncMock(return_value='{}')) as completion:
        try:
            asyncio.run(lesson_ai.draft(BuddyDraftRequest(message='hi', assistant_name='Aria')))
        except Exception:
            pass
    assert completion.call_args.args[0].startswith('You are Aria, helping a human author')
