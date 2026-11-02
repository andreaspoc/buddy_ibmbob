import assert from 'node:assert/strict';

export function runStreamMarkdownChecks({streamMarkdown, marked}) {
const path = '/knowledge/12345678-1234-1234-1234-123456789abc/file';
const citation = `[Report.pdf, page 2](${path}?citation=abc "Exact quote (with parentheses).")`;
// Exercise every chunk boundary: labels, URLs and supporting quotes never flash.
for (let i = 1; i < citation.length; i++) {
  const output = streamMarkdown('Claim. ' + citation.slice(0, i));
  assert.ok(output === 'Claim. ' || output === `Claim. [Source](${path}#stream-pending)`, output);
}
assert.equal(streamMarkdown('Claim. ' + citation), 'Claim. ' + citation);
assert.equal(streamMarkdown('[1]'), '[1]');
assert.equal(streamMarkdown('Value \\[unchanged'), 'Value \\[unchanged');
assert.equal(streamMarkdown('`[literal](unfinished`'), '`[literal](unfinished`');
assert.equal(streamMarkdown('```text\n[literal](unfinished'), '```text\n[literal](unfinished');
assert.equal(streamMarkdown('~~~text\n[literal](unfinished'), '~~~text\n[literal](unfinished');
assert.equal(streamMarkdown('```text\n[x]\n```\nClaim [Report'), '```text\n[x]\n```\nClaim ');
assert.equal(streamMarkdown('[Link](https://example.com/a_(b))'), '[Link](https://example.com/a_(b))');
assert.equal(streamMarkdown('[Link](https://example.com'), 'Link');
assert.equal(streamMarkdown(citation + ' Another [Report'), citation + ' Another ');
console.log('Streaming Markdown checks passed');

const web = '[Official release](https://example.com/releases "Release notes")';
for (let i=web.indexOf('https://')+8;i<web.length;i++) {
 const shown=streamMarkdown('Evidence: '+web.slice(0,i));
 assert.equal(shown,'Evidence: Official release');
 assert.ok(!shown.includes('https:'));
}
assert.equal(streamMarkdown('Evidence: '+web+' More text'),'Evidence: '+web+' More text');

const answer = 'First supported claim. [Source 1][kb1]\n\nThe rest of the answer arrives immediately.\n\n';
const definition = `[kb1]: ${path}?citation=abc "Exact supporting sentence."`;
assert.equal(streamMarkdown(answer), answer.replace('[Source 1][kb1]', '[1]'));
for (let i = 1; i <= definition.length; i++) {
  const output = streamMarkdown(answer + definition.slice(0, i));
  assert.ok(output.includes('The rest of the answer arrives immediately.'), output);
  assert.ok(!output.includes('/knowledge/'), output);
  assert.ok(!output.includes('Exact supporting'), output);
}
assert.equal(streamMarkdown(answer + definition + '\n'), answer + definition + '\n');
const resolved = marked.parse(streamMarkdown(answer + definition + '\n'));
assert.ok(resolved.includes(`href="${path}?citation=abc"`));
assert.ok(resolved.includes('title="Exact supporting sentence."'));
assert.ok(!resolved.includes('[kb1]:'));
assert.equal(streamMarkdown('`[Source 1][kb1]`'), '`[Source 1][kb1]`');
assert.equal(streamMarkdown('```text\n[Source 1][kb1]\n[kb1]: example\n```'),
  '```text\n[Source 1][kb1]\n[kb1]: example\n```');
console.log('Deferred knowledge reference checks passed');

}
