const { ethers } = require('ethers');
const db = require('../db');
const settingsRepository = require('../repositories/settings.repository');
const accountsRepository = require('../repositories/hyperliquid-account.repository');
const { decryptValue, encryptJson } = require('./settings.crypto');
const { ValidationError } = require('../errors/app-error');

function shortAddress(address = '') {
  if (!address) return '';
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function buildAccountDescriptor(alias, address) {
  const short = shortAddress(address);
  const safeAlias = alias?.trim() || short;
  return {
    alias: safeAlias,
    shortAddress: short,
    label: `${safeAlias} · ${short}`,
  };
}

function normalizeAddress(address) {
  try {
    return ethers.getAddress(String(address || '').trim());
  } catch {
    throw new ValidationError('address invalida');
  }
}

function normalizeAlias(alias, address) {
  const normalized = String(alias || '').trim();
  if (normalized) return normalized;
  return buildAccountDescriptor('', address).alias;
}

function normalizePrivateKey(privateKey, { required = true } = {}) {
  const normalized = String(privateKey || '').trim();
  if (!normalized && required) {
    throw new ValidationError('privateKey es requerida');
  }
  return normalized || null;
}

function mapAccountRow(row, { includePrivateKey = false, balance = null } = {}) {
  if (!row) return null;

  const privateKey = row.private_key_encrypted
    ? decryptValue(row.private_key_encrypted)
    : null;
  const descriptor = buildAccountDescriptor(row.alias, row.address);

  return {
    id: row.id,
    userId: row.user_id,
    alias: descriptor.alias,
    address: row.address,
    shortAddress: descriptor.shortAddress,
    label: descriptor.label,
    isDefault: !!row.is_default,
    hasPrivateKey: !!privateKey,
    balanceUsd: balance?.balanceUsd ?? null,
    lastBalanceUpdatedAt: balance?.lastUpdatedAt ?? null,
    ...(includePrivateKey ? { privateKey } : {}),
  };
}

async function getLegacyWallet(userId) {
  const row = await settingsRepository.getByKey(userId, 'wallet');
  if (!row?.value) return null;

  try {
    const wallet = decryptValue(row.value);
    if (!wallet?.address) return null;
    return wallet;
  } catch {
    return null;
  }
}

async function ensureLegacyWalletMigrated(userId) {
  const existingCount = await accountsRepository.countByUser(userId);
  if (existingCount > 0) return;

  const legacyWallet = await getLegacyWallet(userId);
  if (!legacyWallet?.address) return;

  await db.transaction(async (client) => {
    const created = await accountsRepository.create(
      userId,
      {
        alias: normalizeAlias('Cuenta principal', legacyWallet.address),
        address: normalizeAddress(legacyWallet.address),
        privateKeyEncrypted: legacyWallet.privateKey
          ? encryptJson(String(legacyWallet.privateKey).trim())
          : null,
        isDefault: true,
        createdAt: Date.now(),
      },
      client
    );
    await accountsRepository.assignLegacyHedges(userId, created.id, client);
  });
}

async function listAccounts(userId) {
  await ensureLegacyWalletMigrated(userId);
  const rows = await accountsRepository.listByUser(userId);
  return rows.map((row) => mapAccountRow(row));
}

async function getDefaultAccount(userId) {
  await ensureLegacyWalletMigrated(userId);
  return mapAccountRow(await accountsRepository.getDefaultByUser(userId));
}

async function getAccount(userId, accountId, { includePrivateKey = false } = {}) {
  await ensureLegacyWalletMigrated(userId);
  const row = await accountsRepository.getById(userId, accountId);
  if (!row) {
    throw new ValidationError('Cuenta de Hyperliquid no encontrada');
  }
  return mapAccountRow(row, { includePrivateKey });
}

async function resolveAccount(userId, accountId, { includePrivateKey = false } = {}) {
  if (accountId != null && accountId !== '') {
    return getAccount(userId, Number(accountId), { includePrivateKey });
  }

  const account = await getDefaultAccount(userId);
  if (!account) {
    throw new ValidationError('No hay cuentas de Hyperliquid configuradas');
  }
  if (!includePrivateKey) return account;
  return getAccount(userId, account.id, { includePrivateKey: true });
}

async function createAccount(userId, { alias, address, privateKey, isDefault = false }) {
  const normalizedAddress = normalizeAddress(address);
  const normalizedAlias = normalizeAlias(alias, normalizedAddress);
  const normalizedPrivateKey = normalizePrivateKey(privateKey, { required: true });

  await ensureLegacyWalletMigrated(userId);
  const existingCount = await accountsRepository.countByUser(userId);

  try {
    const row = await db.transaction(async (client) => {
      const shouldBeDefault = existingCount === 0 || !!isDefault;
      if (shouldBeDefault) {
        await accountsRepository.clearDefault(userId, client);
      }
      return accountsRepository.create(
        userId,
        {
          alias: normalizedAlias,
          address: normalizedAddress,
          privateKeyEncrypted: encryptJson(normalizedPrivateKey),
          isDefault: shouldBeDefault,
          createdAt: Date.now(),
        },
        client
      );
    });
    return mapAccountRow(row);
  } catch (err) {
    if (err?.code === '23505') {
      throw new ValidationError('Ya existe una cuenta con esa wallet');
    }
    throw err;
  }
}

async function updateAccount(userId, accountId, { alias, address, privateKey, isDefault = false }) {
  await ensureLegacyWalletMigrated(userId);
  const current = await accountsRepository.getById(userId, accountId);
  if (!current) {
    throw new ValidationError('Cuenta de Hyperliquid no encontrada');
  }

  const normalizedAddress = normalizeAddress(address || current.address);
  const normalizedAlias = normalizeAlias(alias || current.alias, normalizedAddress);
  const normalizedPrivateKey = normalizePrivateKey(privateKey, { required: false });

  try {
    const row = await db.transaction(async (client) => {
      if (isDefault) {
        await accountsRepository.clearDefault(userId, client);
      }
      return accountsRepository.update(
        userId,
        accountId,
        {
          alias: normalizedAlias,
          address: normalizedAddress,
          privateKeyEncrypted: normalizedPrivateKey
            ? encryptJson(normalizedPrivateKey)
            : current.private_key_encrypted,
          isDefault: isDefault ? true : !!current.is_default,
          updatedAt: Date.now(),
        },
        client
      );
    });
    return mapAccountRow(row);
  } catch (err) {
    if (err?.code === '23505') {
      throw new ValidationError('Ya existe una cuenta con esa wallet');
    }
    throw err;
  }
}

async function setDefaultAccount(userId, accountId) {
  await ensureLegacyWalletMigrated(userId);
  const current = await accountsRepository.getById(userId, accountId);
  if (!current) {
    throw new ValidationError('Cuenta de Hyperliquid no encontrada');
  }

  const row = await db.transaction(async (client) => {
    await accountsRepository.clearDefault(userId, client);
    return accountsRepository.setDefault(userId, accountId, client);
  });
  return mapAccountRow(row);
}

async function deleteAccount(userId, accountId) {
  await ensureLegacyWalletMigrated(userId);
  const current = await accountsRepository.getById(userId, accountId);
  if (!current) {
    throw new ValidationError('Cuenta de Hyperliquid no encontrada');
  }

  const hedgesCount = await accountsRepository.countHedgesByAccount(userId, accountId);
  if (hedgesCount > 0) {
    throw new ValidationError('No se puede eliminar una cuenta con coberturas asociadas');
  }

  const deleted = await db.transaction(async (client) => {
    const row = await accountsRepository.deleteById(userId, accountId, client);
    if (row?.is_default) {
      const remaining = await accountsRepository.listByUser(userId, client);
      if (remaining[0]) {
        await accountsRepository.clearDefault(userId, client);
        await accountsRepository.setDefault(userId, remaining[0].id, client);
      }
    }
    return row;
  });
  return mapAccountRow(deleted);
}

async function upsertDefaultWallet(userId, { alias, address, privateKey }) {
  await ensureLegacyWalletMigrated(userId);
  const currentDefault = await accountsRepository.getDefaultByUser(userId);
  if (!currentDefault) {
    return createAccount(userId, {
      alias: alias || 'Cuenta principal',
      address,
      privateKey,
      isDefault: true,
    });
  }

  return updateAccount(userId, currentDefault.id, {
    alias: alias || currentDefault.alias,
    address: address || currentDefault.address,
    privateKey,
    isDefault: true,
  });
}

module.exports = {
  buildAccountDescriptor,
  createAccount,
  deleteAccount,
  ensureLegacyWalletMigrated,
  getAccount,
  getDefaultAccount,
  listAccounts,
  mapAccountRow,
  resolveAccount,
  setDefaultAccount,
  shortAddress,
  updateAccount,
  upsertDefaultWallet,
};
