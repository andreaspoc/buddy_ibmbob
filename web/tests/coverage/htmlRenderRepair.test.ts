// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SCRIPT_ERROR_REPORTER, repairHtmlForRender, repairOptionalAssignments as repair } from '../../src/lib/htmlRenderRepair';

const parses = (code: string) => { new Function(code); return true; };

describe('repairOptionalAssignments', () => {
  it('repairs the real dashboard failure and keeps its behaviour', () => {
    const broken = "const q=id=>els[id];q('a')?.style&&(q('a')?.style.display='block');q('b')?.style&&(q('b')?.style.display='block');";
    expect(() => new Function('els', broken)).toThrow(SyntaxError);
    const fixed = repair(broken);
    const els: Record<string, { style: { display: string } }> = { a: { style: { display: '' } } };
    expect(() => new Function('els', fixed)(els)).not.toThrow();
    expect(els.a.style.display).toBe('block');
  });

  it.each([
    ['a?.b = 1', { b: 0 }, (o: Row) => o.b === 1],
    ['a?.b.c = 1', { b: { c: 0 } }, (o: Row) => (o.b as Row).c === 1],
    ['a?.b?.c = 1', { b: { c: 0 } }, (o: Row) => (o.b as Row).c === 1],
    ["a?.['b'] = 1", { b: 0 }, (o: Row) => o.b === 1],
    ["a?.b['c'] = 1", { b: { c: 0 } }, (o: Row) => (o.b as Row).c === 1],
    ['a.b?.c = 1', { b: { c: 0 } }, (o: Row) => (o.b as Row).c === 1],
    ['a?.f(1).c = 2', { f: () => holder }, () => holder.c === 2],
  ])('assigns through %s when the object exists', (code, target, check) => {
    new Function('a', repair(code))(target);
    expect(check(target as Row)).toBe(true);
  });

  it('does nothing harmful when the object is missing', () => {
    expect(() => new Function('a', repair('a?.b.c = 1;'))(null)).not.toThrow();
  });

  it('repairs a call-based root containing brackets and strings', () => {
    const fixed = repair("get(['x'][0], 'y')?.z = 1");
    const target = { z: 0 };
    new Function('get', fixed)(() => target);
    expect(target.z).toBe(1);
  });

  it.each([
    'const a = b?.c;', 'if (a?.b == 1) x();', 'if (a?.b === 1) x();', 'const f = a?.b => 1;'.replace('a?.b', 'c'),
    'const v = t ? .5 : 1;', 'const v = t?.5:1;', 'a?.b();', 'a?.b().c;', "const s = 'a?.b = 1';", 'const s = "a?.b = 1";',
    'const s = `a?.b = 1`;', '// a?.b = 1', '/* a?.b = 1 */', "const s = 'it\\'s a?.b = 1';", 'a?.;', 'a?.b(', 'a?.[1', 'a?.b[1', ')?.b = 1', '1?.b = 2',
  ])('leaves %s untouched', code => {
    expect(repair(code)).toBe(code);
  });

  it('leaves a call used as an assignment target for the error report', () => {
    expect(repair('a?.b() = 1')).toBe('a?.b() = 1');
  });

  it('handles unterminated strings and comments without hanging', () => {
    for (const code of ["'open", '/* open', '// open', '`open', '"esc\\']) expect(repair(code)).toBe(code);
  });

  it('copes with unbalanced brackets around a target', () => {
    expect(repair('(] x)?.b = 1')).toBe('(] x)?.b = 1');
    expect(repair('a?.b[(].c = 1')).toBe('a?.b[(].c = 1');
    expect(repair('a?.b(].c = 1')).toBe('a?.b(].c = 1');
  });

  it('keeps surrounding code and repairs several statements', () => {
    const fixed = repair('let n = 1; a?.b = 2; n = 3; a?.c = 4; n = 5;');
    expect(parses(fixed)).toBe(true);
    expect(fixed.startsWith('let n = 1; ')).toBe(true);
    expect(fixed.endsWith('; n = 5;')).toBe(true);
  });
});

