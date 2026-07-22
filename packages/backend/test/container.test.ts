import { PassThrough, type Readable, type Writable } from 'node:stream';

import Docker from 'dockerode';
import { describe, expect, it, vi } from 'vitest';

import { DockerEntrantContainer } from '../src/runtime/container.js';

interface FakeWaitResult {
  StatusCode: number;
}

class FakeDocker {
  readonly attachment = new PassThrough();
  readonly runnerOutput = new PassThrough();
  readonly runnerError = new PassThrough();
  readonly network = { remove: vi.fn(async () => undefined) };
  readonly container;
  readonly createNetwork = vi.fn(async () => this.network);
  readonly listContainers = vi.fn(async () => []);
  readonly listNetworks = vi.fn(async () => []);

  private resolveWait!: (result: FakeWaitResult) => void;
  private readonly waitResult = new Promise<FakeWaitResult>((resolveWait) => {
    this.resolveWait = resolveWait;
  });

  constructor(private readonly onStart: (docker: FakeDocker) => void = (docker) => docker.send({ ev: 'ready' })) {
    this.container = {
      attach: vi.fn(async () => this.attachment),
      start: vi.fn(async () => this.onStart(this)),
      wait: vi.fn(async () => this.waitResult),
      stop: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
      modem: {
        demuxStream: vi.fn((_attachment: Readable, output: Writable, error: Writable) => {
          this.runnerOutput.pipe(output);
          this.runnerError.pipe(error);
        }),
      },
    };
  }

  readonly createContainer = vi.fn(async () => this.container);

  send(message: object): void {
    this.runnerOutput.write(`${JSON.stringify(message)}\n`);
  }

  die(code: number): void {
    this.resolveWait({ StatusCode: code });
    this.runnerOutput.end();
    this.runnerError.end();
    this.attachment.destroy();
  }

  failAttachment(error: Error): void {
    this.attachment.destroy(error);
  }
}

async function createContainer(docker: FakeDocker): Promise<DockerEntrantContainer> {
  return DockerEntrantContainer.create({
    runId: 'runtime-unit',
    entrantId: 'entrant-1',
    readyTimeoutMs: 100,
  }, docker as unknown as Docker);
}

async function within<T>(promise: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Promise stayed pending after container death')), 100);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

describe('DockerEntrantContainer lifecycle', () => {
  it('rejects readiness when the container dies before the ready event', async () => {
    const docker = new FakeDocker((startedDocker) => startedDocker.die(137));

    await expect(createContainer(docker)).rejects.toThrow('Container exited with code 137');
  });

  it('rejects an in-flight execution and its line iterator when the container dies', async () => {
    const docker = new FakeDocker();
    const container = await createContainer(docker);
    const execution = await container.exec(['node', '-e', 'setTimeout(() => {}, 30_000)']);
    const nextLine = execution[Symbol.asyncIterator]().next();

    docker.die(137);

    await expect(within(execution.exit)).rejects.toThrow('Container exited with code 137');
    await expect(within(nextLine)).rejects.toThrow('Container exited with code 137');
  });

  it('rejects an in-flight execution when the attachment errors before container wait settles', async () => {
    const docker = new FakeDocker();
    const container = await createContainer(docker);
    const execution = await container.exec(['node', '-e', 'setTimeout(() => {}, 30_000)']);

    docker.failAttachment(new Error('socket reset'));

    await expect(within(execution.exit)).rejects.toThrow(
      'Container attachment stream failed: socket reset',
    );
    await expect(within(execution[Symbol.asyncIterator]().next())).rejects.toThrow(
      'Container attachment stream failed: socket reset',
    );
  });

  it('keeps a clean JSON exit clean when the container closes afterward', async () => {
    const docker = new FakeDocker();
    const container = await createContainer(docker);
    const execution = await container.exec(['node', '-e', 'process.exit(0)']);

    docker.send({ ev: 'exit', id: execution.id, code: 0 });
    expect(await within(execution.exit)).toBe(0);
    await expect(within(execution[Symbol.asyncIterator]().next())).resolves.toEqual({
      done: true,
      value: undefined,
    });

    docker.die(0);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(await execution.exit).toBe(0);
  });
});
