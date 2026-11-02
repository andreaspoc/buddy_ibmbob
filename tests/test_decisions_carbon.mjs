import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const frontend = path.join(root, 'decisions-buddy');
const require = createRequire(path.join(frontend, 'package.json'));
const sass = require('sass');
const ts = createRequire(path.join(root, 'web/package.json'))('typescript');
const compiled = sass.compile(path.join(frontend, 'src/styles/control-tokens.scss'), { loadPaths: [path.join(frontend, 'node_modules')] }).css;
const rules = name => compiled.match(new RegExp(`\\.${name}\\s*\\{([^}]+)\\}`))?.[1] || '';

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? sourceFiles(path.join(directory, entry.name)) : /\.jsx$/.test(entry.name) ? [path.join(directory, entry.name)] : []);
}

test('productive editor typography compiles to Carbon size, weight and line-height scales', () => {
  assert.match(rules('decisions-type-body-compact-01'), /--cds-body-compact-01-font-size, 0\.875rem/);
  assert.match(rules('decisions-type-body-compact-01'), /--cds-body-compact-01-line-height, 1\.28572/);
  assert.match(rules('decisions-type-label-01'), /--cds-label-01-font-size, 0\.75rem/);
  assert.match(rules('decisions-type-label-01'), /--cds-label-01-line-height, 1\.33333/);
  assert.match(rules('decisions-type-heading-01'), /--cds-heading-01-font-weight, 600/);
  assert.match(rules('decisions-type-heading-02'), /--cds-heading-02-font-size, 1rem/);
  assert.match(rules('decisions-type-heading-03'), /--cds-heading-03-font-size, 1\.25rem/);
  assert.match(rules('decisions-type-code-01'), /IBM Plex Mono/);
});

test('editor spacing compiles from the Carbon 2/4/8px rhythm', () => {
  assert.match(rules('decisions-gap-01'), /gap: 0\.125rem/);
  assert.match(rules('decisions-gap-03'), /gap: 0\.5rem/);
  assert.match(rules('decisions-p-03-04'), /padding: 0\.5rem 0\.75rem/);
  assert.match(rules('decisions-mt-06'), /margin-top: 1\.5rem/);
});

test('JSX panels cannot override Carbon typography or spacing with inline values', () => {
  const prohibited = /^(fontSize|fontFamily|fontWeight|lineHeight|letterSpacing|gap|columnGap|rowGap|margin(?:Top|Bottom|Left|Right|Inline|Block|InlineStart|InlineEnd)?|padding(?:Top|Bottom|Left|Right|Inline|Block)?)$/;
  const violations = [];
  for (const file of sourceFiles(path.join(frontend, 'src'))) {
    const source = readFileSync(file, 'utf8');
    const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JSX);
    function visit(node) {
      if (ts.isJsxAttribute(node) && node.name.text === 'style' && node.initializer && ts.isJsxExpression(node.initializer) && node.initializer.expression && ts.isObjectLiteralExpression(node.initializer.expression)) {
        for (const property of node.initializer.expression.properties) {
          if (ts.isPropertyAssignment(property) && prohibited.test(property.name.getText(tree))) violations.push(`${path.relative(frontend, file)}: ${property.name.getText(tree)}`);
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(tree);
  }
  assert.deepEqual(violations, []);
});