describe('repairHtmlForRender', () => {
  it('repairs inline scripts only', () => {
    const page = '<p>a?.b = 1</p><script>a?.b = 1</script><script type="text/javascript">a?.c = 1</script><script type="module">a?.d = 1</script>';
    const fixed = repairHtmlForRender(page);
    expect(fixed).toContain('<p>a?.b = 1</p>');
    expect(fixed).toContain('(a ?? {}).b = 1');
    expect(fixed).toContain('(a ?? {}).c = 1');
    expect(fixed).toContain('(a ?? {}).d = 1');
  });

  it.each(['<script src="x.js">a?.b = 1</script>', '<script type="application/json">{"k":"a?.b = 1"}</script>', '<script type=text/plain>a?.b = 1</script>'])('leaves %s alone', page => {
    expect(repairHtmlForRender(page)).toBe(page);
  });

  it('removes a warning saved in the file and leaves healthy pages identical', () => {
    expect(repairHtmlForRender('<body><div id="bob-script-error" role="alert" style="x">Bad</div><p>Kept</p></body>')).toBe('<body><p>Kept</p></body>');
    const healthy = '<body><script>const a = b?.c;</script></body>';
    expect(repairHtmlForRender(healthy)).toBe(healthy);
  });
});

describe('SCRIPT_ERROR_REPORTER', () => {
  const body = SCRIPT_ERROR_REPORTER.replace(/^<script[^>]*>/, '').replace(/<\/script>$/, '');
  const warnings = () => document.querySelectorAll('#bob-script-error');
  const scriptPage = (scripts: string) => { document.body.innerHTML = `<p>Page</p>${scripts}`; };
  const run = (state = 'complete') => {
    const listeners: Record<string, (event: { message?: string }) => void> = {};
    const add = (type: string, listener: (event: { message?: string }) => void) => { listeners[type] = listener; };
    const fake = new Proxy(document, { get: (target, key) => (key === 'readyState' ? state : Reflect.get(target, key)) });
    const bound = new Proxy(fake, { get: (target, key) => { const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(document) : value; } });
    new Function('addEventListener', 'document', body)(add, bound);
    return listeners;
  };

  it('finds a syntax error directly, even though Safari hides the message', () => {
    scriptPage('<script>const = broken(;</script>');
    run();
    expect(warnings()).toHaveLength(1);
    expect(document.body.firstElementChild?.getAttribute('role')).toBe('alert');
  });

  it('waits for the page while it is still loading', () => {
    scriptPage('<script>const = broken(;</script>');
    const listeners = run('loading');
    expect(warnings()).toHaveLength(0);
    listeners.DOMContentLoaded({});
    expect(warnings()).toHaveLength(1);
  });

  it('stays quiet for valid pages, data blocks and external scripts', () => {
    scriptPage('<script>const a = 1;</script><script type="text/javascript">const b = 2;</script><script type="application/json">{not js</script><script type="text/plain">(</script><script src="x.js">(</script>');
    run();
    expect(warnings()).toHaveLength(0);
  });

  it('checks explicitly typed JavaScript', () => {
    for (const type of ['text/javascript', ' APPLICATION/JAVASCRIPT ']) {
      scriptPage(`<script type="${type}">const = broken(;</script>`);
      run();
      expect(warnings()).toHaveLength(1);
    }
  });

  it('also reports a syntax error event once, and ignores other errors', () => {
    scriptPage('');
    const listeners = run();
    listeners.error({ message: 'Uncaught TypeError: x' });
    listeners.error({});
    expect(warnings()).toHaveLength(0);
    listeners.error({ message: 'Uncaught SyntaxError: bad' });
    listeners.error({ message: 'Uncaught SyntaxError: again' });
    expect(warnings()).toHaveLength(1);
  });
});

type Row = Record<string, unknown>;
const holder: Row = { c: 0 };

describe('embedded chart library', () => {
  it('passes through the display repair unchanged', () => {
    const library = readFileSync(resolve(__dirname, '../../../app/vendor/chart.umd.min.js'), 'utf8');
    expect(repair(library)).toBe(library);
  });
});
