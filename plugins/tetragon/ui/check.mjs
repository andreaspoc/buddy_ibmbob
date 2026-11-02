import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = path.dirname(fileURLToPath(import.meta.url));
const web = path.resolve(root, '../../../web');
const require = createRequire(path.join(web, 'package.json'));
const ts = require('typescript');
const program = ts.createProgram([path.join(root,'main.tsx'), path.join(root,'vite-env.d.ts')], {
  target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
  jsx: ts.JsxEmit.ReactJSX, noEmit: true, skipLibCheck: true, strict: true, esModuleInterop: true,
  ignoreDeprecations: '6.0', baseUrl: web, paths: { react: ['node_modules/@types/react'], 'react/*': ['node_modules/@types/react/*'], 'react-dom/*': ['node_modules/@types/react-dom/*'], '@carbon/*': ['node_modules/@carbon/*'] },
  types: ['react', 'react-dom'], typeRoots: [path.join(web,'node_modules/@types')],
});
const diagnostics = ts.getPreEmitDiagnostics(program);
if (diagnostics.length) { console.error(ts.formatDiagnosticsWithColorAndContext(diagnostics, { getCurrentDirectory:()=>root, getCanonicalFileName:s=>s, getNewLine:()=> '\n' })); process.exit(1); }
console.log('Tetragon UI TypeScript check passed');
