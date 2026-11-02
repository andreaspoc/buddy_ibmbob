"""Controlled business terms mapped to typed JSON document paths."""
import math
import re

_PATH = re.compile(r'[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*\Z')
_TERM = re.compile(r'[A-Za-z][A-Za-z0-9_]*(?: [A-Za-z][A-Za-z0-9_]*)*\Z')
_TYPES = {'string', 'number', 'integer', 'boolean', 'object', 'array', 'null', 'any'}
_RESERVED = {'if', 'then', 'else', 'definitions', 'set', 'add', 'to', 'and', 'or', 'not', 'is', 'in', 'true', 'false', 'null'}
_MISSING = object()


def validate_vocabulary(vocabulary=None):
    if vocabulary is None:
        return []
    if not isinstance(vocabulary, list) or len(vocabulary) > 100:
        raise ValueError('Vocabulary must contain at most 100 terms')
    seen, paths = set(), {}
    for entry in vocabulary:
        if not isinstance(entry, dict) or set(entry) - {'term', 'path', 'type', 'required'}:
            raise ValueError('Vocabulary entries contain term, path, type and optional required')
        term, path, kind = entry.get('term'), entry.get('path'), entry.get('type', 'any')
        if not isinstance(term, str) or len(term) > 120 or not _TERM.fullmatch(term):
            raise ValueError('Business terms must use words separated by single spaces')
        if set(term.lower().split()) & _RESERVED or term.lower() in seen:
            raise ValueError('Business terms must be unique and cannot contain language keywords')
        if not isinstance(path, str) or len(path) > 256 or not _PATH.fullmatch(path):
            raise ValueError('Vocabulary paths must be public dot-separated JSON fields')
        if not isinstance(kind, str) or kind not in _TYPES or type(entry.get('required', False)) is not bool:
            raise ValueError('Invalid vocabulary type or required flag')
        if path in paths and paths[path] != kind:
            raise ValueError('Terms for the same path must declare the same type')
        paths[path] = kind
        seen.add(term.lower())
    return vocabulary


def replace_terms(text, vocabulary=None):
    """Replace terms in an unquoted fragment, longest first, in a single pass."""
    entries = validate_vocabulary(vocabulary)
    if not entries:
        return text
    trie = {}
    for entry in entries:
        node = trie
        for char in entry['term'].lower():
            node = node.setdefault(char, {})
        node[None] = entry['path']

    def word_or_dot(char):
        return char == '.' or char == '_' or char.isalnum()

    def match(start):
        node, end, found = trie, start, None
        while end < len(text) and text[end].isascii():
            node = node.get(text[end].lower())
            if node is None:
                break
            end += 1
            if None in node and (end == len(text) or not word_or_dot(text[end])):
                found = end, node[None]
        return found

    result, last, index = [], 0, 0
    while index < len(text):
        if index and word_or_dot(text[index - 1]):
            index += 1
            continue
        start = index
        if text[index:index + 3].lower() == 'the' and index + 3 < len(text) and text[index + 3].isspace():
            start = index + 4
            while start < len(text) and text[start].isspace():
                start += 1
        found = match(start) or (match(index) if start != index else None)
        if found:
            end, path = found
            result.extend((text[last:index], path))
            last = index = end
        else:
            index += 1
    result.append(text[last:])
    return ''.join(result)


def validate_vocabulary_values(context, vocabulary=None, check_required=True):
    for entry in validate_vocabulary(vocabulary):
        value = context
        for part in entry['path'].split('.'):
            if not isinstance(value, dict) or part not in value:
                value = _MISSING
                break
            value = value[part]
        if value is _MISSING:
            if check_required and entry.get('required', False):
                raise ValueError(f"Missing required business term: {entry['term']}")
            continue
        kind = entry.get('type', 'any')
        valid = {
            'any': True,
            'string': isinstance(value, str),
            'number': type(value) in (int, float) and math.isfinite(value),
            'integer': type(value) is int,
            'boolean': type(value) is bool,
            'object': isinstance(value, dict),
            'array': isinstance(value, list),
            'null': value is None,
        }[kind]
        if not valid:
            raise ValueError(f"Business term {entry['term']} requires type {kind}")
