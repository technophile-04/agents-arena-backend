import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type { ArenaEvent, EntrantSummary, RunSnapshot } from '../../../contract/arena-types';
import { projectSnapshot } from './project-snapshot';

const queryClient = new QueryClient();

function App() {
  const cache = useQueryClient();
  const [runId, setRunId] = useState<string | null>(null);
  const [events, setEvents] = useState<ArenaEvent[]>([]);
  const [connection, setConnection] = useState('disconnected');
  const lastId = useRef(0);
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
      lastId.current = 0;
      setEvents([]);
      setRunId(run.id);
      cache.setQueryData(['run', run.id], run);
    },
  });
  const run = snapshot.data ?? null;

  useEffect(() => {
    if (runId === null) return;
    const source = new EventSource(`/runs/${runId}/events`);
    source.onopen = () => setConnection(lastId.current === 0 ? 'connected' : 'reconnected, no gap');
    source.onerror = () => setConnection('reconnecting');
    source.onmessage = (message) => {
      const event = JSON.parse(message.data) as ArenaEvent;
      if (lastId.current > 0 && event.id !== lastId.current + 1) {
        setConnection(`gap or global-id skip: ${lastId.current} → ${event.id}`);
      }
      lastId.current = event.id;
      setEvents((current) => current.some(({ id }) => id === event.id) ? current : [...current, event]);
      cache.setQueryData<RunSnapshot>(['run', runId], (current) => projectSnapshot(current, event));
    };
    return () => source.close();
  }, [cache, runId]);

  return (
    <main>
      <h1>Agents Arena mock</h1>
      <button disabled={createRun.isPending} onClick={() => createRun.mutate()}>
        {createRun.isPending ? 'Creating…' : 'Create and start fake duel'}
      </button>
      {createRun.error instanceof Error ? <p>{createRun.error.message}</p> : null}
      <p>Run: {run?.id ?? 'none'}</p>
      <p>State: <strong>{run?.state ?? 'none'}</strong> | Stream: {connection}</p>
      <section style={{ display: 'flex', gap: 24, alignItems: 'flex-start' }}>
        {(run?.entrants ?? []).map((entrant) => (
          <EntrantLane key={entrant.id} runId={run?.id ?? ''} entrant={entrant} events={events} />
        ))}
      </section>
      <h2>Raw event log</h2>
      <pre>{events.map((event) => JSON.stringify(event)).join('\n')}</pre>
    </main>
  );
}

function EntrantLane({ runId, entrant, events }: {
  runId: string;
  entrant: EntrantSummary;
  events: ArenaEvent[];
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
    () => events.filter((event) => event.source === entrant.id && (
      event.type === 'agent.message' || event.type === 'tool.call' || event.type === 'tool.result'
    )),
    [entrant.id, events],
  );

  return (
    <article style={{ width: '50%' }}>
      <h2>{entrant.id}</h2>
      <p>{entrant.harness} / {entrant.model} / {entrant.status}</p>
      <input value={text} onChange={(event) => setText(event.target.value)} />
      <button disabled={text.length === 0 || steer.isPending} onClick={() => steer.mutate(text)}>Steer</button>
      {steer.error instanceof Error ? <p>{steer.error.message}</p> : null}
      <ul>
        {laneEvents.map((event) => <li key={event.id}><code>{event.type}</code> {JSON.stringify(event.payload)}</li>)}
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
