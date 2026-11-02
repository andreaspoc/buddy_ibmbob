import { createRequire } from 'node:module';
const require = createRequire(new URL('../web/package.json', import.meta.url));
export function transpile(source, commonjs = false) {
  try {
    const ts = require('typescript');
    return ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: commonjs ? ts.ModuleKind.CommonJS : ts.ModuleKind.ESNext, jsx: ts.JsxEmit.React } }).outputText;
  } catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error;
    const babel = require('@babel/core');
    return babel.transformSync(source, { filename: 'fixture.tsx', configFile: false, babelrc: false,
      plugins: [require('@babel/plugin-transform-typescript'), ...(commonjs ? [require('@babel/plugin-transform-modules-commonjs')] : [])],
    }).code;
  }
}
