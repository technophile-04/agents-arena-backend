import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import type { EntrantDriver } from '../../src/adapters/types.js';
import { createLocalFundingGate, createWalletGate } from '../../src/chain/funding-gate.js';
import { getWallet } from '../../src/chain/wallet.js';
import { entrants, runs, wallets } from '../../src/db/schema.js';
import { EventJournal } from '../../src/journal.js';
import { RunManager } from '../../src/run-manager.js';

const noopDriver: EntrantDriver = {
  async prepare() {},
  async start() {},
  async steer() {},
  async stop() {},
};

async function seedRun(preset: 'docker-duel' | 'fake-duel') {
  const journal = new EventJournal(':memory:');
  const manager = new RunManager(journal, noopDriver);
  const created = await manager.create({ preset });
  const run = journal.database.select().from(runs).where(eq(runs.id, created.run.id)).get();
  const runEntrants = journal.database
    .select()
    .from(entrants)
    .where(eq(entrants.runId, created.run.id))
    .all();
  if (run === undefined) {
    throw new Error('Test run was not seeded');
  }
  return { journal, run, runEntrants };
}

describe('wallet gate', () => {
  it('assigns wallets, persists addresses, mutates entrants, and emits lane events', async () => {
    const { journal, run, runEntrants } = await seedRun('docker-duel');
    try {
      await createWalletGate(journal)(run, runEntrants);

      for (const entrant of runEntrants) {
        expect(entrant.address).not.toBeNull();
        const wallet = getWallet(run.id, entrant.id, journal.database);
        expect(wallet?.address).toBe(entrant.address);
        const row = journal.database
          .select()
          .from(entrants)
          .where(and(eq(entrants.runId, run.id), eq(entrants.id, entrant.id)))
          .get();
        expect(row?.address).toBe(entrant.address);
      }

      const assigned = journal.after(run.id, 0).filter((event) => event.type === 'wallet.assigned');
      expect(assigned).toHaveLength(2);
      for (const event of assigned) {
        expect(event.source).toBe(event.payload.entrantId);
        const entrant = runEntrants.find((candidate) => candidate.id === event.payload.entrantId);
        expect(event.payload.address).toBe(entrant?.address);
      }
    } finally {
      journal.close();
    }
  });

  it('reuses existing wallets on a second call', async () => {
    const { journal, run, runEntrants } = await seedRun('docker-duel');
    try {
      const gate = createWalletGate(journal);
      await gate(run, runEntrants);
      const firstAddresses = runEntrants.map((entrant) => entrant.address);

      await gate(run, runEntrants);

      expect(runEntrants.map((entrant) => entrant.address)).toEqual(firstAddresses);
      expect(journal.database.select().from(wallets).all()).toHaveLength(2);
    } finally {
      journal.close();
    }
  });

  it('does nothing outside docker-duel', async () => {
    const { journal, run, runEntrants } = await seedRun('fake-duel');
    try {
      await createWalletGate(journal)(run, runEntrants);

      expect(runEntrants.map((entrant) => entrant.address)).toEqual([null, null]);
      expect(runEntrants.map((entrant) => getWallet(run.id, entrant.id, journal.database))).toEqual([null, null]);
      expect(journal.after(run.id, 0).filter((event) => event.type === 'wallet.assigned')).toEqual([]);
    } finally {
      journal.close();
    }
  });
});

describe('local funding gate', () => {
  it('does nothing outside docker-duel', async () => {
    const { journal, run, runEntrants } = await seedRun('fake-duel');
    try {
      await createLocalFundingGate(journal)(run, runEntrants);
      expect(journal.after(run.id, 0).filter((event) => event.type === 'funding.balance')).toEqual([]);
    } finally {
      journal.close();
    }
  });

  it('throws when a docker-duel entrant has no address', async () => {
    const { journal, run, runEntrants } = await seedRun('docker-duel');
    try {
      await expect(createLocalFundingGate(journal)(run, runEntrants)).rejects.toThrow(
        'Entrant codex-1 has no wallet address',
      );
    } finally {
      journal.close();
    }
  });
});
