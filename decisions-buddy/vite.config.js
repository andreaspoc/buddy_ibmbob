import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { themeColorPostcss } from '../web/src/lib/themeColor.ts'

// https://vite.dev/config/
export default defineConfig({
  base: '/decisions/',
  plugins: [react()],
  css: { postcss: { plugins: [themeColorPostcss()] } },
  server: { proxy: { '/api/decisions': { target: 'http://127.0.0.1:8080', changeOrigin: false } } },
})
