import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

const devPort = parseInt(process.env.VITE_PORT || '5174', 10);
const apiProxyTarget = process.env.VITE_PROXY_HTTP_TARGET || 'http://localhost:3001';
const wsProxyTarget = process.env.VITE_PROXY_WS_TARGET || 'ws://localhost:3001';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'prompt',
      injectRegister: false,
      includeAssets: ['favicon.svg', 'icons/apple-touch-icon-180.png'],
      manifest: {
        name: 'Hyperliquid Trading Bot',
        short_name: 'HL Bot',
        description: 'Hyperliquid trading, hedge and analytics panel',
        theme_color: '#0f1117',
        background_color: '#0f1117',
        display: 'standalone',
        orientation: 'any',
        start_url: '/',
        scope: '/',
        lang: 'es',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,woff2}'],
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api/, /^\/ws/],
        cleanupOutdatedCaches: true,
        clientsClaim: true,
        skipWaiting: false,
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
      },
      devOptions: { enabled: false },
    }),
  ],
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
