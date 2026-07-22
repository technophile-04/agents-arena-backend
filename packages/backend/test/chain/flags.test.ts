import { createPublicClient, http, type Address, type PublicClient } from 'viem';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FlagWatcher, flagCount } from '../../src/chain/flag-watcher.js';
import type { ChainProfile } from '../../src/chain/profile.js';
import { createWallet } from '../../src/chain/wallet.js';
import { EventJournal } from '../../src/journal.js';
import {
  deployFlagFixture,
  mintFlag,
  startAnvil,
  testProfile,
  type AnvilHandle,
} from './support.js';

const CONFIRMATIONS = 2;

describe('flag watcher', () => {
  let anvil: AnvilHandle;
  let contract: Address;
  let profile: ChainProfile;
  // cacheTime 0 so scanOnce reads a fresh head after each anvil_mine (no 4s viem cache).
  let client: PublicClient;

  beforeAll(async () => {
    anvil = await startAnvil();
    contract = await deployFlagFixture(anvil);
    profile = testProfile(anvil.rpcUrl, CONFIRMATIONS, contract);
    client = createPublicClient({ transport: http(anvil.rpcUrl), cacheTime: 0 });
  }, 60_000);

  afterAll(async () => {
    await anvil.stop();
  });

  function watcher(journal: EventJournal, runId: string): FlagWatcher {
    return new FlagWatcher({ profile, runId, journal, database: journal.database, client });
  }

  function scoreEvents(journal: EventJournal, runId: string) {
    return journal
      .after(runId, 0)
      .filter((event) => event.type === 'score.flag')
      .map((event) => event.payload as { entrantId: string; challengeId: number });
  }

  it('emits no score while the mint is unconfirmed, then exactly one once confirmed', async () => {
    const journal = new EventJournal(':memory:');
    const runId = 'run-confirm';
    try {
      const address = createWallet(runId, 'e1', journal.database);
      const watch = watcher(journal, runId);

      await mintFlag(anvil, contract, address, 3n);
      expect(await watch.scanOnce(0n)).toBe(0);
      expect(flagCount(runId, 'e1', journal.database)).toBe(0);
      expect(scoreEvents(journal, runId)).toHaveLength(0);

      await anvil.mine(CONFIRMATIONS);
      expect(await watch.scanOnce(0n)).toBe(1);
      expect(flagCount(runId, 'e1', journal.database)).toBe(1);

      const events = scoreEvents(journal, runId);
      expect(events).toHaveLength(1);
      expect(events[0]?.entrantId).toBe('e1');
      expect(events[0]?.challengeId).toBe(3);
    } finally {
      journal.close();
    }
  }, 30_000);

  it('ignores a second mint of the same challenge by the same entrant', async () => {
    const journal = new EventJournal(':memory:');
    const runId = 'run-dup-challenge';
    try {
      const address = createWallet(runId, 'e1', journal.database);
      const watch = watcher(journal, runId);

      await mintFlag(anvil, contract, address, 3n);
      await anvil.mine(CONFIRMATIONS);
      expect(await watch.scanOnce(0n)).toBe(1);

      // A distinct on-chain log (new tokenId), same run+address+challenge.
      await mintFlag(anvil, contract, address, 3n);
      await anvil.mine(CONFIRMATIONS);
      expect(await watch.scanOnce(0n)).toBe(0);

      expect(flagCount(runId, 'e1', journal.database)).toBe(1);
      expect(scoreEvents(journal, runId)).toHaveLength(1);
    } finally {
      journal.close();
    }
  }, 30_000);

  it('ignores a mint by a minter that is not an entrant wallet', async () => {
    const journal = new EventJournal(':memory:');
    const runId = 'run-unknown';
    try {
      createWallet(runId, 'e1', journal.database);
      const watch = watcher(journal, runId);
      const stranger = '0x00000000000000000000000000000000deadbeef' as Address;

      await mintFlag(anvil, contract, stranger, 4n);
      await anvil.mine(CONFIRMATIONS);
      expect(await watch.scanOnce(0n)).toBe(0);

      expect(flagCount(runId, 'e1', journal.database)).toBe(0);
      expect(scoreEvents(journal, runId)).toHaveLength(0);
    } finally {
      journal.close();
    }
  }, 30_000);

  it('re-scanning from 0 with a fresh watcher on the same db emits zero duplicates', async () => {
    const journal = new EventJournal(':memory:');
    const runId = 'run-restart';
    try {
      const address = createWallet(runId, 'e1', journal.database);
      await mintFlag(anvil, contract, address, 7n);
      await anvil.mine(CONFIRMATIONS);
      expect(await watcher(journal, runId).scanOnce(0n)).toBe(1);

      // Restart: a brand-new watcher, same db, same run, re-scan the whole range.
      const restarted = watcher(journal, runId);
      expect(await restarted.scanOnce(0n)).toBe(0);

      expect(flagCount(runId, 'e1', journal.database)).toBe(1);
      expect(scoreEvents(journal, runId)).toHaveLength(1);
    } finally {
      journal.close();
    }
  }, 30_000);

  it('resumes from the persisted cursor without re-emitting past flags', async () => {
    const journal = new EventJournal(':memory:');
    const runId = 'run-cursor';
    try {
      const address = createWallet(runId, 'e1', journal.database);
      await mintFlag(anvil, contract, address, 9n);
      await anvil.mine(CONFIRMATIONS);
      expect(await watcher(journal, runId).scanOnce(0n)).toBe(1);

      // A fresh watcher's watch() computes resumeBlock = cursor + 1 - confirmations,
      // so it re-reads already-processed blocks. The overlap must not duplicate.
      const resumed = watcher(journal, runId);
      const controller = new AbortController();
      const loop = resumed.watch(controller.signal);
      await new Promise((resolve) => setTimeout(resolve, 300));
      controller.abort();
      await loop;

      expect(flagCount(runId, 'e1', journal.database)).toBe(1);
      expect(scoreEvents(journal, runId)).toHaveLength(1);
    } finally {
      journal.close();
    }
  }, 30_000);

  it('flagCount reflects the number of distinct confirmed challenges', async () => {
    const journal = new EventJournal(':memory:');
    const runId = 'run-count';
    try {
      const address = createWallet(runId, 'e1', journal.database);
      const watch = watcher(journal, runId);

      await mintFlag(anvil, contract, address, 1n);
      await mintFlag(anvil, contract, address, 2n);
      await mintFlag(anvil, contract, address, 1n); // duplicate challenge, ignored
      await anvil.mine(CONFIRMATIONS);
      expect(await watch.scanOnce(0n)).toBe(2);

      expect(flagCount(runId, 'e1', journal.database)).toBe(2);
      expect(watch.flagCount(runId, 'e1')).toBe(2);
      expect(scoreEvents(journal, runId)).toHaveLength(2);
    } finally {
      journal.close();
    }
  }, 30_000);
});
