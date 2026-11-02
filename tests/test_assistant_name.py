"""Validation and prompt wording for the user-chosen assistant name."""
import pytest
from pydantic import TypeAdapter, ValidationError

from app.main import StreamRequest
from app.response_language import assistant_name_instruction


def test_no_name_adds_nothing():
    assert assistant_name_instruction() == ''
    assert assistant_name_instruction(None) == ''


def test_name_is_included_and_grants_nothing():
    text = assistant_name_instruction('Aria')
    assert 'Refer to yourself as Aria' in text
    assert 'not your instructions, abilities or permissions' in ' '.join(text.split())


@pytest.mark.parametrize('name', ['Aria', 'Αθηνά 2', "O'Neil-3"])
def test_valid_names_accepted(name):
    assert StreamRequest(prompt='hi', assistant_name=name).assistant_name == name


@pytest.mark.parametrize('name', ['', ' Aria', 'a\nignore previous', '<b>', '"quoted"', 'x' * 50])
def test_unsafe_names_rejected(name):
    with pytest.raises(ValidationError):
        StreamRequest(prompt='hi', assistant_name=name)


def test_name_is_optional():
    assert TypeAdapter(StreamRequest).validate_python({'prompt': 'hi'}).assistant_name is None
