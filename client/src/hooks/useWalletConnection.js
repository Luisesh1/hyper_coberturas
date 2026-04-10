import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  WagmiProvider,
  createConfig,
  useAccount,
  useConnect,
  useDisconnect,
  useReconnect,
  useSwitchChain,
} from 'wagmi';
// `injected({ target: 'metaMask' })` usa el provider EIP-1193 inyectado por
// la extensión MetaMask (window.ethereum.isMetaMask). Es la opción correcta
// para wagmi cuando solo se quiere soportar la extensión clásica del
// navegador. NO usamos `metaMask()` porque en @wagmi/connectors v8 ese
// connector intenta cargar dinámicamente `@metamask/connect-evm` (el SDK
// nuevo de "MetaMask Connect"), que no es necesario para nuestro flujo y
// hace fallar el bundling de Vite si no está instalado como dep.
import { injected, walletConnect } from 'wagmi/connectors';
import { buildWagmiTransports, getPublicClientForChain, SUPPORTED_CHAINS } from '../lib/wallet/clients';
import {
  addGasBuffer,
  buildPreparedTransactionRequest,
  buildTransactionParams,
  extractTxHash,
  formatFriendlyWalletError,
  normalizeReceiptStatus,
  normalizeWalletError,
  parseHexOrDecimalBigInt,
  sendWalletTransactionDetailed,
  waitForBroadcastedHash,
} from '../lib/wallet/transaction-utils';

const WalletContext = createContext(null);
const CONNECTOR_STORAGE_KEY = 'hlbot_wallet_connector';
const WC_PROJECT_ID_STORAGE_KEY = 'hlbot_walletconnect_project_id';
const WALLETCONNECT_BUILD_TIME_PROJECT_ID = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID || '';

function readStoredWalletConnectProjectId() {
  if (typeof window === 'undefined') return '';
  try {
    return window.localStorage.getItem(WC_PROJECT_ID_STORAGE_KEY) || '';
  } catch {
    return '';
  }
}

function getInitialWalletConnectProjectId() {
  return WALLETCONNECT_BUILD_TIME_PROJECT_ID || readStoredWalletConnectProjectId();
}

function getInjectedProvider() {
  if (typeof window === 'undefined') return null;
  return window.ethereum || null;
}

export async function sendWalletTransaction(args) {
  const result = await sendWalletTransactionDetailed(args);
  args?.setError?.(result.normalizedError?.message || null);
  return result.hash || null;
}

function isMetaMaskConnector(connector) {
  const id = String(connector?.id || '').toLowerCase();
  const name = String(connector?.name || '').toLowerCase();
  return id.includes('metamask') || name.includes('metamask');
}

function isWalletConnectConnector(connector) {
  const id = String(connector?.id || '').toLowerCase();
  const name = String(connector?.name || '').toLowerCase();
  return id.includes('walletconnect') || name.includes('walletconnect');
}

