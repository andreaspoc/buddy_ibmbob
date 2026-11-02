"""Detect language versions that still hold the source text, so they are never published as translated."""
from fastapi import HTTPException

LANGUAGE_NAMES = {'en': 'English', 'el': 'Greek', 'hi': 'Hindi'}


def norm_lang(raw: str | None) -> str:
    code = (raw or 'en').strip().lower().split('-')[0].split('_')[0]
    return code if code in LANGUAGE_NAMES else 'en'


def untranslated_languages(spec: dict, content_key: str) -> list[str]:
    """Return language codes whose steps or questions are identical to the primary language."""
    translations = spec.get('translations')
    if not isinstance(translations, dict):
        return []
    primary = translations.get(norm_lang(spec.get('language')))
    source = primary.get(content_key) if isinstance(primary, dict) else None
    if not source:
        return []
    return sorted(code for code, entry in translations.items()
                  if entry is not primary and isinstance(entry, dict) and entry.get(content_key) == source)


def require_translated(spec: dict, content_key: str) -> None:
    missing = untranslated_languages(spec, content_key)
    if missing:
        names = ', '.join(LANGUAGE_NAMES.get(code, code) for code in missing)
        raise HTTPException(409, f'Not published: the {names} version still contains the original text. '
                                 'Use Generate 3 Languages or edit that language, then publish again.')
