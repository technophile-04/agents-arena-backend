import { isAddress, isHex } from 'viem';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createWallet, exportKeyfile, getWallet, WalletStore } from '../../src/chain/wallet.js';
import { openArenaDatabase, type ArenaDatabase } from '../../src/db/index.js';

describe('wallet store', () => {
  let database: ArenaDatabase;
  let close: () => void;

  beforeEach(() => {
    const opened = openArenaDatabase(':memory:');
    database = opened.database;
    close = () => opened.sqlite.close();
  });

  afterEach(() => {
    close();
  });

  it('round-trips create and get for the same run and entrant', () => {
    const address = createWallet('run-1', 'e1', database);
    expect(isAddress(address)).toBe(true);

    const record = getWallet('run-1', 'e1', database);
    expect(record).not.toBeNull();
    expect(record?.runId).toBe('run-1');
    expect(record?.entrantId).toBe('e1');
    // getWallet returns the checksummed address; both sides normalize the same way.
    expect(record?.address).toBe(address);
    expect(isHex(record?.privateKey ?? '0x')).toBe(true);
    expect(record?.privateKey).toHaveLength(66);
  });

  it('returns null for an entrant with no wallet', () => {
    createWallet('run-1', 'e1', database);
    expect(getWallet('run-1', 'missing', database)).toBeNull();
  });

  it('throws when regenerating a wallet for the same run and entrant', () => {
    createWallet('run-1', 'e1', database);
    expect(() => createWallet('run-1', 'e1', database)).toThrow(/already exists/);
  });

  it('keeps distinct wallets per entrant and per run', () => {
    const a = createWallet('run-1', 'e1', database);
    const b = createWallet('run-1', 'e2', database);
    const c = createWallet('run-2', 'e1', database);
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it('exports a keyfile with exactly address and privateKey', () => {
    const address = createWallet('run-1', 'e1', database);
    const keyfile = exportKeyfile('run-1', 'e1', database);

    expect(Object.keys(keyfile).sort()).toEqual(['address', 'privateKey']);
    expect(keyfile.address).toBe(address);
    expect(isHex(keyfile.privateKey)).toBe(true);
    expect(keyfile.privateKey).toHaveLength(66);
  });

  it('exposes the same behavior through WalletStore', () => {
    const store = new WalletStore(database);
    const address = store.createWallet('run-3', 'e1');
    expect(store.getWallet('run-3', 'e1')?.address).toBe(address);
    expect(() => store.createWallet('run-3', 'e1')).toThrow(/already exists/);
    expect(store.exportKeyfile('run-3', 'e1').address).toBe(address);
  });

  it('throws when exporting a keyfile that does not exist', () => {
    expect(() => exportKeyfile('run-1', 'ghost', database)).toThrow(/No wallet/);
  });
});
