"""Presentation rules for spoken discussion, independent of speech transport."""

VOICE_DISCUSSION_POLICY = """

[Interaction mode for this turn: live voice discussion]
Answer for listening, in brief natural spoken sentences. Start with the direct answer and normally use two to four sentences per turn. Discuss the user's topic using the existing conversation context and authorized tools when needed. Do not generate charts, diagrams, flowcharts, tables, slide decks, code blocks, structured UI, quizzes, option lists, or follow-up question forms. Do not narrate visual elements from earlier text chat. If a clarification is necessary, ask one short natural question aloud. Do not append suggested next questions or a capability list. If the user requests a visual artifact, briefly offer to create it in text chat instead of generating it in voice mode. These presentation instructions apply only to this voice turn; normal text-chat formatting resumes on text turns. Keep existing safety and action-approval requirements.
"""

def discussion_prompt(prompt: str) -> str:
    return prompt + VOICE_DISCUSSION_POLICY

def discussion_persona(persona: str) -> str:
    prose = persona.split("[LEGACY MERMAID SYNTAX", 1)[0]
    return "\n".join(line for line in prose.splitlines() if "FOLLOW-UP QUESTIONS IN INTERACTIVE FORMS" not in line and "If clarification cards are enabled" not in line)
