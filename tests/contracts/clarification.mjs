import assert from 'node:assert/strict';

export function runClarificationChecks(runtime) {
const {parseClarifications, clarificationReply} = runtime;
const card = '```bobquestion\n{"question":"Who is the audience?","options":["Executives","Engineers"]}\n```';
assert.equal(parseClarifications('Before\n'+card+'\nAfter').text, 'Before\nAfter');
assert.equal(parseClarifications(card).questions.length, 1);
assert.equal(parseClarifications('```text\n'+card+'\n```').questions.length, 0);
assert.equal(parseClarifications('```bobquestion\n{bad}\n```').questions.length, 0);
assert.equal(parseClarifications('```bobquestion\n{', true).text, '');
assert.equal(parseClarifications('```bobquestion\n{').text, '```bobquestion\n{');
assert.equal(parseClarifications(card.replace('Engineers','Executives')).questions.length, 0);
assert.equal(clarificationReply(parseClarifications(card).questions, ['Mixed audience']), 'Mixed audience');
const nextStep = 'What insider threat controls should Company A consider after this case?';
assert.equal(clarificationReply([{question: 'What would you like to do next?', options: [nextStep]}], [nextStep]), nextStep);
assert.equal(clarificationReply([{question: 'Audience?', options: []}, {question: 'Tone?', options: []}], ['Managers', 'Brief']), 'Audience?\nManagers\n\nTone?\nBrief');
assert.equal(parseClarifications('```bobquestion\n{"preset":"operational-triage"}\n```').questions.length, 3);
assert.equal(parseClarifications('```bobquestion\n{"preset":"data-analysis"}\n```').questions.length, 2);
console.log('10 clarification frontend checks passed');


// Every prefix of a streamed question opener must stay hidden, while prose
// and ordinary code remain visible. The answer preceding it stays unchanged.
for (let i = 1; i <= card.length; i++) {
  const parsed = parseClarifications('Answer.\n' + card.slice(0, i), true);
  assert.equal(parsed.text, 'Answer.', `Question prefix ${i} leaked: ${parsed.text}`);
}
assert.equal(parseClarifications('```python\nprint(1)', true).text, '```python\nprint(1)');
assert.equal(parseClarifications('Use `code` here', true).text, 'Use `code` here');

const {parseNextQuestions} = runtime;
const next = '```bobnext\n{"options":["Compare the approaches","Draft an implementation plan"]}\n```';
assert.equal(parseNextQuestions('Answer.\n' + next).text, 'Answer.');
assert.equal(parseNextQuestions(next).options.length, 2);
for (let i=1; i<=next.length; i++) assert.equal(parseNextQuestions('Answer.\n'+next.slice(0,i), true).text, 'Answer.');
assert.equal(parseNextQuestions('````text\n'+next+'\n````').options.length, 0);
assert.equal(parseNextQuestions(next.replace('Draft an implementation plan','Compare the approaches')).options.length, 0);
assert.equal(parseClarifications('  '+card.replaceAll('\n```','\n  ```')).questions.length, 1);
assert.equal(parseClarifications('```bobquestion\n['+JSON.stringify({question:'Audience?',options:['A','B']})+']\n```').questions.length, 1);

// Markdown follow-up questions fallback tests
const mdFlat = 'Here is the summary.\n\n### Follow-up Questions\n- Add animations to charts\n- Include KPI summary\n- Export to PDF';
const parsedMdFlat = parseClarifications(mdFlat);
assert.equal(parsedMdFlat.text, 'Here is the summary.');
assert.equal(parsedMdFlat.questions.length, 1);
assert.equal(parsedMdFlat.questions[0].question, 'What would you like to do next?');
assert.deepEqual(parsedMdFlat.questions[0].options, ['Add animations to charts', 'Include KPI summary', 'Export to PDF']);

// While streaming, markdown fallback must not trigger prematurely
assert.equal(parseClarifications(mdFlat, true).questions.length, 0);

// Numbered follow-up questions
const mdNumbered = 'Deck ready.\n\n**Follow-up questions:**\n1. Would you like to review slide 2?\n2. Should we add animations?';
const parsedMdNum = parseClarifications(mdNumbered);
assert.equal(parsedMdNum.text, 'Deck ready.');
assert.equal(parsedMdNum.questions.length, 1);
assert.deepEqual(parsedMdNum.questions[0].options, ['Would you like to review slide 2?', 'Should we add animations?']);

// Nested questions with bullet options
const mdNested = 'Report finished.\n\nFollow-up questions:\n1. Target audience?\n   - Executives\n   - Technical team\n2. Detail level?\n   - High-level\n   - Comprehensive';
const parsedMdNested = parseClarifications(mdNested);
assert.equal(parsedMdNested.text, 'Report finished.');
assert.equal(parsedMdNested.questions.length, 2);
assert.equal(parsedMdNested.questions[0].question, 'Target audience?');
assert.deepEqual(parsedMdNested.questions[0].options, ['Executives', 'Technical team']);
assert.equal(parsedMdNested.questions[1].question, 'Detail level?');
assert.deepEqual(parsedMdNested.questions[1].options, ['High-level', 'Comprehensive']);

// Code block containing follow-up comments must not be parsed as a form
const mdCode = 'Here is script:\n```python\n# Follow-up questions:\n# 1. Option A\n# 2. Option B\n```';
assert.equal(parseClarifications(mdCode).questions.length, 0);

// Presets for follow-up and next steps
assert.equal(parseClarifications('```bobquestion\n{"preset":"presentation-followup"}\n```').questions.length, 1);
assert.equal(parseClarifications('```bobquestion\n{"preset":"next-steps"}\n```').questions.length, 1);
assert.equal(parseClarifications('```bobquestion\n{"preset":"presentation-review"}\n```').questions.length, 1);

// Trailing text on closing fence line must be preserved and options parsed
const userCase = '```bobnext\n{"options":["Export to Word","Breakdown Phase 2","Draft DDL"]}\n```The project plan covers all sections.';
const parsedUserCase = parseNextQuestions(userCase);
assert.deepEqual(parsedUserCase.options, ['Export to Word', 'Breakdown Phase 2', 'Draft DDL']);
assert.equal(parsedUserCase.text, 'The project plan covers all sections.');

// Raw JSON options fallback
const rawJsonCase = 'Here is the summary.\n\n{"options":["Action A","Action B"]}';
const parsedRawJson = parseNextQuestions(rawJsonCase);
assert.deepEqual(parsedRawJson.options, ['Action A', 'Action B']);
assert.equal(parsedRawJson.text, 'Here is the summary.');

// Generic json fence fallback
const fenceJsonCase = 'Here is the summary.\n```json\n{"options":["Action X","Action Y"]}\n```';
const parsedFenceJson = parseNextQuestions(fenceJsonCase);
assert.deepEqual(parsedFenceJson.options, ['Action X', 'Action Y']);
assert.equal(parsedFenceJson.text, 'Here is the summary.');

// Trailing text on bobquestion closing fence
const questionTrailing = '```bobquestion\n{"question":"Audience?","options":["A","B"]}\n```Closing remark.';
const parsedQTrailing = parseClarifications(questionTrailing);
assert.equal(parsedQTrailing.questions.length, 1);
assert.equal(parsedQTrailing.text, 'Closing remark.');

console.log('Suggestion streaming, contextual form, and markdown follow-up fallback checks passed');

}
