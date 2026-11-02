import config from '../web/vite.config';
import { fileURLToPath } from 'node:url';
export default {
  ...config,
  root: fileURLToPath(new URL('../', import.meta.url)),
  server: { ...config.server, allowedHosts: ['buddy-motion-preview', 'buddy-motion-preview-v2'] },
  resolve: { alias: {
    react: fileURLToPath(new URL('../web/node_modules/react', import.meta.url)),
    'react-dom': fileURLToPath(new URL('../web/node_modules/react-dom', import.meta.url)),
  } },
};
