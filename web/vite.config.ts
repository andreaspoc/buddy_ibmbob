import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { themeColorPostcss } from './src/lib/themeColor.ts'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), {
    name: 'learning-subpaths',
    configureServer(server) {
      server.middlewares.use((request, _response, next) => {
        if (/^\/learning(?:\/|$|\?)/.test(request.url || '')) request.url = '/learning.html' + ((request.url || '').includes('?') ? '?' + request.url!.split('?').slice(1).join('?') : '');
        if (/^\/projects\/(?:view|tabs)\//.test(request.url || '')) request.url = '/index.html' + ((request.url || '').includes('?') ? '?' + request.url!.split('?').slice(1).join('?') : '');
        next();
      });
    },
  }],
  css: { postcss: { plugins: [themeColorPostcss()] } },
  server: {
    port: 3000,
    proxy: {
      '/search': 'http://127.0.0.1:8080',
      '/documents': 'http://127.0.0.1:8080',
      '/artifact-comments': 'http://127.0.0.1:8080',
      '/admin': 'http://127.0.0.1:8080',
      '/knowledge': 'http://127.0.0.1:8080',
      '/static': 'http://127.0.0.1:8080',
      '/personalization': 'http://127.0.0.1:8080',
      '/approvals': 'http://127.0.0.1:8080',
      '/chat': 'http://127.0.0.1:8080',
      '/workflows': 'http://127.0.0.1:8080',
      '/tasks': 'http://127.0.0.1:8080',
      '/jobs': { target: 'http://127.0.0.1:8080', ws: true },
      '/sessions': 'http://127.0.0.1:8080',
      '/skills': 'http://127.0.0.1:8080',
      '/modes': 'http://127.0.0.1:8080',
      '/mcps': 'http://127.0.0.1:8080',
      '/mcp-catalog': 'http://127.0.0.1:8080',
      '/mcp-oauth': 'http://127.0.0.1:8080',
      '/agent-catalog': 'http://127.0.0.1:8080',
      '/productivity': 'http://127.0.0.1:8080',
      '/notifications': 'http://127.0.0.1:8080',
      '/agents': 'http://127.0.0.1:8080',
      '/auth': 'http://127.0.0.1:8080',
      '/presentation': 'http://127.0.0.1:8080',
      '/projects': 'http://127.0.0.1:8080',
      '/workspace': 'http://127.0.0.1:8080',
      '/health': 'http://127.0.0.1:8080',
      '/hooks': 'http://127.0.0.1:8080',
      '/api': { target: 'http://127.0.0.1:8080', ws: true },
    },
  },
  build: {
    rolldownOptions: { input: { main: resolve('index.html'), learning: resolve('learning.html') } },
    outDir: '../app/static/dist',
    emptyOutDir: true,
  },
})
