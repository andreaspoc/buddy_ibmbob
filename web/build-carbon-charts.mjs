import { build } from 'vite'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
const root = path.dirname(fileURLToPath(import.meta.url))
await build({
  configFile: false,
  root,
  build: {
    outDir: path.join(root, '../app/static'),
    emptyOutDir: false,
    lib: {
      entry: path.join(root, 'carbon-charts.ts'),
      name: 'BuddyCarbonChartBundle',
      formats: ['iife'],
      fileName: () => 'carbon-charts.bundle.js',
      cssFileName: 'carbon-charts',
    },
    chunkSizeWarningLimit: 2200,
  },
})
