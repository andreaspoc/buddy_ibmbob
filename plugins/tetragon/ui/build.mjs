import { copyFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));
const web = path.resolve(root, '../../../web');
const require = createRequire(path.join(web, 'package.json'));
const { build } = await import(pathToFileURL(require.resolve('vite')).href);
const { themeColorPostcss } = await import(pathToFileURL(path.join(web, 'src/lib/themeColor.ts')).href);
await build({
  configFile: false,
  root,
  base: '/tetragon/assets/',
  resolve: { alias: Object.fromEntries(['react', 'react-dom', '@carbon/react', '@carbon/icons-react'].map(name => [name, path.join(web, 'node_modules', name)])) },
  esbuild: { jsx: 'automatic' },
  css: { postcss: { plugins: [themeColorPostcss()] }, preprocessorOptions: { scss: { loadPaths: [path.join(web, 'node_modules')] } } },
  build: { outDir: '../buddy_tetragon/static', assetsDir: '', emptyOutDir: true },
});

await copyFile(path.join(root, 'fonts/IBM-Plex-LICENSE.txt'), path.join(root, '../buddy_tetragon/static/IBM-Plex-LICENSE.txt'));
