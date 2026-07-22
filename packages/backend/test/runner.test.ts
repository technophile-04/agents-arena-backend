import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createInterface, type Interface } from 'node:readline';

import { afterEach, describe, expect, it } from 'vitest';

const runnerPath = fileURLToPath(new URL('../../../docker/runner.mjs', import.meta.url));
const children = new Set<ChildProcessWithoutNullStreams>();

afterEach(() => {
  for (const child of children) child.kill('SIGKILL');
  children.clear();
});

function startRunner(): {
  child: ChildProcessWithoutNullStreams;
  lines: AsyncIterator<string>;
  reader: Interface;
} {
  const child = spawn(process.execPath, [runnerPath], { stdio: ['pipe', 'pipe', 'pipe'] });
  children.add(child);
  const reader = createInterface({ input: child.stdout, crlfDelay: Infinity });
  return { child, lines: reader[Symbol.asyncIterator](), reader };
}

async function nextMessage(lines: AsyncIterator<string>): Promise<Record<string, unknown>> {
  const result = await Promise.race([
    lines.next(),
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error('Timed out waiting for runner output')), 2_000);
    }),
  ]);
  if (result.done) throw new Error('Runner stdout closed');
  return JSON.parse(result.value) as Record<string, unknown>;
}

async function stopRunner(
  child: ChildProcessWithoutNullStreams,
  reader: Interface,
): Promise<void> {
  child.stdin.write(`${JSON.stringify({ cmd: 'shutdown' })}\n`);
  await new Promise<void>((resolve) => child.once('close', () => resolve()));
  reader.close();
  children.delete(child);
}

describe('in-container runner protocol', () => {
  it('streams command lines and an exit event', async () => {
    const { child, lines, reader } = startRunner();
    expect(await nextMessage(lines)).toEqual({ ev: 'ready' });

    child.stdin.write(`${JSON.stringify({
      cmd: 'exec',
      id: 'echo-1',
      argv: [process.execPath, '-e', "console.log('hello arena')"],
    })}\n`);

    expect(await nextMessage(lines)).toEqual({
      ev: 'line',
      id: 'echo-1',
      stream: 'out',
      line: 'hello arena',
    });
    expect(await nextMessage(lines)).toEqual({ ev: 'exit', id: 'echo-1', code: 0 });
    await stopRunner(child, reader);
  });

  it('rejects an overlapping exec and kills the active process group', async () => {
    const { child, lines, reader } = startRunner();
    await nextMessage(lines);

    child.stdin.write(`${JSON.stringify({
      cmd: 'exec',
      id: 'slow',
      argv: [process.execPath, '-e', 'setTimeout(() => {}, 30_000)'],
    })}\n`);
    child.stdin.write(`${JSON.stringify({
      cmd: 'exec',
      id: 'overlap',
      argv: [process.execPath, '-e', 'process.exit(0)'],
    })}\n`);

    expect(await nextMessage(lines)).toEqual({ ev: 'error', msg: 'Exec slow is still running' });
    child.stdin.write(`${JSON.stringify({ cmd: 'kill', id: 'slow' })}\n`);
    expect(await nextMessage(lines)).toMatchObject({ ev: 'exit', id: 'slow' });
    await stopRunner(child, reader);
  });
});
