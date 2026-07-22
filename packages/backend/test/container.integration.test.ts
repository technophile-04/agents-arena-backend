import { spawn } from 'node:child_process';
import { access, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import Docker from 'dockerode';
import { describe, expect, it } from 'vitest';

import { DockerEntrantContainer } from '../src/runtime/container.js';

const dockerIt = process.env.ARENA_DOCKER === '1' ? it : it.skip;
const buildScript = fileURLToPath(new URL('../../../docker/build.sh', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

async function run(command: string, args: string[]): Promise<void> {
  const child = spawn(command, args, { cwd: repoRoot, stdio: 'inherit' });
  const code = await new Promise<number | null>((resolve) => child.once('close', resolve));
  if (code !== 0) throw new Error(`${command} exited with code ${String(code)}`);
}

async function ensureImage(docker: Docker): Promise<void> {
  try {
    await docker.getImage('arena-entrant:dev').inspect();
  } catch {
    await run('sh', [buildScript]);
  }
}

async function collect(container: DockerEntrantContainer, argv: string[]): Promise<string[]> {
  const execution = await container.exec(argv);
  const lines: string[] = [];
  for await (const output of execution) lines.push(output.line);
  expect(await execution.exit).toBe(0);
  return lines;
}

describe('DockerEntrantContainer', () => {
  dockerIt('streams preflight commands and removes its resources', async () => {
    const docker = new Docker();
    await ensureImage(docker);
    const credentialDir = await mkdtemp(join(tmpdir(), 'arena-integration-'));
    const runId = `integration-${Date.now()}`;
    const entrantId = 'runtime-1';
    const container = await DockerEntrantContainer.create({
      runId,
      entrantId,
      credentialDir,
      credentialTarget: '/creds/test',
    }, docker);

    expect((await collect(container, ['forge', '--version'])).join('\n')).toContain('forge');
    expect((await collect(container, ['cast', '--version'])).join('\n')).toContain('cast');
    await container.teardown();

    const stale = await docker.listContainers({
      all: true,
      filters: { label: [`arena.runId=${runId}`, `arena.entrantId=${entrantId}`] },
    });
    expect(stale).toEqual([]);
    await expect(access(credentialDir)).rejects.toThrow();
  }, 180_000);
});
