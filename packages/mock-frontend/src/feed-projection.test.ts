import { describe, expect, it } from 'vitest';

import type { ArenaEvent } from '../../../contract/arena-types';
import {
  describeEvent,
  eventsForSource,
  gapsForSource,
  ingestEvent,
  initialFeedState,
  isRunLevel,
  RUN_SOURCE,
  type FeedState,
} from './feed-projection';

// Minimal event builder. Global id and per-source seq are set explicitly so
// tests exercise the exact skip patterns the backend can produce.
function evt(partial: Partial<ArenaEvent> & Pick<ArenaEvent, 'id' | 'source' | 'seq'>): ArenaEvent {
  return {
    runId: 'run-1',
    ts: '2026-07-22T00:00:00.000Z',
    type: 'agent.message',
    payload: { entrantId: partial.source, text: 'hi' },
    ...partial,
  } as ArenaEvent;
}

function feedFrom(events: ArenaEvent[]): FeedState {
  return events.reduce(ingestEvent, initialFeedState());
}

describe('ingestEvent — seq gap detection', () => {
  it('does not flag a global id skip when per-source seq stays contiguous', () => {
    // ids jump 10 → 40 (another run wrote in between) but codex-1 seq is 1,2,3.
    const feed = feedFrom([
      evt({ id: 10, source: 'codex-1', seq: 1 }),
      evt({ id: 25, source: 'codex-1', seq: 2 }),
      evt({ id: 40, source: 'codex-1', seq: 3 }),
    ]);
    expect(feed.gaps).toHaveLength(0);
    expect(feed.events).toHaveLength(3);
  });

  it('flags a real gap when a source seq skips forward', () => {
    const feed = feedFrom([
      evt({ id: 10, source: 'codex-1', seq: 1 }),
      evt({ id: 11, source: 'codex-1', seq: 4 }), // seq 2,3 missing
    ]);
    expect(feed.gaps).toEqual([{ source: 'codex-1', from: 1, to: 4 }]);
  });

  it('tracks seq per source independently', () => {
    const feed = feedFrom([
      evt({ id: 1, source: 'codex-1', seq: 1 }),
      evt({ id: 2, source: 'opencode-1', seq: 1 }),
      evt({ id: 3, source: 'codex-1', seq: 2 }),
      evt({ id: 4, source: 'opencode-1', seq: 5 }), // opencode gap
    ]);
    expect(gapsForSource(feed.gaps, 'codex-1')).toHaveLength(0);
    expect(gapsForSource(feed.gaps, 'opencode-1')).toEqual([{ source: 'opencode-1', from: 1, to: 5 }]);
  });
});

describe('ingestEvent — id dedup on replay overlap', () => {
  it('drops a repeated id after reconnect and does not re-count it', () => {
    const first = feedFrom([
      evt({ id: 10, source: 'codex-1', seq: 1 }),
      evt({ id: 11, source: 'codex-1', seq: 2 }),
    ]);
    // Reconnect replays id 11 (overlap), then continues with 12.
    const after = [
      evt({ id: 11, source: 'codex-1', seq: 2 }),
      evt({ id: 12, source: 'codex-1', seq: 3 }),
    ].reduce(ingestEvent, first);
    expect(after.events.map((e) => e.id)).toEqual([10, 11, 12]);
    expect(after.gaps).toHaveLength(0);
  });

  it('returns the same state object for a duplicate so React skips a render', () => {
    const feed = feedFrom([evt({ id: 10, source: 'codex-1', seq: 1 })]);
    const again = ingestEvent(feed, evt({ id: 10, source: 'codex-1', seq: 1 }));
    expect(again).toBe(feed);
  });

  it('a replayed duplicate does not produce a false gap', () => {
    // Contiguous seq, but id 11 replayed out of order after 12 arrived.
    const feed = feedFrom([
      evt({ id: 10, source: 'codex-1', seq: 1 }),
      evt({ id: 11, source: 'codex-1', seq: 2 }),
      evt({ id: 12, source: 'codex-1', seq: 3 }),
      evt({ id: 11, source: 'codex-1', seq: 2 }), // replay overlap
    ]);
    expect(feed.gaps).toHaveLength(0);
    expect(feed.events).toHaveLength(3);
  });
});

describe('event → lane routing', () => {
  const events: ArenaEvent[] = [
    { id: 1, runId: 'run-1', source: RUN_SOURCE, seq: 1, ts: 'now', type: 'run.state', payload: { state: 'running' } },
    evt({ id: 2, source: 'codex-1', seq: 1 }),
    evt({ id: 3, source: 'opencode-1', seq: 1 }),
    evt({ id: 4, source: 'codex-1', seq: 2 }),
  ];

  it('routes each entrant source to its own lane', () => {
    expect(eventsForSource(events, 'codex-1').map((e) => e.id)).toEqual([2, 4]);
    expect(eventsForSource(events, 'opencode-1').map((e) => e.id)).toEqual([3]);
  });

  it('routes run-source events to the run lane only', () => {
    expect(eventsForSource(events, RUN_SOURCE).map((e) => e.id)).toEqual([1]);
    expect(isRunLevel(events[0]!)).toBe(true);
    expect(isRunLevel(events[1]!)).toBe(false);
  });
});

describe('describeEvent — all 14 contract types render', () => {
  const base = { id: 1, runId: 'run-1', source: 'codex-1', seq: 1, ts: 'now' };
  const samples: ArenaEvent[] = [
    { ...base, source: RUN_SOURCE, type: 'run.state', payload: { state: 'running' } },
    { ...base, type: 'entrant.status', payload: { entrantId: 'codex-1', status: 'working' } },
    { ...base, type: 'agent.message', payload: { entrantId: 'codex-1', text: 'hi' } },
    { ...base, type: 'agent.reasoning', payload: { entrantId: 'codex-1', text: 'thinking' } },
    { ...base, type: 'tool.call', payload: { entrantId: 'codex-1', tool: 'bash', detail: 'ls' } },
    { ...base, type: 'tool.result', payload: { entrantId: 'codex-1', tool: 'bash', ok: true, detail: 'ok' } },
    { ...base, type: 'entrant.steered', payload: { entrantId: 'codex-1', text: 'go' } },
    { ...base, type: 'entrant.nudged', payload: { entrantId: 'codex-1', text: 'nudge', flags: 1 } },
    { ...base, type: 'wallet.assigned', payload: { entrantId: 'codex-1', address: '0xabc' } },
    { ...base, type: 'funding.balance', payload: { entrantId: 'codex-1', address: '0xabc', wei: '100', funded: true } },
    { ...base, type: 'score.flag', payload: { entrantId: 'codex-1', challengeId: 1, txHash: '0xtx', tokenId: '7' } },
    { ...base, type: 'entrant.error', payload: { entrantId: 'codex-1', message: 'boom' } },
    { ...base, source: RUN_SOURCE, type: 'run.error', payload: { message: 'fatal' } },
    { ...base, type: 'usage', payload: { entrantId: 'codex-1', inputTokens: 10, outputTokens: 5 } },
  ];

  it('covers every contract event type', () => {
    expect(samples).toHaveLength(14);
  });

  it('renders a non-empty summary for each without throwing', () => {
    for (const event of samples) {
      const line = describeEvent(event);
      expect(line.length).toBeGreaterThan(0);
    }
  });

  it('falls back to a raw payload dump for an unknown-to-the-UI type', () => {
    const unknown = { ...base, type: 'future.type', payload: { foo: 'bar' } } as unknown as ArenaEvent;
    const line = describeEvent(unknown);
    expect(line).toContain('future.type');
    expect(line).toContain('foo');
  });
});
