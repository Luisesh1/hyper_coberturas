import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import './styles/tokens.css';
import './styles/components.css';
import App from './App';
import { WalletProvider } from './hooks/useWalletConnection';

// Modo dev: instalamos los hooks globales de captura de errores ANTES del
// primer render para no perder errores durante el bootstrap. En build de
// producción, Vite reemplaza `import.meta.env.DEV` por `false` y el bloque
// completo se elimina por tree-shaking.
if (import.meta.env.DEV) {
  import('./dev/installDevLogCapture').then(({ installDevLogCapture }) => {
    installDevLogCapture();
  }).catch(() => { /* noop si el módulo no existe en build */ });
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter>
      <WalletProvider>
        <App />
      </WalletProvider>
    </BrowserRouter>
  </StrictMode>
);