function WalletController({ children, walletConnectProjectId, setWalletConnectProjectId, needsWalletConnectSetup, setNeedsWalletConnectSetup }) {
  const providerRef = useRef(null);
  const [providerState, setProviderState] = useState(null);
  const [error, setError] = useState(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isDisconnecting, setIsDisconnecting] = useState(false);

  const { address, chainId, connector, isConnected } = useAccount();
  const { connectors, connectAsync } = useConnect();
  const { disconnectAsync } = useDisconnect();
  const { switchChainAsync } = useSwitchChain();
  const { reconnectAsync } = useReconnect();

  const hydrateProviderRef = useCallback(async (nextConnector) => {
    if (!nextConnector?.getProvider) {
      providerRef.current = null;
      setProviderState(null);
      return;
    }
    try {
      const provider = await nextConnector.getProvider();
      providerRef.current = provider || null;
      setProviderState(provider || null);
    } catch {
      providerRef.current = null;
      setProviderState(null);
    }
  }, []);

  useEffect(() => {
    if (!isConnected || !connector) {
      providerRef.current = null;
      setProviderState(null);
      return;
    }
    hydrateProviderRef(connector).catch(() => {});
  }, [connector, hydrateProviderRef, isConnected]);

  useEffect(() => {
    reconnectAsync?.().catch(() => {});
  }, [reconnectAsync]);

  const connectInjected = useCallback(async () => {
    const injected = getInjectedProvider();
    setError(null);
    if (!injected) {
      setError('MetaMask u otro proveedor inyectado no está disponible.');
      return null;
    }

    const connectorToUse = connectors.find(isMetaMaskConnector) || connectors.find((item) => !isWalletConnectConnector(item));
    if (!connectorToUse) {
      setError('No se encontró un conector inyectado compatible.');
      return null;
    }

    setIsConnecting(true);
    try {
      const result = await connectAsync({ connector: connectorToUse });
      if (typeof window !== 'undefined') {
        window.localStorage.setItem(CONNECTOR_STORAGE_KEY, 'metamask');
      }
      setNeedsWalletConnectSetup(false);
      return result?.accounts?.[0] || null;
    } catch (err) {
      const normalized = normalizeWalletError(err);
      setError(normalized.message);
      return null;
    } finally {
      setIsConnecting(false);
    }
  }, [connectAsync, connectors, setNeedsWalletConnectSetup]);

  const connectWalletConnect = useCallback(async () => {
    setError(null);
    if (!walletConnectProjectId) {
      setNeedsWalletConnectSetup(true);
      return null;
    }

    const connectorToUse = connectors.find(isWalletConnectConnector);
    if (!connectorToUse) {
      setError('WalletConnect no está disponible con la configuración actual.');
      return null;
    }

    setIsConnecting(true);
    try {
      const result = await connectAsync({ connector: connectorToUse });
      if (typeof window !== 'undefined') {
        window.localStorage.setItem(CONNECTOR_STORAGE_KEY, 'walletconnect');
      }
      setNeedsWalletConnectSetup(false);
      return result?.accounts?.[0] || null;
    } catch (err) {
      const normalized = normalizeWalletError(err);
      setError(normalized.message);
      if (normalized.code === 'unknown' && /project/i.test(normalized.rawMessage || '')) {
        setNeedsWalletConnectSetup(true);
      }
      return null;
    } finally {
      setIsConnecting(false);
    }
  }, [connectAsync, connectors, setNeedsWalletConnectSetup, walletConnectProjectId]);

  const disconnect = useCallback(async () => {
    setIsDisconnecting(true);
    setError(null);
    try {
      await disconnectAsync();
      if (typeof window !== 'undefined') {
        window.localStorage.removeItem(CONNECTOR_STORAGE_KEY);
      }
    } catch (err) {
      const normalized = normalizeWalletError(err);
      setError(normalized.message);
    } finally {
      providerRef.current = null;
      setProviderState(null);
      setIsDisconnecting(false);
    }
  }, [disconnectAsync]);

  const switchChain = useCallback(async (targetChainId) => {
    setError(null);
    if (!switchChainAsync) return false;
    try {
      await switchChainAsync({ chainId: Number(targetChainId) });
      return true;
    } catch (err) {
      const normalized = normalizeWalletError(err);
      const mapped = normalized.code === 'user_rejected'
        ? { ...normalized, code: 'chain_switch_rejected', message: formatFriendlyWalletError('chain_switch_rejected') }
        : normalized;
      setError(mapped.message);
      return false;
    }
  }, [switchChainAsync]);

  const preflightTransaction = useCallback(async (tx, { chainId: targetChainId } = {}) => {
    if (!address) {
      const normalized = { code: 'wallet_unavailable', message: formatFriendlyWalletError('wallet_unavailable') };
      setError(normalized.message);
      const wrapped = new Error(normalized.message);
      wrapped.normalizedError = normalized;
      throw wrapped;
    }
    const effectiveChainId = Number(targetChainId || tx?.chainId || chainId);
    const publicClient = getPublicClientForChain(effectiveChainId);
    if (!publicClient) {
      const normalized = { code: 'chain_mismatch', message: formatFriendlyWalletError('chain_mismatch') };
      setError(normalized.message);
      const wrapped = new Error(normalized.message);
      wrapped.normalizedError = normalized;
      throw wrapped;
    }

    try {
      const gas = await publicClient.estimateGas({
        account: address,
        to: tx.to,
        data: tx.data,
        value: parseHexOrDecimalBigInt(tx.value || '0x0'),
      });
      return {
        gas: addGasBuffer(`0x${gas.toString(16)}`),
      };
    } catch (err) {
      const normalized = normalizeWalletError(err, { phase: 'preflight' });
      setError(normalized.message);
      const wrapped = new Error(normalized.message);
      wrapped.normalizedError = normalized;
      throw wrapped;
    }
  }, [address, chainId]);

  const submitTransactionDetailed = useCallback(async (tx, { actionKey } = {}) => {
    const effectiveChainId = Number(tx?.chainId || chainId);
    const publicClient = getPublicClientForChain(effectiveChainId);
    const result = await sendWalletTransactionDetailed({
      provider: providerRef.current,
      publicClient,
      address,
      chainId,
      tx,
      switchChain,
      actionKey,
    });
    setError(result.normalizedError?.message || null);
    return result;
  }, [address, chainId, switchChain]);

  const sendTransaction = useCallback(async (tx) => {
    const result = await submitTransactionDetailed(tx);
    return result.hash || null;
  }, [submitTransactionDetailed]);

  const waitForTransactionReceipt = useCallback(async (
    txHash,
    { timeoutMs = 180000, pollMs = 1500, chainId: targetChainId, onReplaced } = {}
  ) => {
    setError(null);
    if (!txHash) {
      throw new Error('txHash es requerido para esperar confirmación.');
    }

    const effectiveChainId = Number(targetChainId || chainId);
    const publicClient = getPublicClientForChain(effectiveChainId);
    if (!publicClient) {
      const normalized = { code: 'chain_mismatch', message: formatFriendlyWalletError('chain_mismatch') };
      setError(normalized.message);
      const wrapped = new Error(normalized.message);
      wrapped.normalizedError = normalized;
      throw wrapped;
    }

    try {
      const receipt = await publicClient.waitForTransactionReceipt({
        hash: txHash,
        pollingInterval: pollMs,
        timeout: timeoutMs,
        confirmations: 1,
        onReplaced,
      });
      return {
        ...receipt,
        transactionHash: receipt.transactionHash || txHash,
        status: normalizeReceiptStatus(receipt.status),
      };
    } catch (err) {
      const normalized = normalizeWalletError(err, { phase: 'receipt' });
      setError(normalized.message);
      const wrapped = new Error(normalized.message);
      wrapped.normalizedError = normalized;
      throw wrapped;
    }
  }, [chainId]);

  const clearError = useCallback(() => setError(null), []);

  const value = useMemo(() => ({
    provider: providerState,
    address,
    chainId: chainId != null ? Number(chainId) : null,
    connector: connector?.id || null,
    connectorLabel: connector?.name || null,
    isConnected: !!isConnected && !!address,
    isConnecting,
    isDisconnecting,
    hasProvider: true,
    hasInjectedProvider: !!getInjectedProvider(),
    hasWalletConnect: true,
    walletConnectProjectId,
    setWalletConnectProjectId,
    needsWalletConnectSetup,
    dismissWalletConnectSetup: () => setNeedsWalletConnectSetup(false),
    connect: connectInjected,
    connectInjected,
    connectWalletConnect,
    disconnect,
    switchChain,
    preflightTransaction,
    submitTransactionDetailed,
    sendTransaction,
    waitForTransactionReceipt,
    error,
    clearError,
    getPublicClient: getPublicClientForChain,
  }), [
    address,
    chainId,
    clearError,
    connectInjected,
    connectWalletConnect,
    connector?.id,
    connector?.name,
    disconnect,
    error,
    isConnected,
    isConnecting,
    isDisconnecting,
    needsWalletConnectSetup,
    preflightTransaction,
    providerState,
    sendTransaction,
    setWalletConnectProjectId,
    submitTransactionDetailed,
    switchChain,
    waitForTransactionReceipt,
    walletConnectProjectId,
    setNeedsWalletConnectSetup,
  ]);

  return createElement(WalletContext.Provider, { value }, children);
}

