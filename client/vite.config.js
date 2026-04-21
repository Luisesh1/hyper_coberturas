import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const devPort = parseInt(process.env.VITE_PORT || '5174', 10);
const apiProxyTarget = process.env.VITE_PROXY_HTTP_TARGET || 'http://localhost:3001';
const wsProxyTarget = process.env.VITE_PROXY_WS_TARGET || 'ws://localhost:3001';

export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    include: ['@walletconnect/ethereum-provider'],
  },
  build: {
    // Sourcemaps fuera del bundle (no referenciados en los .js emitidos):
    // útiles para subir a Sentry/monitoring sin exponer al navegador.
    sourcemap: 'hidden',
    chunkSizeWarningLimit: 1024,
    rollupOptions: {
      output: {
        // Split manual para reducir el chunk inicial. Cada grupo carga
        // sólo cuando alguna ruta lo necesita.
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('react-dom') || id.includes('/react/') || id.includes('react-router')) {
            return 'vendor-react';
          }
          if (id.includes('@tanstack/react-query')) {
            return 'vendor-query';
          }
          if (id.includes('lightweight-charts')) {
            return 'vendor-charts';
          }
          if (id.includes('@codemirror') || id.includes('/codemirror/')) {
            return 'vendor-codemirror';
          }
          if (id.includes('viem') || id.includes('wagmi') || id.includes('@walletconnect') || id.includes('w3m-')) {
            return 'vendor-wallet';
          }
          if (id.includes('technicalindicators')) {
            return 'vendor-indicators';
          }
          return undefined;
        },
      },
    },
  },
  server: {
    host: '0.0.0.0',
    port: devPort,
    allowedHosts: ['hypercover.luisesh1.duckdns.org'],
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
  test: {
    environment: 'jsdom',
    setupFiles: './src/test/setup.js',
    css: true,
    globals: true,
  },
});
