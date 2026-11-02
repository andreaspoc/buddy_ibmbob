import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    dedupe: ['react', 'react-dom', '@carbon/react', '@carbon/icons-react'],
    alias: {
      react: fileURLToPath(new URL('./node_modules/react', import.meta.url)),
      'react-dom': fileURLToPath(new URL('./node_modules/react-dom', import.meta.url)),
      '@carbon/react': fileURLToPath(new URL('./node_modules/@carbon/react', import.meta.url)),
      '@carbon/icons-react': fileURLToPath(new URL('./node_modules/@carbon/icons-react', import.meta.url)),
      '@xyflow/react': fileURLToPath(new URL('./node_modules/@xyflow/react', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/coverage/**/*.test.{ts,tsx}', 'tests/analysisData.test.ts', 'tests/streamText.test.ts', 'tests/responseNotifications.test.ts'],
    coverage: {
      provider: 'v8',
      allowExternal: true,
      include: ['src/**/*.{ts,tsx,js}', 'document-export.ts', '../frontend/bobdeck-common.js', '../frontend/bobdeck.js', '../frontend/chart.js', '../frontend/renderer.js', '../decisions-buddy/src/**/*.{js,jsx}', '../bindings/nodejs/{index,expression}.js'],
      reporter: ['text-summary', ['lcov', { projectRoot: fileURLToPath(new URL('..', import.meta.url)) }], 'html'],
      reportsDirectory: 'coverage',
      clean: true,
      reportOnFailure: false,
    },
  },
});
