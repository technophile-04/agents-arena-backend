import type { ArenaEvent, RunSnapshot } from '../../../contract/arena-types';

export function projectSnapshot(current: RunSnapshot | undefined, event: ArenaEvent): RunSnapshot | undefined {
  if (current === undefined) return current;
  if (event.type === 'run.state') {
    return { ...current, state: event.payload.state, lastEventId: event.id };
  }
  if (event.type === 'entrant.status') {
    return {
      ...current,
      lastEventId: event.id,
      entrants: current.entrants.map((entrant) => entrant.id === event.payload.entrantId
        ? { ...entrant, status: event.payload.status }
        : entrant),
    };
  }
  if (event.type === 'score.flag') {
    return {
      ...current,
      lastEventId: event.id,
      entrants: current.entrants.map((entrant) => entrant.id === event.payload.entrantId
        ? {
          ...entrant,
          flags: entrant.flags + 1,
          solves: [
            ...entrant.solves,
            { challengeId: event.payload.challengeId, ts: event.ts, txHash: event.payload.txHash },
          ],
        }
        : entrant),
    };
  }
  return { ...current, lastEventId: event.id };
}
