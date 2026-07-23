import { parseEther, type Address } from 'viem';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { awaitFunding, checkFunded } from '../../src/chain/funding-watcher.js';
import type { ChainProfile } from '../../src/chain/profile.js';
import { EventJournal } from '../../src/journal.js';
import { startAnvil, testProfile, type AnvilHandle } from './support.js';

// Distinct address per test so balances never leak between cases.
function addressFor(seed: number): Address {
  return `0x${seed.toString(16).padStart(40, '0')}` as Address;
}

function fundingEvents(journal: EventJournal, runId: string) {
  return journal
    .after(runId, 0)
    .filter((event) => event.type === 'funding.balance')
    .map((event) => ({
      source: event.source,
      ...(event.payload as { funded: boolean; wei: string; entrantId: string }),
    }));
}

describe('funding watcher', () => {
  let anvil: AnvilHandle;
  let profile: ChainProfile;

  beforeAll(async () => {
    anvil = await startAnvil();
    profile = testProfile(anvil.rpcUrl, 1, '0x0000000000000000000000000000000000000000');
    // One block so head >= confirmations and the watcher can read a confirmed balance.
    await anvil.mine(1);
  }, 30_000);

  afterAll(async () => {
    await anvil.stop();
  });

  it('checkFunded is false below threshold and true once the balance clears it', async () => {
    const address = addressFor(0xaa1);
    expect(await checkFunded(profile, [{ entrantId: 'e1', address }], parseEther('1'))).toBe(false);
    await anvil.setBalance(address, parseEther('2'));
    await anvil.mine(1);
    expect(await checkFunded(profile, [{ entrantId: 'e1', address }], parseEther('1'))).toBe(true);
  }, 30_000);

  it('does not resolve while the entrant stays below threshold', async () => {
    const journal = new EventJournal(':memory:');
    const controller = new AbortController();
    const address = addressFor(0xbb1);
    try {
      const watch = awaitFunding({
        profile,
        entries: [{ entrantId: 'e1', address }],
        thresholdWei: parseEther('1'),
        journal,
        runId: 'run-below',
        pollMs: 100,
        signal: controller.signal,
      });
      watch.catch(() => undefined);

      const settled = await Promise.race([
        watch.then(() => 'resolved'),
        new Promise((resolve) => setTimeout(() => resolve('pending'), 800)),
      ]);
      expect(settled).toBe('pending');

      // The zero balance is still observed once — a change from unknown to 0.
      const events = fundingEvents(journal, 'run-below');
      expect(events).toHaveLength(1);
      expect(events[0]?.funded).toBe(false);
    } finally {
      controller.abort();
      journal.close();
    }
  }, 30_000);

  it('resolves after funding and appends funding.balance only on change', async () => {
    const journal = new EventJournal(':memory:');
    const controller = new AbortController();
    const address = addressFor(0xcc1);
    try {
      await anvil.setBalance(address, parseEther('0.3'));
      await anvil.mine(1);

      const watch = awaitFunding({
        profile,
        entries: [{ entrantId: 'e1', address }],
        thresholdWei: parseEther('1'),
        journal,
        runId: 'run-cross',
        pollMs: 100,
        signal: controller.signal,
      });
      watch.catch(() => undefined);

      // Poll many times against a steady balance: exactly one event, still pending.
      await new Promise((resolve) => setTimeout(resolve, 700));
      expect(fundingEvents(journal, 'run-cross')).toHaveLength(1);

      await anvil.setBalance(address, parseEther('3'));
      await anvil.mine(1);

      await watch; // resolves once the confirmed balance crosses the threshold

      const events = fundingEvents(journal, 'run-cross');
      expect(events).toHaveLength(2);
      expect(events[0]?.funded).toBe(false);
      expect(events[1]?.funded).toBe(true);
      expect(events[1]?.source).toBe('e1');
      expect(events[1]?.wei).toBe(parseEther('3').toString());
    } finally {
      controller.abort();
      journal.close();
    }
  }, 30_000);

  it('rejects with AbortError and stops promptly when the signal fires', async () => {
    const journal = new EventJournal(':memory:');
    const controller = new AbortController();
    const address = addressFor(0xdd1);
    try {
      const watch = awaitFunding({
        profile,
        entries: [{ entrantId: 'e1', address }],
        thresholdWei: parseEther('1'),
        journal,
        runId: 'run-abort',
        pollMs: 200,
        signal: controller.signal,
      });

      setTimeout(() => controller.abort(), 250);
      const start = Date.now();
      await expect(watch).rejects.toMatchObject({ name: 'AbortError' });
      // A leaked timer would keep it sleeping a full poll past the abort.
      expect(Date.now() - start).toBeLessThan(3_000);
    } finally {
      journal.close();
    }
  }, 30_000);
});
