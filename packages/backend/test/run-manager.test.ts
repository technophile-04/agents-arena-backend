import { describe, expect, it } from 'vitest';

import type { EntrantDriver } from '../src/adapters/types.js';
import { EventJournal } from '../src/journal.js';
import { InvalidTransitionError, LEGAL_TRANSITIONS, RunManager } from '../src/run-manager.js';
import type { RunState } from '../src/contract.js';

const noopDriver: EntrantDriver = {
  async prepare() {},
  async start() {},
  async steer() {},
  async stop() {},
};

async function createManager() {
  const journal = new EventJournal(':memory:');
  const manager = new RunManager(journal, noopDriver);
  const { run } = await manager.create({ preset: 'fake-duel' });
  return { journal, manager, runId: run.id };
}

async function advance(manager: RunManager, runId: string, target: RunState): Promise<void> {
  const path: RunState[] = ['created', 'preparing', 'awaiting_funding', 'ready', 'running', 'stopping', 'finished'];
  const targetIndex = path.indexOf(target);
  for (const state of path.slice(1, targetIndex + 1)) {
    manager.transition(runId, state);
  }
}

describe('RunManager state machine', () => {
  const legalEdges = Object.entries(LEGAL_TRANSITIONS).flatMap(([from, destinations]) =>
    destinations.map((to) => [from as RunState, to] as const),
  );

  it.each(legalEdges)('allows %s → %s', async (from, to) => {
    const { journal, manager, runId } = await createManager();
    try {
      await advance(manager, runId, from);
      expect(manager.transition(runId, to).state).toBe(to);
      const stateEvents = journal.after(runId, 0).filter((event) => event.type === 'run.state');
      expect(stateEvents.at(-1)?.payload.state).toBe(to);
    } finally {
      journal.close();
    }
  });

  it('rejects every transition outside the legal table', async () => {
    const states = Object.keys(LEGAL_TRANSITIONS) as RunState[];
    for (const from of states) {
      if (from === 'failed') continue;
      const { journal, manager, runId } = await createManager();
      try {
        await advance(manager, runId, from);
        for (const to of states.filter((candidate) => !LEGAL_TRANSITIONS[from].includes(candidate))) {
          expect(() => manager.transition(runId, to)).toThrow(InvalidTransitionError);
        }
      } finally {
        journal.close();
      }
    }
  });

  it.each(['created', 'preparing', 'awaiting_funding', 'ready', 'running', 'stopping'] as const)(
    'allows failure from %s',
    async (from) => {
      const { journal, manager, runId } = await createManager();
      try {
        await advance(manager, runId, from);
        expect(manager.transition(runId, 'failed', 'test failure').state).toBe('failed');
      } finally {
        journal.close();
      }
    },
  );
});

describe('RunManager idempotency', () => {
  it('returns one run for repeated idempotency keys', async () => {
    const journal = new EventJournal(':memory:');
    const manager = new RunManager(journal, noopDriver);
    try {
      const first = await manager.create({ preset: 'fake-duel', idempotencyKey: 'request-1' });
      const second = await manager.create({ preset: 'fake-duel', idempotencyKey: 'request-1' });

      expect(first.created).toBe(true);
      expect(second.created).toBe(false);
      expect(second.run.id).toBe(first.run.id);
      expect(manager.countRuns()).toBe(1);
      expect(journal.after(first.run.id, 0)).toHaveLength(1);
    } finally {
      journal.close();
    }
  });
});
