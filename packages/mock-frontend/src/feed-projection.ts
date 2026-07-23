import type { ArenaEvent } from '../../../contract/arena-types';

// The global `id` is a journal-wide autoincrement shared across runs, so within
// one run it legitimately skips whenever another run writes events. Data loss is
// only real when a per-source `seq` skips: seq is contiguous per (runId, source).
// This module tracks per-source seq for gap detection and dedupes on `id` so the
// replay overlap after an EventSource reconnect never double-counts an event.

export const RUN_SOURCE = 'run';

export interface FeedGap {
  source: string;
  from: number; // last seq seen for the source
  to: number; // seq of the event that skipped ahead
}

export interface FeedState {
  events: ArenaEvent[]; // deduped, in arrival order
  seenIds: Set<number>; // every global id already ingested
  lastSeqBySource: Record<string, number>; // highest seq seen per source
  gaps: FeedGap[]; // per-source seq skips observed so far
}

export function initialFeedState(): FeedState {
  return { events: [], seenIds: new Set<number>(), lastSeqBySource: {}, gaps: [] };
}

// Ingest one streamed event. Pure: returns the same state object when the event
// is a duplicate so React can skip re-rendering.
export function ingestEvent(state: FeedState, event: ArenaEvent): FeedState {
  if (state.seenIds.has(event.id)) return state; // replay overlap after reconnect

  const lastSeq = state.lastSeqBySource[event.source];
  const gaps = lastSeq !== undefined && event.seq > lastSeq + 1
    ? [...state.gaps, { source: event.source, from: lastSeq, to: event.seq }]
    : state.gaps;

  const seenIds = new Set(state.seenIds);
  seenIds.add(event.id);

  return {
    events: [...state.events, event],
    seenIds,
    lastSeqBySource: {
      ...state.lastSeqBySource,
      [event.source]: lastSeq === undefined ? event.seq : Math.max(lastSeq, event.seq),
    },
    gaps,
  };
}

// Events belonging to one entrant lane. The fake driver stamps entrant events
// with `source === entrant.id`; run-level events use RUN_SOURCE.
export function eventsForSource(events: ArenaEvent[], source: string): ArenaEvent[] {
  return events.filter((event) => event.source === source);
}

export function isRunLevel(event: ArenaEvent): boolean {
  return event.source === RUN_SOURCE;
}

export function gapsForSource(gaps: FeedGap[], source: string): FeedGap[] {
  return gaps.filter((gap) => gap.source === source);
}

// One-line human summary for every ArenaEvent type. Any type the UI does not
// know renders through the raw fallback so the feed never blanks out.
export function describeEvent(event: ArenaEvent): string {
  switch (event.type) {
    case 'run.state':
      return `run → ${event.payload.state}${event.payload.reason ? ` (${event.payload.reason})` : ''}`;
    case 'entrant.status':
      return `status → ${event.payload.status}`;
    case 'agent.message':
      return `says: ${event.payload.text}`;
    case 'agent.reasoning':
      return `thinks: ${event.payload.text}`;
    case 'tool.call':
      return `calls ${event.payload.tool}: ${event.payload.detail}`;
    case 'tool.result':
      return `${event.payload.tool} → ${event.payload.ok ? 'ok' : 'fail'}: ${event.payload.detail}`;
    case 'entrant.steered':
      return `steered: ${event.payload.text}`;
    case 'entrant.prompt':
      return `task: ${event.payload.text}`;
    case 'entrant.nudged':
      return `nudged (flags ${event.payload.flags}): ${event.payload.text}`;
    case 'wallet.assigned':
      return `wallet ${event.payload.address}`;
    case 'funding.balance':
      return `balance ${event.payload.wei} wei${event.payload.funded ? ' (funded)' : ''}`;
    case 'score.flag':
      return `flag challenge ${event.payload.challengeId} token ${event.payload.tokenId} (${event.payload.txHash})`;
    case 'entrant.error':
      return `error: ${event.payload.message}`;
    case 'run.error':
      return `run error: ${event.payload.message}`;
    case 'usage':
      return `usage in ${event.payload.inputTokens} / out ${event.payload.outputTokens}`;
    default:
      // Unknown-to-the-UI type: never blank the row, show the raw payload.
      return rawFallback(event);
  }
}

function rawFallback(event: ArenaEvent): string {
  return `${(event as { type: string }).type}: ${JSON.stringify((event as { payload: unknown }).payload)}`;
}
