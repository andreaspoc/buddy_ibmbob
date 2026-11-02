"""Repairs the one JSON mistake models routinely make: unescaped double quotes inside strings."""
import json

_VALUE_STARTS = ('"', '{', '[', '}', ']', '-', *'0123456789', 'true', 'false', 'null')


def _next_visible(text, start):
    index = start
    while index < len(text) and text[index].isspace():
        index += 1
    return index


def _closes_string(text, quote):
    """A real closing quote is followed by JSON structure; a quote in prose is followed by words."""
    index = _next_visible(text, quote + 1)
    if index >= len(text) or text[index] in '}]:':
        return True
    if text[index] != ',':
        return False
    after = _next_visible(text, index + 1)
    return after >= len(text) or text.startswith(_VALUE_STARTS, after)


def repair_json_quotes(text):
    """Return valid JSON untouched; otherwise escape quotes that cannot be closing a string."""
    try:
        json.loads(text)
        return text
    except ValueError:
        pass
    repaired = []
    in_string = False
    index = 0
    while index < len(text):
        character = text[index]
        if in_string and character == '\\':
            repaired.append(text[index:index + 2])
            index += 2
            continue
        if character == '"':
            if not in_string:
                in_string = True
            elif _closes_string(text, index):
                in_string = False
            else:
                character = '\\"'
        repaired.append(character)
        index += 1
    return ''.join(repaired)
