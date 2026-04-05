import { createContext, createElement, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

const WalletContext = createContext(null);
const CONNECTOR_STORAGE_KEY = 'hlbot_wallet_connector';
const WALLETCONNECT_PROJECT_ID = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID || '';
const SUPPORTED_CHAIN_IDS = [1, 42161, 8453, 10, 137];

function parseChainId(value) {
  if (value == null) return null;
  if (typeof value === 'number') return value;
  return Number.parseInt(value, 16);
}

function getInjectedProvider() {
  if (typeof window === 'undefined') return null;
  return window.ethereum || null;
}

function useWalletConnectionController() {
  const [provider, setProvider] = useState(null);
  const [connector, setConnector] = useState(null);
  const [address, setAddress] = useState(null);
  const [chainId, setChainId] = useState(null);
  const [error, setError] = useState(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isDisconnecting, setIsDisconnecting] = useState(false);
  const providerRef = useRef(null);

  const bindProvider = useCallback((nextProvider, nextConnector) => {
    if (providerRef.current?.removeListener) {
      providerRef.current.removeListener('accountsChanged', providerRef.current.__hlbotAccountsHandler);
      providerRef.current.removeListener('chainChanged', providerRef.current.__hlbotChainHandler);
      providerRef.current.removeListener('disconnect', providerRef.current.__hlbotDisconnectHandler);
    }

    providerRef.current = nextProvider || null;
    setProvider(nextProvider || null);
    setConnector(nextConnector || null);

    if (!nextProvider) return;

    const handleAccountsChanged = (accounts) => {
      setAddress(accounts?.[0] || null);
    };
    const handleChainChanged = (nextChainId) => {
      setChainId(parseChainId(nextChainId));
    };
    const handleDisconnect = () => {
      setAddress(null);
      setChainId(null);
      setConnector(null);
      setProvider(null);
      localStorage.removeItem(CONNECTOR_STORAGE_KEY);
    };

    nextProvider.__hlbotAccountsHandler = handleAccountsChanged;
    nextProvider.__hlbotChainHandler = handleChainChanged;
    nextProvider.__hlbotDisconnectHandler = handleDisconnect;

    if (nextProvider.on) {
      nextProvider.on('accountsChanged', handleAccountsChanged);
      nextProvider.on('chainChanged', handleChainChanged);
      nextProvider.on('disconnect', handleDisconnect);
    }
  }, []);

  const hydrateProviderState = useCallback(async (currentProvider) => {
    if (!currentProvider?.request) return;
    const [accounts, currentChainId] = await Promise.all([
      currentProvider.request({ method: 'eth_accounts' }).catch(() => []),
      currentProvider.request({ method: 'eth_chainId' }).catch(() => null),
    ]);
    setAddress(accounts?.[0] || null);
    setChainId(parseChainId(currentChainId));
  }, []);

  const connectInjected = useCallback(async () => {
    const injected = getInjectedProvider();
    setError(null);
    if (!injected) {
      setError('MetaMask u otro proveedor inyectado no está disponible.');
      return null;
    }

    setIsConnecting(true);
    try {
      bindProvider(injected, 'metamask');
      const accounts = await injected.request({ method: 'eth_requestAccounts' });
      const nextAddress = accounts?.[0] || null;
      const nextChainId = await injected.request({ method: 'eth_chainId' });
      setAddress(nextAddress);
      setChainId(parseChainId(nextChainId));
      localStorage.setItem(CONNECTOR_STORAGE_KEY, 'metamask');
      return nextAddress;
    } catch (err) {
      setError(err?.code === 4001 ? 'Conexión rechazada por el usuario.' : (err?.message || 'Error al conectar MetaMask.'));
      return null;
    } finally {
      setIsConnecting(false);
    }
  }, [bindProvider]);

  const connectWalletConnect = useCallback(async () => {
    setError(null);
    if (!WALLETCONNECT_PROJECT_ID) {
      setError('Falta configurar VITE_WALLETCONNECT_PROJECT_ID para usar WalletConnect.');
      return null;
    }

    setIsConnecting(true);
    try {
      const { EthereumProvider } = await import('@walletconnect/ethereum-provider');
      const wcProvider = await EthereumProvider.init({
        projectId: WALLETCONNECT_PROJECT_ID,
        showQrModal: true,
        chains: [1],
        optionalChains: SUPPORTED_CHAIN_IDS.filter((id) => id !== 1),
        methods: [
          'eth_sendTransaction',
          'personal_sign',
          'eth_signTypedData',
          'eth_signTypedData_v4',
          'wallet_switchEthereumChain',
        ],
      });

      bindProvider(wcProvider, 'walletconnect');
      await wcProvider.enable();
      await hydrateProviderState(wcProvider);
      localStorage.setItem(CONNECTOR_STORAGE_KEY, 'walletconnect');
      return wcProvider.accounts?.[0] || null;
    } catch (err) {
      setError(err?.message || 'Error al conectar WalletConnect.');
      return null;
    } finally {
      setIsConnecting(false);
    }
  }, [bindProvider, hydrateProviderState]);

  const disconnect = useCallback(async () => {
    setIsDisconnecting(true);
    setError(null);
    try {
      if (connector === 'walletconnect' && providerRef.current?.disconnect) {
        await providerRef.current.disconnect();
      }
    } catch (err) {
      setError(err?.message || 'Error al desconectar la wallet.');
    } finally {
      bindProvider(null, null);
      setAddress(null);
      setChainId(null);
      localStorage.removeItem(CONNECTOR_STORAGE_KEY);
      setIsDisconnecting(false);
    }
  }, [bindProvider, connector]);

  const switchChain = useCallback(async (targetChainId) => {
    setError(null);
    if (!providerRef.current?.request) return false;
    try {
      await providerRef.current.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: `0x${Number(targetChainId).toString(16)}` }],
      });
      setChainId(Number(targetChainId));
      return true;
    } catch (err) {
      setError(err?.code === 4001 ? 'Cambio de red rechazado por el usuario.' : (err?.message || 'No se pudo cambiar la red.'));
      return false;
    }
  }, []);

  const sendTransaction = useCallback(async (tx) => {
    setError(null);
    if (!providerRef.current?.request) {
      setError('No hay una wallet conectada.');
      return null;
    }

    try {
      if (tx?.chainId && chainId && Number(tx.chainId) !== Number(chainId)) {
        const switched = await switchChain(Number(tx.chainId));
        if (!switched) return null;
      }
      const txHash = await providerRef.current.request({
        method: 'eth_sendTransaction',
        params: [{
          from: address,
          to: tx.to,
          data: tx.data,
          value: tx.value || '0x0',
        }],
      });
      return txHash;
    } catch (err) {
      setError(err?.code === 4001 ? 'Firma rechazada por el usuario.' : (err?.message || 'No se pudo enviar la transacción.'));
      return null;
    }
  }, [address, chainId, switchChain]);

  useEffect(() => {
    const injected = getInjectedProvider();
    if (injected) {
      bindProvider(injected, localStorage.getItem(CONNECTOR_STORAGE_KEY) === 'metamask' ? 'metamask' : null);
      hydrateProviderState(injected).catch(() => {});
      return;
    }

    const storedConnector = localStorage.getItem(CONNECTOR_STORAGE_KEY);
    if (storedConnector !== 'walletconnect' || !WALLETCONNECT_PROJECT_ID) return;

    import('@walletconnect/ethereum-provider')
      .then(async ({ EthereumProvider }) => {
        const wcProvider = await EthereumProvider.init({
          projectId: WALLETCONNECT_PROJECT_ID,
          showQrModal: false,
          chains: [1],
          optionalChains: SUPPORTED_CHAIN_IDS.filter((id) => id !== 1),
        });
        if (wcProvider.session) {
          bindProvider(wcProvider, 'walletconnect');
          await hydrateProviderState(wcProvider);
        }
      })
      .catch(() => {});
  }, [bindProvider, hydrateProviderState]);

  return useMemo(() => ({
    provider,
    address,
    chainId,
    connector,
    connectorLabel: connector === 'walletconnect' ? 'WalletConnect' : connector === 'metamask' ? 'MetaMask' : null,
    isConnected: !!address,
    isConnecting,
    isDisconnecting,
    hasProvider: !!getInjectedProvider() || !!WALLETCONNECT_PROJECT_ID,
    hasInjectedProvider: !!getInjectedProvider(),
    hasWalletConnect: !!WALLETCONNECT_PROJECT_ID,
    connect: connectInjected,
    connectInjected,
    connectWalletConnect,
    disconnect,
    switchChain,
    sendTransaction,
    error,
    clearError: () => setError(null),
  }), [
    provider,
    address,
    chainId,
    connector,
    isConnecting,
    isDisconnecting,
    connectInjected,
    connectWalletConnect,
    disconnect,
    switchChain,
    sendTransaction,
    error,
  ]);
}

export function WalletProvider({ children }) {
  const value = useWalletConnectionController();
  return createElement(WalletContext.Provider, { value }, children);
}

export function useWalletConnection() {
  const context = useContext(WalletContext);
  return context || useWalletConnectionController();
}
