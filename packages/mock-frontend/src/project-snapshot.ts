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
  return { ...current, lastEventId: event.id };
}
