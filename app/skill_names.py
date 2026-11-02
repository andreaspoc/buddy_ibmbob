"""Canonical Buddy skill identifiers and lossless descriptor migration."""
from __future__ import annotations
import hashlib
import re
import yaml

BUILTIN_SKILL_NAMES = {
    'data-analyst': 'data-buddy', 'interactive-presentations': 'presentation-buddy',
    'web-search': 'research-buddy', 'rag': 'knowledge-buddy',
    'code-review-lite': 'code-review-buddy', 'a2a-agent': 'agent-buddy',
}


def canonical_skill_name(name: str) -> str:
    if name in BUILTIN_SKILL_NAMES:
        return BUILTIN_SKILL_NAMES[name]
    if name.endswith('-buddy'):
        return name
    base = re.sub(r'-(skill|agent)$', '', name)
    return base[:58].rstrip('-') + '-buddy'


def rename_descriptor(content: bytes, name: str) -> bytes:
    text = content.decode('utf-8')
    match = re.match(r'\A---\r?\n(.*?)\r?\n---(?:\r?\n|\Z)', text, re.DOTALL)
    metadata = yaml.safe_load(match.group(1)) if match else {}
    if not isinstance(metadata, dict):
        raise ValueError('Invalid skill frontmatter')
    metadata['name'] = name
    body = text[match.end():] if match else text
    return ('---\n' + yaml.safe_dump(metadata, sort_keys=False, allow_unicode=True).rstrip()
            + '\n---\n' + body).encode('utf-8')


def descriptor_name(content: bytes, fallback: str) -> str:
    match = re.match(rb'\A---\r?\n(.*?)\r?\n---(?:\r?\n|\Z)', content, re.DOTALL)
    metadata = yaml.safe_load(match.group(1)) if match else {}
    return str(metadata.get('name', fallback)) if isinstance(metadata, dict) else fallback


def migration_plan(descriptors: dict[str, bytes]) -> dict[str, tuple[str, str]]:
    """Existing Buddy folders win; collisions retain both skills with stable names."""
    occupied = set(descriptors)
    result = {}
    for folder, content in sorted(descriptors.items(), key=lambda item: (not item[0].endswith('-buddy'), item[0])):
        old_name = descriptor_name(content, folder)
        target = canonical_skill_name(old_name)
        if target != folder and target in occupied:
            suffix = hashlib.sha256(folder.encode()).hexdigest()[:8]
            target = target[:-6][:49].rstrip('-') + '-' + suffix + '-buddy'
            while target in occupied:
                suffix = hashlib.sha256((folder + suffix).encode()).hexdigest()[:8]
                target = target[:-15][:49].rstrip('-') + '-' + suffix + '-buddy'
        occupied.add(target)
        result[folder] = (old_name, target)
    return result
