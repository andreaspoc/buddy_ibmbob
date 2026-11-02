"""Compact conversation topics without an extra model request before streaming."""
import re


def conversation_title(prompt: str) -> str | None:
    text = str(prompt or '').strip()
    attachments = re.findall(r'\[Attached (?:spreadsheet|file|document):\s*([^\]\n]+)', text, re.I)
    text = re.sub(r'\[Attached[^\]]*\]', '', text, flags=re.I).strip()
    text = re.sub(r'^/(?:[\w-]+)\s*', '', text)
    text = re.sub(r'\s+', ' ', text).strip()
    if re.fullmatch(r'(?:hi|hello|hey|thanks|thank you|hi how are you|how are you)[?!., ]*', text, re.I):
        return None
    if not text:
        if not attachments:
            return None
        text = re.sub(r'\.(?:xlsx?|csv|pdf|docx?)\b.*$', '', attachments[0], flags=re.I).replace('_', ' ') + ' analysis'
    if re.match(r'Synthesize our conversation', text, re.I):
        return 'Executive presentation'
    # Remove conversational wrappers while retaining the subject and action.
    text = re.sub(r'^(?:(?:hi|hello|hey)[,!]?\s+)?(?:please\s+)?(?:can you|could you|would you)\s+', '', text, flags=re.I)
    text = re.sub(r'^(?:please\s+|i (?:want|need)(?: you to)?\s+|help me\s+)+', '', text, flags=re.I)
    text = re.sub(r'^(?:check (?:the )?(?:docs|documents) and\s+)?(?:tell me about|give me (?:information|info) (?:on|about)|(?:need )?(?:information|info) (?:on|about|for))\s+', '', text, flags=re.I)
    text = re.sub(r'^(?:create|make|build|prepare|generate) (?:a|an)\s+', 'Create ', text, flags=re.I)
    text = re.sub(r'\b(?:\d+-slide|4-to-5-slide|high-impact|C-level|executive)\s+', '', text, flags=re.I)
    presentation_topic = re.search(r'\b(?:presentation|deck)\s+(?:about|on|introducing|for)\s+(.+)', text, re.I)
    if presentation_topic:
        text = presentation_topic[1].rstrip('?!., ') + ' presentation'
    text = re.sub(r'\b(?:pptx|powerpoint)\b', 'PowerPoint', text, flags=re.I)
    text = re.sub(r'\bhtml\b', 'HTML', text, flags=re.I)
    text = re.split(r'[\n?!;]|\.(?:\s|$)', text, maxsplit=1)[0]
    text = re.sub(r'[`*#\[\]]', '', text).strip(' :,.')
    words = text.split()
    title = ''
    for word in words[:6]:
        if len(title) + len(word) + bool(title) > 42:
            break
        title += (' ' if title else '') + word
    while title.split() and title.split()[-1].lower() in {'and', 'or', 'for', 'with', 'the', 'a', 'an', 'to', 'of', 'about', 'on', 'in'}:
        title = title.rsplit(' ', 1)[0] if ' ' in title else ''
    if not title:
        return 'File discussion' if attachments else 'Conversation'
    return title[0].upper() + title[1:]
