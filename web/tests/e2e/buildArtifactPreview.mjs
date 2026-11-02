import { build } from 'vite';

const [outDir] = process.argv.slice(2);
await build({
  root: process.cwd(), configFile: false, publicDir: false, logLevel: 'error',
  define: { 'process.env.NODE_ENV': '"production"' }, oxc: { jsx: { runtime: 'automatic' } },
  build: { minify: false, outDir, emptyOutDir: false, lib: { entry: 'tests/e2e/artifactPreviewEntry.tsx', formats: ['iife'], name: 'PreviewCheck', fileName: () => 'preview.js' } },
});
