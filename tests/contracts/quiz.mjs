import assert from 'node:assert/strict';

export function runQuizChecks(runtime) {
const value = {title:'Synthetic quiz', questions:[{id:'q1',type:'single',question:'Which option?',options:['A','B'],answer:[1],explanation:'PRIVATE EXPLANATION',source:'PRIVATE SOURCE'},{id:'q2',type:'text',question:'Explain?',answer:'PRIVATE ANSWER',rubric:'PRIVATE RUBRIC',explanation:'PRIVATE EXPLANATION'}]};
const raw = JSON.stringify(value);
const block = '\n```bobquiz\n'+raw+'\n```';
for(let i=1;i<=block.length;i++) {
  const parsed = runtime.parseQuizzes('Intro.'+block.slice(0,i),true);
  assert.ok(!parsed.text.includes('PRIVATE'));
  assert.ok(!parsed.text.includes('"answer"'));
  assert.equal(parsed.quizzes.length,0);
}
const parsed = runtime.parseQuizzes('Intro.'+block,false);
assert.equal(parsed.text,'Intro.');
assert.equal(parsed.quizzes.length,1);
assert.ok(!JSON.stringify(parsed.quizzes).includes('PRIVATE'));
assert.ok(!('answer' in parsed.quizzes[0].questions[0]));
assert.equal(runtime.parseQuizzes('```bobquiz\n{"answer":"PRIVATE"}\n```').error,true);
assert.equal(runtime.parseQuizzes('```bobquiz\n{"answer":"PRIVATE"}').text,'');
const submitted = runtime.quizSubmission(parsed.quizzes[0].key,{q1:[1],q2:'Written response'});
assert.deepEqual(runtime.submittedQuizAnswers(submitted,parsed.quizzes[0].key),{q1:[1],q2:'Written response'});
assert.equal(runtime.submittedQuizAnswers(submitted,'00000000'),undefined);
assert.equal(runtime.parseQuizzes('Example:\n````text\n'+block+'\n````').quizzes.length,0);
assert.equal(runtime.parseQuizzes('Example:\n````text title="example"\n'+block+'\n````').quizzes.length,0);
console.log('PASS: every streaming prefix hides grading fields; public schema, invalid blocks and submission parsing');

const review={quiz_key:'01234567',title:'Synthetic review',reading_status:'Verified reading',questions:[{id:'q1',question:'Which?',submitted_answer:['A'],correct_answer:['B'],score:0,explanation:'Correct explanation',study_topic:'General concept',resources:[{title:'Official source',url:'https://example.edu/concept',why:'Read the concept',verified:true}]}]};
const reviewBlock='\n```bobquizresult\n'+JSON.stringify(review)+'\n```';
for(let i=1;i<=reviewBlock.length;i++) {
 const result=runtime.parseQuizResults('Review'+reviewBlock.slice(0,i),true);
 assert.equal(result.results.length,0);
 assert.ok(!result.text.includes('Correct explanation'));
}
assert.equal(runtime.parseQuizResults(reviewBlock).results[0].percentage,0);
review.questions[0].resources[0].url='javascript:alert(1)';
assert.equal(runtime.parseQuizResults('```bobquizresult\n'+JSON.stringify(review)+'\n```').error,true);
console.log('PASS: review streaming concealment, canonical totals and unsafe reading links');

const structured = {...value, learning_objectives:['Understand concepts'], sections:[{id:'foundation',title:'Foundations',answer:'PRIVATE'}], questions:value.questions.map(q=>({...q,section_id:'foundation',topic:'Concepts',learning_objective:'Identify concepts',difficulty:'easy'}))};
const parseStructured = v => runtime.parseQuizzes('```bobquiz\n'+JSON.stringify(v)+'\n```');
const publicStructured = parseStructured(structured).quizzes[0];
assert.deepEqual(publicStructured.sections,[{id:'foundation',title:'Foundations'}]);
assert.deepEqual(publicStructured.learning_objectives,['Understand concepts']);
assert.equal(publicStructured.questions[0].difficulty,'easy');
assert.ok(!JSON.stringify(publicStructured).includes('PRIVATE'));
for (const mutate of [v=>v.questions[0].section_id='missing',v=>v.sections.push(v.sections[0]),v=>v.questions[0].difficulty='invalid',v=>v.learning_objectives=[null],v=>v.questions[0].topic='']) {
 const invalid=structuredClone(structured); mutate(invalid); assert.equal(parseStructured(invalid).error,true);
}
console.log('PASS: structured metadata, legacy compatibility and invalid section references');

}