export function WalletProvider({ children }) {
  const [walletConnectProjectId, setWalletConnectProjectIdState] = useState(getInitialWalletConnectProjectId);
  const [needsWalletConnectSetup, setNeedsWalletConnectSetup] = useState(false);
  const queryClientRef = useRef(null);
  if (!queryClientRef.current) {
    queryClientRef.current = new QueryClient();
  }

  const setWalletConnectProjectId = useCallback((value) => {
    const trimmed = String(value || '').trim();
    setWalletConnectProjectIdState(trimmed);
    try {
      if (trimmed) {
        window.localStorage.setItem(WC_PROJECT_ID_STORAGE_KEY, trimmed);
      } else {
        window.localStorage.removeItem(WC_PROJECT_ID_STORAGE_KEY);
      }
    } catch {
      // ignore storage errors
    }
  }, []);

  const wagmiConfig = useMemo(() => {
    const connectors = [injected({ target: 'metaMask', shimDisconnect: true })];
    if (walletConnectProjectId) {
      connectors.push(walletConnect({
        projectId: walletConnectProjectId,
        showQrModal: true,
      }));
    }

    return createConfig({
      chains: SUPPORTED_CHAINS,
      connectors,
      transports: buildWagmiTransports(),
    });
  }, [walletConnectProjectId]);

  return createElement(
    QueryClientProvider,
    { client: queryClientRef.current },
    createElement(
      WagmiProvider,
      { config: wagmiConfig, reconnectOnMount: true },
      createElement(
        WalletController,
        {
          walletConnectProjectId,
          setWalletConnectProjectId,
          needsWalletConnectSetup,
          setNeedsWalletConnectSetup,
        },
        children
      )
    )
  );
}

export function useWalletConnection() {
  return useContext(WalletContext);
}

export {
  buildPreparedTransactionRequest,
  buildTransactionParams,
  extractTxHash,
  normalizeWalletError,
  sendWalletTransactionDetailed,
  waitForBroadcastedHash,
};
