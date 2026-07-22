import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

const runStates = [
  'created',
  'preparing',
  'awaiting_funding',
  'ready',
  'running',
  'stopping',
  'finished',
  'failed',
] as const;

const harnessIds = ['codex', 'opencode', 'claude'] as const;
const entrantStatuses = ['working', 'idle', 'blocked', 'done'] as const;
const eventTypes = [
  'run.state',
  'entrant.status',
  'agent.message',
  'agent.reasoning',
  'tool.call',
  'tool.result',
  'entrant.steered',
  'entrant.nudged',
  'wallet.assigned',
  'funding.balance',
  'score.flag',
  'entrant.error',
  'run.error',
  'usage',
] as const;

export const runs = sqliteTable('runs', {
  id: text('id').primaryKey(),
  state: text('state', { enum: runStates }).notNull(),
  preset: text('preset').notNull(),
  startedAt: text('started_at'),
  deadlineAt: text('deadline_at'),
  idempotencyKey: text('idempotency_key').unique(),
  createdAt: text('created_at').notNull(),
});

export const entrants = sqliteTable('entrants', {
  runId: text('run_id').notNull().references(() => runs.id),
  id: text('id').notNull(),
  harness: text('harness', { enum: harnessIds }).notNull(),
  model: text('model').notNull(),
  address: text('address'),
  status: text('status', { enum: entrantStatuses }).notNull(),
  flags: integer('flags').notNull().default(0),
}, (table) => [
  uniqueIndex('entrants_run_id_id').on(table.runId, table.id),
]);

export const events = sqliteTable('events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  runId: text('run_id').notNull(),
  source: text('source').notNull(),
  seq: integer('seq').notNull(),
  ts: text('ts').notNull(),
  type: text('type', { enum: eventTypes }).notNull(),
  payloadJson: text('payload_json').notNull(),
}, (table) => [
  uniqueIndex('events_run_id_source_seq').on(table.runId, table.source, table.seq),
  index('events_run_id_id').on(table.runId, table.id),
]);

export const schema = { events, runs, entrants };
