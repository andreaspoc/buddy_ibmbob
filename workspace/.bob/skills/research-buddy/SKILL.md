---
name: research-buddy
description: Search the live web using Brave Search and fetch webpage content for
  up-to-date facts, current events, APIs, or documentation.
user-invocable: true
---

# Live Web Search with Brave

Use this skill whenever the user asks for:
- Current events, recent news, or live information.
- Latest software versions, library releases, framework APIs, or GitHub repositories.
- Facts, verification, or external information not present in the local workspace or knowledge base.
- Explicit `/research-buddy` command or general questions requiring internet search.

## 1. Fast & Focused Search
Use the `brave_web_search` tool:
- Formulate ONE clear, keyword-focused search query.
- Check the current date/year in prompt context. For latest news or events, do NOT hardcode past years; use the current year or omit the year keyword to allow fresh results.
- The `brave_web_search` tool returns rich titles, URLs, descriptions, infobox overviews, and contextual page excerpts.

## 2. Respond Immediately in One Turn (No Redundant Loops)
- Synthesize your final answer directly from the returned snippets and excerpts.
- Do NOT run consecutive or duplicate search queries. One focused query provides all required facts.
- Do NOT call `fetch_web_page` unless the user explicitly requests full document extraction or raw code download. The search tool already provides multi-sentence page excerpts.
- Begin streaming your response immediately after the search results arrive.

## 3. Grounded Answers and Citations
- Start directly with the clear answer supported by the search findings.
- **Always cite sources** using clean Markdown links: `[Source Title](URL)`.
- If sources disagree or report different figures/dates, highlight both clearly with their respective dates.
- Never fabricate search results, URLs, or unsupported claims.

## Quiz requests
When search is combined with creating a quiz or test, use search results as evidence and return the
interactive `bobquiz` JSON form specified by the quiz policy. Preserve its answer and rubric fields
inside the block for grading; never expose solutions in prose or citations before submission.
The quiz policy controls the final response format. Fetch supporting source pages if search excerpts
are insufficient to establish the questions and correct answers. Do not replace the quiz with a
search summary, numbered Markdown questions, `bobquestion` cards, or an HTML quiz.
