import {defineConfig} from '../web/node_modules/vite/dist/node/index.js';
import react from '../web/node_modules/@vitejs/plugin-react/dist/index.js';
export default defineConfig({root:new URL('.',import.meta.url).pathname,plugins:[react()],resolve:{alias:{react:new URL('../web/node_modules/react',import.meta.url).pathname,'react-dom':new URL('../web/node_modules/react-dom',import.meta.url).pathname}},server:{host:'0.0.0.0',port:3002,fs:{allow:[new URL('..',import.meta.url).pathname]}}});
