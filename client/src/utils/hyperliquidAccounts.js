export function shortAddress(address = '') {
  if (!address) return '';
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

export function formatUsd(value) {
  if (value == null || Number.isNaN(Number(value))) return '—';
  return `$${Number(value).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function formatAccountIdentity(account) {
  if (!account) return 'Cuenta no disponible';
  const alias = account.alias || account.label || shortAddress(account.address);
  const wallet = account.shortAddress || shortAddress(account.address);
  return wallet && alias !== wallet
    ? `${alias} · ${wallet}`
    : alias;
}

export function formatAccountOptionLabel(account) {
  if (!account) return 'Cuenta no disponible';
  return `${formatAccountIdentity(account)} · ${formatUsd(account.balanceUsd)}`;
}
