import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const relay={'/api/enquiry':{target:'http://127.0.0.1:8787',changeOrigin:false},'/api/health':{target:'http://127.0.0.1:8787',changeOrigin:false}};

export default defineConfig({
  plugins: [react()],
  server: { proxy: relay },
  preview: { proxy: relay },
  build: {
    cssTarget: ['chrome100', 'firefox100', 'safari15'],
  },
});
