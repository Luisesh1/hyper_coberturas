import { Outlet } from 'react-router-dom';
import { WalletProvider } from '../hooks/useWalletConnection';

// Layout de las rutas que firman transacciones: el stack wagmi/viem/WalletConnect
// sólo se descarga al entrar en ellas (este módulo se importa con lazy()).
export default function WalletLayout() {
  return (
    <WalletProvider>
      <Outlet />
    </WalletProvider>
  );
}
