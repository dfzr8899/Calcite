import { defineConfig } from 'vite';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
export default defineConfig({
  base:'./',
  resolve:{alias:[{find:/^(?:node:)?buffer$/,replacement:require.resolve('buffer/')}]},
  build:{target:['chrome100','edge100','firefox100','safari15'],chunkSizeWarningLimit:2500}
});
