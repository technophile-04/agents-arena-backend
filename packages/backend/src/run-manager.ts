import { randomUUID } from 'node:crypto';

import { and, asc, count, eq, max } from 'drizzle-orm';

import type { CreateRunRequest, EntrantSummary, RunSnapshot, RunState } from './contract.js';
import { entrants, events, runs } from './db/schema.js';
import type { EventJournal } from './journal.js';
import type { EntrantDriver, EntrantRecord, RunRecord } from './adapters/types.js';

export const LEGAL_TRANSITIONS: Readonly<Record<RunState, readonly RunState[]>> = {
  created: ['preparing', 'failed'],
  preparing: ['awaiting_funding', 'failed'],
  awaiting_funding: ['ready', 'failed'],
  ready: ['running', 'failed'],
  running: ['stopping', 'failed'],
  stopping: ['finished', 'failed'],
  finished: [],
  failed: [],
};

export class RunNotFoundError extends Error {}
export class EntrantNotFoundError extends Error {}
export class InvalidTransitionError extends Error {}
export class UnknownPresetError extends Error {}

export interface CreateRunResult {
  run: RunSnapshot;
  created: boolean;
}

export class RunManager {
  constructor(
    private readonly journal: EventJournal,
    private readonly driver: EntrantDriver,
  ) {}

  async create(input: CreateRunRequest): Promise<CreateRunResult> {
    if (input.idempotencyKey !== undefined) {
      const existing = this.journal.database
        .select({ id: runs.id })
        .from(runs)
        .where(eq(runs.idempotencyKey, input.idempotencyKey))
        .get();
      if (existing !== undefined) {
        return { run: this.snapshot(existing.id), created: false };
      }
    }

    if (input.preset !== 'fake-duel') {
      throw new UnknownPresetError(`Unknown preset: ${input.preset}`);
    }

    const id = randomUUID();
    const now = new Date().toISOString();
    this.journal.database.transaction((transaction) => {
      transaction.insert(runs).values({
        id,
        state: 'created',
        preset: input.preset,
        startedAt: null,
        deadlineAt: null,
        idempotencyKey: input.idempotencyKey ?? null,
        createdAt: now,
      }).run();
      transaction.insert(entrants).values([
        {
          runId: id,
          id: 'codex-1',
          harness: 'codex',
          model: 'gpt-5-codex',
          address: null,
          status: 'idle',
          flags: 0,
        },
        {
          runId: id,
          id: 'opencode-1',
          harness: 'opencode',
          model: 'opencode-fake-1',
          address: null,
          status: 'idle',
          flags: 0,
        },
      ]).run();
    });
    this.journal.append(id, 'run', 'run.state', { state: 'created' });

    if (input.autoStart === true) {
      await this.start(id);
    }
    return { run: this.snapshot(id), created: true };
  }

  snapshot(runId: string): RunSnapshot {
    const run = this.requireRun(runId);
    const entrantSummaries = this.entrants(runId).map<EntrantSummary>((entrant) => ({
      id: entrant.id,
      harness: entrant.harness,
      model: entrant.model,
      address: entrant.address,
      status: entrant.status,
      flags: entrant.flags,
    }));
    const lastEvent = this.journal.database
      .select({ id: max(events.id) })
      .from(events)
      .where(eq(events.runId, runId))
      .get();

    return {
      id: run.id,
      state: run.state,
      preset: run.preset,
      entrants: entrantSummaries,
      startedAt: run.startedAt,
      deadlineAt: run.deadlineAt,
      lastEventId: lastEvent?.id ?? 0,
    };
  }

  transition(runId: string, nextState: RunState, reason?: string): RunRecord {
    const run = this.requireRun(runId);
    if (!LEGAL_TRANSITIONS[run.state].includes(nextState)) {
      throw new InvalidTransitionError(`Cannot move run ${runId} from ${run.state} to ${nextState}`);
    }

    const startedAt = nextState === 'running' ? new Date().toISOString() : run.startedAt;
    this.journal.database
      .update(runs)
      .set({ state: nextState, startedAt })
      .where(eq(runs.id, runId))
      .run();
    const payload = reason === undefined ? { state: nextState } : { state: nextState, reason };
    this.journal.append(runId, 'run', 'run.state', payload);
    return this.requireRun(runId);
  }

  async start(runId: string): Promise<RunSnapshot> {
    let run = this.requireRun(runId);
    try {
      if (run.state === 'created') {
        run = this.transition(runId, 'preparing');
        for (const entrant of this.entrants(runId)) {
          await this.driver.prepare(run, entrant);
        }
        run = this.transition(runId, 'awaiting_funding');
        run = this.transition(runId, 'ready');
      }
      if (run.state !== 'ready') {
        throw new InvalidTransitionError(`Cannot start run ${runId} from ${run.state}`);
      }

      run = this.transition(runId, 'running');
      for (const entrant of this.entrants(runId)) {
        await this.driver.start(run, entrant, 'Solve the arena challenge and capture every flag.');
      }
      return this.snapshot(runId);
    } catch (error) {
      const current = this.requireRun(runId);
      if (current.state !== 'failed' && current.state !== 'finished') {
        this.transition(runId, 'failed', error instanceof Error ? error.message : String(error));
      }
      throw error;
    }
  }

  async stop(runId: string): Promise<RunSnapshot> {
    let run = this.requireRun(runId);
    if (run.state !== 'running') {
      throw new InvalidTransitionError(`Cannot stop run ${runId} from ${run.state}`);
    }
    try {
      run = this.transition(runId, 'stopping');
      for (const entrant of this.entrants(runId)) {
        await this.driver.stop(run, entrant);
      }
      this.transition(runId, 'finished');
      return this.snapshot(runId);
    } catch (error) {
      const current = this.requireRun(runId);
      if (current.state !== 'failed' && current.state !== 'finished') {
        this.transition(runId, 'failed', error instanceof Error ? error.message : String(error));
      }
      throw error;
    }
  }

  async steer(runId: string, entrantId: string, text: string): Promise<void> {
    const run = this.requireRun(runId);
    const entrant = this.journal.database
      .select()
      .from(entrants)
      .where(and(eq(entrants.runId, runId), eq(entrants.id, entrantId)))
      .get();
    if (entrant === undefined) {
      throw new EntrantNotFoundError(`Entrant ${entrantId} does not exist in run ${runId}`);
    }
    await this.driver.steer(run, entrant, text);
  }

  hasRun(runId: string): boolean {
    return this.journal.database
      .select({ id: runs.id })
      .from(runs)
      .where(eq(runs.id, runId))
      .get() !== undefined;
  }

  countRuns(): number {
    return this.journal.database.select({ value: count() }).from(runs).get()?.value ?? 0;
  }

  private requireRun(runId: string): RunRecord {
    const run = this.journal.database.select().from(runs).where(eq(runs.id, runId)).get();
    if (run === undefined) {
      throw new RunNotFoundError(`Run not found: ${runId}`);
    }
    return run;
  }

  private entrants(runId: string): EntrantRecord[] {
    return this.journal.database
      .select()
      .from(entrants)
      .where(eq(entrants.runId, runId))
      .orderBy(asc(entrants.id))
      .all();
  }
}
