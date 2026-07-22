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

interface Deferred {
  resolve(): void;
  reject(error: Error): void;
}

class BarrierDriver implements EntrantDriver {
  readonly prepareControls = new Map<string, Deferred>();
  readonly starts: Array<{ entrantId: string; startedAt: string | null }> = [];
  readonly stops: string[] = [];

  async prepare(_run: Parameters<EntrantDriver['prepare']>[0], entrant: Parameters<EntrantDriver['prepare']>[1]) {
    await new Promise<void>((resolve, reject) => {
      this.prepareControls.set(entrant.id, { resolve: () => resolve(), reject });
    });
  }

  async start(run: Parameters<EntrantDriver['start']>[0], entrant: Parameters<EntrantDriver['start']>[1]) {
    this.starts.push({ entrantId: entrant.id, startedAt: run.startedAt });
  }

  async steer() {}

  async stop(_run: Parameters<EntrantDriver['stop']>[0], entrant: Parameters<EntrantDriver['stop']>[1]) {
    this.stops.push(entrant.id);
  }
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error('Condition was not met');
}

describe('RunManager ready barrier', () => {
  it('waits for both entrants and gives them one recorded start time', async () => {
    const journal = new EventJournal(':memory:');
    const driver = new BarrierDriver();
    const manager = new RunManager(journal, driver);
    try {
      const { run } = await manager.create({ preset: 'docker-duel' });
      const starting = manager.start(run.id);
      await waitFor(() => driver.prepareControls.size === 2);

      driver.prepareControls.get('codex-1')?.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(driver.starts).toEqual([]);

      driver.prepareControls.get('opencode-1')?.resolve();
      const started = await starting;
      expect(started.state).toBe('running');
      expect(started.startedAt).not.toBeNull();
      expect(driver.starts).toHaveLength(2);
      expect(new Set(driver.starts.map((call) => call.startedAt))).toEqual(new Set([started.startedAt]));
    } finally {
      journal.close();
    }
  });

  it('starts neither entrant and tears down both when one preflight fails', async () => {
    const journal = new EventJournal(':memory:');
    const driver = new BarrierDriver();
    const manager = new RunManager(journal, driver);
    try {
      const { run } = await manager.create({ preset: 'docker-duel' });
      const outcome = manager.start(run.id).then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      await waitFor(() => driver.prepareControls.size === 2);

      driver.prepareControls.get('codex-1')?.reject(new Error('codex preflight failed'));
      driver.prepareControls.get('opencode-1')?.resolve();
      const result = await outcome;

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toEqual(new Error('codex preflight failed'));
      expect(driver.starts).toEqual([]);
      expect(driver.stops.sort()).toEqual(['codex-1', 'opencode-1']);
      expect(manager.snapshot(run.id).state).toBe('failed');
    } finally {
      journal.close();
    }
  });
});
