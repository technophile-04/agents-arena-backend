import { and, asc, eq, gt, max } from 'drizzle-orm';

import type { ArenaEvent } from './contract.js';
import { openArenaDatabase, type ArenaDatabase } from './db/index.js';
import { events } from './db/schema.js';

type EventType = ArenaEvent['type'];
type EventOfType<T extends EventType> = Extract<ArenaEvent, { type: T }>;
type EventPayload<T extends EventType> = EventOfType<T>['payload'];
type Subscriber = (event: ArenaEvent) => void;

export class EventJournal {
  readonly database: ArenaDatabase;

  private readonly sqlite: ReturnType<typeof openArenaDatabase>['sqlite'];
  private readonly subscribers = new Map<string, Set<Subscriber>>();

  constructor(path = process.env.ARENA_DB ?? './arena.db') {
    const opened = openArenaDatabase(path);
    this.database = opened.database;
    this.sqlite = opened.sqlite;
  }

  append<T extends EventType>(
    runId: string,
    source: string,
    type: T,
    payload: EventPayload<T>,
  ): EventOfType<T> {
    const event = this.database.transaction((transaction) => {
      const sequence = transaction
        .select({ current: max(events.seq) })
        .from(events)
        .where(and(eq(events.runId, runId), eq(events.source, source)))
        .get();
      const seq = (sequence?.current ?? 0) + 1;
      const ts = new Date().toISOString();
      const inserted = transaction
        .insert(events)
        .values({ runId, source, seq, ts, type, payloadJson: JSON.stringify(payload) })
        .returning({ id: events.id })
        .get();
      return {
        id: inserted.id,
        runId,
        source,
        seq,
        ts,
        type,
        payload,
      } as EventOfType<T>;
    });

    for (const subscriber of this.subscribers.get(runId) ?? []) {
      subscriber(event);
    }
    return event;
  }

  after(runId: string, afterId: number): ArenaEvent[] {
    return this.database
      .select()
      .from(events)
      .where(and(eq(events.runId, runId), gt(events.id, afterId)))
      .orderBy(asc(events.id))
      .all()
      .map((row) => ({
        id: row.id,
        runId: row.runId,
        source: row.source,
        seq: row.seq,
        ts: row.ts,
        type: row.type,
        payload: JSON.parse(row.payloadJson) as ArenaEvent['payload'],
      } as ArenaEvent));
  }

  subscribe(runId: string, subscriber: Subscriber): () => void {
    const runSubscribers = this.subscribers.get(runId) ?? new Set<Subscriber>();
    runSubscribers.add(subscriber);
    this.subscribers.set(runId, runSubscribers);

    return () => {
      runSubscribers.delete(subscriber);
      if (runSubscribers.size === 0) {
        this.subscribers.delete(runId);
      }
    };
  }

  close(): void {
    this.subscribers.clear();
    this.sqlite.close();
  }
}
