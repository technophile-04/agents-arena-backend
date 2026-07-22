import { describe, expect, it } from 'vitest';

import type { ArenaEvent, RunSnapshot } from '../../../contract/arena-types';
import { projectSnapshot } from './project-snapshot';

const snapshot: RunSnapshot = {
  id: 'run-1',
  state: 'created',
  preset: 'fake-duel',
  entrants: [
    {
      id: 'codex-1',
      harness: 'codex',
      model: 'gpt-5-codex',
      address: null,
      status: 'idle',
      flags: 0,
    },
  ],
  startedAt: null,
  deadlineAt: null,
  lastEventId: 1,
};

describe('projectSnapshot', () => {
  it('projects run state events', () => {
    const event: ArenaEvent = {
      id: 2,
      runId: 'run-1',
      source: 'run',
      seq: 2,
      ts: '2026-07-22T00:00:00.000Z',
      type: 'run.state',
      payload: { state: 'preparing' },
    };

    expect(projectSnapshot(snapshot, event)).toMatchObject({ state: 'preparing', lastEventId: 2 });
  });

  it('projects entrant status events', () => {
    const event: ArenaEvent = {
      id: 3,
      runId: 'run-1',
      source: 'codex-1',
      seq: 1,
      ts: '2026-07-22T00:00:01.000Z',
      type: 'entrant.status',
      payload: { entrantId: 'codex-1', status: 'working' },
    };

    expect(projectSnapshot(snapshot, event)?.entrants[0]?.status).toBe('working');
  });
});
