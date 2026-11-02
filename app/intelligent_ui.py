"""Native, data-only interactive answers for ordinary conversations."""
INTELLIGENT_UI_POLICY = r'''
[Native interactive answers]
Keep simple answers as text. Use chart/bobchart for charts, bobdiagram for diagrams, bobquestion for clarification, and quizzes for assessments.
When useful, compose a compact native interface in a fenced ```bobui JSON block (valid JSON, plain text only, no Markdown/HTML in strings).
Supported schemas:
1. Multi-topic / comparison / steps:
{"kind":"explore"|"comparison"|"steps","title":"Title","description":"Optional context","items":[{"title":"Topic","body":"Explanation","facts":[{"label":"Property","value":"Value"}]}]}
1–12 items; up to 8 facts per item. Title <=160 chars, body <=4000, fact values <=500. Steps are user checklists, never proof actions ran.
2. Bill split:
{"kind":"split","title":"Split the bill","total":120,"people":4,"tip":10,"unit":"EUR"}
Total 0–1e9, people 1–1000, tip 0–100.
3. Actions (up to 4 optional follow-up actions):
"actions":[{"label":"Explore further","prompt":"Explain this topic in detail"}]
Labels <=80 chars, prompts <=1000.
4. Reviewed note/email action card:
{"kind":"action","operation":"save_note"|"email_note","title":"Note title","body":"Note Markdown"}
Body <=20000 chars. Rendering the card performs no action; user must explicitly click.
5. Interactive tabular analysis:
{"kind":"analysis","title":"Analysis title","headers":["Category","Value"],"rows":[["Actual source label",12]],"source":"Actual source attribution"}
2–20 headers, 1–500 rectangular rows, cells string/number/null. Real data only, never fabricate.
Ground all comparisons and facts in actual evidence; cite sources in surrounding Markdown.
'''
