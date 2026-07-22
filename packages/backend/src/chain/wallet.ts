import { and, eq } from 'drizzle-orm';
import { getAddress, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

import { openArenaDatabase, type ArenaDatabase } from '../db/index.js';
import { wallets } from '../db/schema.js';
import { ensureChainTables } from './storage.js';

export interface WalletRecord {
  runId: string;
  entrantId: string;
  address: Address;
  privateKey: Hex;
}

export interface Keyfile {
  address: Address;
  privateKey: Hex;
}

function useDatabase<T>(database: ArenaDatabase | undefined, action: (db: ArenaDatabase) => T): T {
  if (database) {
    ensureChainTables(database);
    return action(database);
  }

  const opened = openArenaDatabase();
  try {
    ensureChainTables(opened.database);
    return action(opened.database);
  } finally {
    opened.sqlite.close();
  }
}

function insertWallet(database: ArenaDatabase, runId: string, entrantId: string): Address {
  const privateKey = generatePrivateKey();
  const address = privateKeyToAccount(privateKey).address;
  const inserted = database
    .insert(wallets)
    .values({ runId, entrantId, address: address.toLowerCase(), privateKey })
    .onConflictDoNothing()
    .returning({ address: wallets.address })
    .get();

  if (!inserted) {
    throw new Error(`Wallet already exists for run ${runId}, entrant ${entrantId}`);
  }
  return getAddress(inserted.address);
}

function selectWallet(database: ArenaDatabase, runId: string, entrantId: string): WalletRecord | null {
  const row = database
    .select()
    .from(wallets)
    .where(and(eq(wallets.runId, runId), eq(wallets.entrantId, entrantId)))
    .get();
  if (!row) {
    return null;
  }
  return {
    runId: row.runId,
    entrantId: row.entrantId,
    address: getAddress(row.address),
    privateKey: row.privateKey as Hex,
  };
}

export function createWallet(
  runId: string,
  entrantId: string,
  database?: ArenaDatabase,
): Address {
  return useDatabase(database, (db) => insertWallet(db, runId, entrantId));
}

export function getWallet(
  runId: string,
  entrantId: string,
  database?: ArenaDatabase,
): WalletRecord | null {
  return useDatabase(database, (db) => selectWallet(db, runId, entrantId));
}

export function exportKeyfile(
  runId: string,
  entrantId: string,
  database?: ArenaDatabase,
): Keyfile {
  const wallet = getWallet(runId, entrantId, database);
  if (!wallet) {
    throw new Error(`No wallet for run ${runId}, entrant ${entrantId}`);
  }
  return { address: wallet.address, privateKey: wallet.privateKey };
}

export class WalletStore {
  constructor(private readonly database: ArenaDatabase) {
    ensureChainTables(database);
  }

  createWallet(runId: string, entrantId: string): Address {
    return insertWallet(this.database, runId, entrantId);
  }

  getWallet(runId: string, entrantId: string): WalletRecord | null {
    return selectWallet(this.database, runId, entrantId);
  }

  exportKeyfile(runId: string, entrantId: string): Keyfile {
    const wallet = this.getWallet(runId, entrantId);
    if (!wallet) {
      throw new Error(`No wallet for run ${runId}, entrant ${entrantId}`);
    }
    return { address: wallet.address, privateKey: wallet.privateKey };
  }
}
