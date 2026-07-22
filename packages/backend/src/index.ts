import { createServer } from './server.js';

const port = Number(process.env.PORT ?? 4177);
const { app } = createServer({ logger: true });

await app.listen({ port, host: '0.0.0.0' });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void app.close().finally(() => process.exit(0));
  });
}
