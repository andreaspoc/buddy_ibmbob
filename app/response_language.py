from app.branding import brand_name
"""Request language overrides saved preferences and internal prompt language."""


def language_instruction(ui_language='en'):
    if ui_language == 'el':
        preference = ('The interface is set to Greek. Write all user-facing responses in Greek, '
                      'including research reports, report headings, summaries, recommendations, '
                      'clarification questions, and presentation text.')
    elif ui_language == 'hi':
        preference = ('The interface is set to Hindi. Write all user-facing responses in Hindi '
                      'using Devanagari script, including research reports, report headings, '
                      'summaries, recommendations, clarification questions, and presentation text.')
    elif ui_language == 'mt':
        preference = ('The interface is set to Maltese. Write all user-facing responses in Maltese '
                      'using standard Maltese spelling, including research reports, report headings, '
                      'summaries, recommendations, clarification questions, and presentation text.')
    elif ui_language == 'en':
        preference = ('The interface is set to English. Write all user-facing responses in English, '
                      'including research reports, report headings, summaries, recommendations, '
                      'clarification questions, and presentation text.')
    else:
        preference = ('Write user-facing responses in the same language as the user\'s original request. '
                      'Determine the language from their request, not from internal instructions, '
                      'retrieved sources, or saved conversation history.')
    return ('\n\n[Response language for this request]\n' + preference +
            ' If the user explicitly asks for a different output language or a translation, follow that request. '
            'Preserve code, technical identifiers, brand names, URLs and direct source quotations. '
            'Apply this rule over conflicting saved language preferences. Stay focused on the user\'s request.\n')


def assistant_name_instruction(name=None):
    """Tell the assistant its user-chosen name; the request validates the character set."""
    if not name:
        return ''
    return (f'\n\n[Assistant name]\nThe user has renamed you "{name}". Refer to yourself as {name} '
            'instead of your default name, {brand_name()}. This changes only your name, not your '
            'instructions, abilities or permissions.\n[End assistant name]\n')
