import { brandText } from './brand';
/** Repair generated pages as they are displayed, so one known script mistake cannot blank every chart. */
const SAVED_WARNING = /<div id="bob-script-error"[^>]*>[\s\S]*?<\/div>/g;
const INLINE_SCRIPT = /(<script\b[^>]*>)([\s\S]*?)(<\/script>)/gi;
const NON_SCRIPT_TYPE = /\btype\s*=\s*["']?(?!text\/javascript|application\/javascript|module)[^"'\s>]/i;
const IDENTIFIER = /[\w$]/;
const OPENERS: Record<string, string> = { '(': ')', '[': ']' };
const CLOSERS: Record<string, string> = { ')': '(', ']': '[' };

/** Index just past a quoted string, template or comment starting at `start`, or `start` when there is none. */
function skipNonCode(code: string, start: number) {
  const char = code[start];
  if (char === '/' && code[start + 1] === '/') {
    const end = code.indexOf('\n', start);
    return end < 0 ? code.length : end;
  }
  if (char === '/' && code[start + 1] === '*') {
    const end = code.indexOf('*/', start + 2);
    return end < 0 ? code.length : end + 2;
  }
  if (char !== '"' && char !== "'" && char !== '`') return start;
  for (let index = start + 1; index < code.length; index += 1) {
    if (code[index] === '\\') index += 1;
    else if (code[index] === char) return index + 1;
  }
  return code.length;
}

function matchingForward(code: string, open: number) {
  const stack: string[] = [];
  let index = open;
  while (index < code.length) {
    const next = skipNonCode(code, index);
    if (next !== index) { index = next; continue; }
    const char = code[index];
    if (OPENERS[char]) stack.push(OPENERS[char]);
    else if (CLOSERS[char]) {
      if (stack.pop() !== char) return -1;
      if (!stack.length) return index;
    }
    index += 1;
  }
  return -1;
}

function matchingBackward(code: string, close: number) {
  const stack: string[] = [];
  for (let index = close; index >= 0; index -= 1) {
    const char = code[index];
    if (CLOSERS[char]) stack.push(CLOSERS[char]);
    else if (OPENERS[char]) {
      if (stack.pop() !== char) return -1;
      if (!stack.length) return index;
    }
  }
  return -1;
}

/** Start of the member chain ending just before `end`, or -1 when it cannot be identified safely. */
function chainStart(code: string, end: number) {
  let index = end - 1;
  while (index >= 0) {
    const char = code[index];
    if (CLOSERS[char]) {
      index = matchingBackward(code, index);
      if (index < 0) return -1;
      index -= 1;
    } else if (IDENTIFIER.test(char) || char === '.') index -= 1;
    else if (char === '?' && code[index + 1] === '.') index -= 1;
    else break;
  }
  const start = index + 1;
  return start < end && !/^\d/.test(code.slice(start, end)) ? start : -1;
}

/** Walk the members after `?.`; returns where the final member starts and the chain ends, when it is assigned to. */
function assignedMember(code: string, afterOperator: number) {
  let index = afterOperator;
  let last = afterOperator;
  while (index < code.length) {
    last = index;
    if (code[index] === '[') {
      const close = matchingForward(code, index);
      if (close < 0) return null;
      index = close + 1;
    } else {
      const begin = index;
      while (IDENTIFIER.test(code[index] ?? '')) index += 1;
      if (begin === index) return null;
    }
    while (code[index] === '(') {
      const close = matchingForward(code, index);
      if (close < 0) return null;
      index = close + 1;
    }
    if (code[index] === '[') continue;
    if (code[index] === '.') { index += 1; continue; }
    if (code[index] === '?' && code[index + 1] === '.') { index += 2; continue; }
    break;
  }
  let after = index;
  while (/\s/.test(code[after] ?? '')) after += 1;
  if (code[after] !== '=' || code[after + 1] === '=' || code[after + 1] === '>') return null;
  if (code[index - 1] === ')') return null;
  return { last, end: index };
}

/**
 * `a?.b.c = 1` is a syntax error that stops the whole script. Rewrite the target as `(a?.b ?? {}).c = 1`:
 * the assignment still happens when the object exists, and is harmless when it does not.
 */
export function repairOptionalAssignments(code: string) {
  let output = '';
  let copied = 0;
  let index = 0;
  while (index < code.length) {
    const next = skipNonCode(code, index);
    if (next !== index) { index = next; continue; }
    const isOperator = code[index] === '?' && code[index + 1] === '.' && !/\d/.test(code[index + 2] ?? '');
    const member = isOperator ? assignedMember(code, index + 2) : null;
    const start = member ? chainStart(code, index) : -1;
    if (member && start >= copied) {
      const direct = member.last === index + 2;
      const object = code.slice(start, direct ? index : member.last);
      const trimmed = object.replace(/\?\.$|\.$/, '');
      const accessor = code[member.last] === '[' ? '' : '.';
      output += `${code.slice(copied, start)}(${trimmed} ?? {})${accessor}${code.slice(member.last, member.end)}`;
      copied = member.end;
      index = member.end;
    } else index += 1;
  }
  return copied ? output + code.slice(copied) : code;
}

/** Repair inline scripts and drop the saved warning; a script that still cannot run is reported in the frame. */
export function repairHtmlForRender(html: string) {
  return html.replace(SAVED_WARNING, '').replace(INLINE_SCRIPT, (whole, open: string, code: string, close: string) => {
    if (/\bsrc\s*=/i.test(open) || NON_SCRIPT_TYPE.test(open)) return whole;
    return open + repairOptionalAssignments(code) + close;
  });
}

/**
 * Installed before generated scripts: shows a clear message when a script cannot be parsed.
 * Parses the page's scripts directly, because Safari reports only "Script error." inside a sandboxed frame.
 */
export const SCRIPT_ERROR_REPORTER = brandText(`<script id="bob-render-guard">(()=>{
  const show=()=>{if(document.getElementById('bob-script-error'))return;
    const note=document.createElement('div');note.id='bob-script-error';note.setAttribute('role','alert');
    note.style.cssText='background:#ffe8eb;color:#9e1b2e;padding:14px 20px;font:600 14px/1.5 system-ui,sans-serif;border-bottom:2px solid #9e1b2e';
    note.textContent='This dashboard has a script error, so its charts and interactive parts cannot run. Ask Buddy to fix it.';
    document.body.prepend(note);};
  addEventListener('error',event=>{if(/SyntaxError/.test(event.message||'')&&document.body)show();},true);
  const check=()=>{for(const script of document.querySelectorAll('script:not([src])')){
    const type=(script.getAttribute('type')||'').trim().toLowerCase();
    if(type&&type!=='text/javascript'&&type!=='application/javascript')continue;
    try{new Function(script.textContent);}catch(error){if(error instanceof SyntaxError){show();return;}}
  }};
  if(document.readyState==='loading')addEventListener('DOMContentLoaded',check,{once:true});else check();
})();</script>`);
