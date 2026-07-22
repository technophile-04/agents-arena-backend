import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type { ArenaEvent, EntrantSummary, RunSnapshot } from '../../../contract/arena-types';
import { projectSnapshot } from './project-snapshot';
import {
  describeEvent,
  eventsForSource,
  gapsForSource,
  ingestEvent,
  initialFeedState,
  RUN_SOURCE,
  type FeedState,
} from './feed-projection';

const queryClient = new QueryClient();

function App() {
  const cache = useQueryClient();
  const [runId, setRunId] = useState<string | null>(null);
  const [feed, setFeed] = useState<FeedState>(initialFeedState);
  const [connection, setConnection] = useState('disconnected');
  const snapshot = useQuery({
    queryKey: ['run', runId],
    enabled: runId !== null,
    queryFn: async () => fetchJson<{ run: RunSnapshot }>(`/runs/${runId}`).then((body) => body.run),
  });
  const createRun = useMutation({
    mutationFn: async () => fetchJson<{ run: RunSnapshot }>('/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ preset: 'fake-duel', autoStart: true }),
    }),
    onSuccess: ({ run }) => {
      setFeed(initialFeedState());
      setRunId(run.id);
      cache.setQueryData(['run', run.id], run);
    },
  });
  const run = snapshot.data ?? null;

  useEffect(() => {
    if (runId === null) return;
    // Native EventSource auto-reconnects and resends the last SSE id as
    // Last-Event-ID (the global id), so the backend replays from there. Dedup on
    // id inside ingestEvent removes the replay overlap.
    const source = new EventSource(`/runs/${runId}/events`);
    source.onopen = () => setConnection('connected');
    source.onerror = () => setConnection('reconnecting…');
    source.onmessage = (message) => {
      const event = JSON.parse(message.data) as ArenaEvent;
      setFeed((current) => ingestEvent(current, event));
      cache.setQueryData<RunSnapshot>(['run', runId], (current) => projectSnapshot(current, event));
    };
    return () => source.close();
  }, [cache, runId]);

  const runLog = useMemo(() => eventsForSource(feed.events, RUN_SOURCE), [feed.events]);

  return (
    <main style={{ fontFamily: 'monospace', padding: 16 }}>
      <h1>Agents Arena mock</h1>
      <button disabled={createRun.isPending} onClick={() => createRun.mutate()}>
        {createRun.isPending ? 'Creating…' : 'Create and start fake duel'}
      </button>
      {createRun.error instanceof Error ? <p>{createRun.error.message}</p> : null}
      <p>Run: {run?.id ?? 'none'}</p>
      <p>
        State: <strong>{run?.state ?? 'none'}</strong> | Stream:{' '}
        <span data-testid="connection">{connection}</span> | Events: {feed.events.length}
      </p>
      {feed.gaps.length > 0 ? (
        <ul data-testid="gap-banner" style={{ background: '#ffe0e0', border: '1px solid #c00', padding: 8 }}>
          {feed.gaps.map((gap, index) => (
            <li key={`${gap.source}-${gap.to}-${index}`}>
              gap detected in {gap.source}: seq {gap.from} → {gap.to}
            </li>
          ))}
        </ul>
      ) : null}
      <section style={{ display: 'flex', gap: 24, alignItems: 'flex-start' }}>
        {(run?.entrants ?? []).map((entrant) => (
          <EntrantLane key={entrant.id} runId={run?.id ?? ''} entrant={entrant} feed={feed} />
        ))}
      </section>
      <h2>Run-level log</h2>
      <ul data-testid="run-log">
        {runLog.map((event) => (
          <li key={event.id}>
            <code>{event.type}</code> {describeEvent(event)}
          </li>
        ))}
      </ul>
      <h2>Raw event log</h2>
      <pre>{feed.events.map((event) => JSON.stringify(event)).join('\n')}</pre>
    </main>
  );
}

function EntrantLane({ runId, entrant, feed }: {
  runId: string;
  entrant: EntrantSummary;
  feed: FeedState;
}) {
  const [text, setText] = useState('');
  const steer = useMutation({
    mutationFn: async (steeringText: string) => fetchJson<{ accepted: boolean }>(
      `/runs/${runId}/entrants/${entrant.id}/steer`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: steeringText }),
      },
    ),
    onSuccess: () => setText(''),
  });
  const laneEvents = useMemo(
    () => eventsForSource(feed.events, entrant.id),
    [entrant.id, feed.events],
  );
  const laneGaps = useMemo(() => gapsForSource(feed.gaps, entrant.id), [entrant.id, feed.gaps]);

  return (
    <article style={{ width: '50%', border: '1px solid #999', padding: 8 }}>
      <h2>{entrant.id}</h2>
      <p>{entrant.harness} / {entrant.model} / <strong>{entrant.status}</strong> / flags {entrant.flags}</p>
      {laneGaps.length > 0 ? (
        <p data-testid={`lane-gap-${entrant.id}`} style={{ color: '#c00' }}>
          gap detected in {entrant.id}: {laneGaps.map((gap) => `${gap.from}→${gap.to}`).join(', ')}
        </p>
      ) : null}
      <input value={text} onChange={(event) => setText(event.target.value)} placeholder="steer text" />
      <button disabled={text.length === 0 || steer.isPending} onClick={() => steer.mutate(text)}>Steer</button>
      {steer.error instanceof Error ? <p>{steer.error.message}</p> : null}
      <ul data-testid={`lane-${entrant.id}`}>
        {laneEvents.map((event) => (
          <li key={event.id}>
            <code>{event.type}</code> {describeEvent(event)}
          </li>
        ))}
      </ul>
    </article>
  );
}

async function fetchJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  if (!response.ok) {
    throw new Error(`Request failed with status ${response.status}`);
  }
  return response.json() as Promise<T>;
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </React.StrictMode>,
);
