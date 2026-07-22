import { describe, expect, it } from 'vitest';

import { EventJournal } from '../src/journal.js';

describe('EventJournal', () => {
  it('assigns global IDs and per-source sequences', () => {
    const journal = new EventJournal(':memory:');
    try {
      const first = journal.append('run-1', 'codex-1', 'agent.message', {
        entrantId: 'codex-1',
        text: 'one',
      });
      const second = journal.append('run-1', 'opencode-1', 'agent.message', {
        entrantId: 'opencode-1',
        text: 'two',
      });
      const third = journal.append('run-1', 'codex-1', 'agent.message', {
        entrantId: 'codex-1',
        text: 'three',
      });

      expect([first.id, second.id, third.id]).toEqual([1, 2, 3]);
      expect([first.seq, second.seq, third.seq]).toEqual([1, 1, 2]);
    } finally {
      journal.close();
    }
  });

  it('replays the exact events after an ID', () => {
    const journal = new EventJournal(':memory:');
    try {
      journal.append('run-1', 'run', 'run.state', { state: 'created' });
      const second = journal.append('run-1', 'run', 'run.state', { state: 'preparing' });
      const otherRun = journal.append('run-2', 'run', 'run.state', { state: 'created' });
      const fourth = journal.append('run-1', 'run', 'run.state', { state: 'awaiting_funding' });

      expect(journal.after('run-1', 1)).toEqual([second, fourth]);
      expect(journal.after('run-1', otherRun.id)).toEqual([fourth]);
    } finally {
      journal.close();
    }
  });

  it('keeps each source sequence monotonic across concurrent callers', async () => {
    const journal = new EventJournal(':memory:');
    try {
      await Promise.all(Array.from({ length: 40 }, async (_, index) => {
        await Promise.resolve();
        const entrantId = index % 2 === 0 ? 'codex-1' : 'opencode-1';
        journal.append('run-1', entrantId, 'agent.message', {
          entrantId,
          text: String(index),
        });
      }));

      const events = journal.after('run-1', 0);
      expect(events.map((event) => event.id)).toEqual(Array.from({ length: 40 }, (_, index) => index + 1));
      for (const source of ['codex-1', 'opencode-1']) {
        expect(events.filter((event) => event.source === source).map((event) => event.seq))
          .toEqual(Array.from({ length: 20 }, (_, index) => index + 1));
      }
    } finally {
      journal.close();
    }
  });
});
