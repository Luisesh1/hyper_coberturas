import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const devPort = parseInt(process.env.VITE_PORT || '5174', 10);
const apiProxyTarget = process.env.VITE_PROXY_HTTP_TARGET || 'http://localhost:3001';
const wsProxyTarget = process.env.VITE_PROXY_WS_TARGET || 'ws://localhost:3001';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: devPort,
    proxy: {
      // Redirigir llamadas /api al backend durante desarrollo
      '/api': {
        target: apiProxyTarget,
        changeOrigin: true,
      },
      // Redirigir WebSocket /ws al backend
      '/ws': {
        target: wsProxyTarget,
        ws: true,
      },
    },
  },
});
