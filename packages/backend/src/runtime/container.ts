import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';

import Docker from 'dockerode';

export interface RuntimeLine {
  stream: 'out' | 'err';
  line: string;
}

export interface RuntimeExecution extends AsyncIterable<RuntimeLine> {
  readonly id: string;
  readonly exit: Promise<number | null>;
  kill(): Promise<void>;
}

export interface ContainerOptions {
  runId: string;
  entrantId: string;
  image?: string;
  env?: Record<string, string>;
  credentialDir?: string;
  credentialTarget?: string;
  readyTimeoutMs?: number;
}

export interface EntrantContainer {
  exec(argv: string[], env?: Record<string, string>): Promise<RuntimeExecution>;
  teardown(): Promise<void>;
}

export type ContainerFactory = (options: ContainerOptions) => Promise<EntrantContainer>;

interface RunnerLineMessage {
  ev: 'line';
  id: string;
  stream: 'out' | 'err';
  line: string;
}

interface RunnerExitMessage {
  ev: 'exit';
  id: string;
  code: number | null;
}

interface RunnerReadyMessage {
  ev: 'ready';
}

interface RunnerErrorMessage {
  ev: 'error';
  msg: string;
}

type RunnerMessage = RunnerLineMessage | RunnerExitMessage | RunnerReadyMessage | RunnerErrorMessage;

class AsyncLineQueue implements AsyncIterable<RuntimeLine> {
  private readonly values: RuntimeLine[] = [];
  private readonly waiters: Array<{
    resolve: (result: IteratorResult<RuntimeLine>) => void;
    reject: (error: Error) => void;
  }> = [];
  private ended = false;
  private failure: Error | undefined;

  push(value: RuntimeLine): void {
    const waiter = this.waiters.shift();
    if (waiter !== undefined) {
      waiter.resolve({ done: false, value });
    } else {
      this.values.push(value);
    }
  }

  close(): void {
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter.resolve({ done: true, value: undefined });
    }
  }

  fail(error: Error): void {
    this.failure = error;
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }

  [Symbol.asyncIterator](): AsyncIterator<RuntimeLine> {
    return {
      next: async () => {
        const value = this.values.shift();
        if (value !== undefined) return { done: false, value };
        if (this.failure !== undefined) throw this.failure;
        if (this.ended) return { done: true, value: undefined };
        return new Promise<IteratorResult<RuntimeLine>>((resolveWaiter, rejectWaiter) => {
          this.waiters.push({ resolve: resolveWaiter, reject: rejectWaiter });
        });
      },
    };
  }
}

class DockerRuntimeExecution implements RuntimeExecution {
  readonly exit: Promise<number | null>;
  readonly lines = new AsyncLineQueue();
  private resolveExit!: (code: number | null) => void;
  private rejectExit!: (error: Error) => void;

  constructor(
    readonly id: string,
    private readonly sendKill: (id: string) => Promise<void>,
  ) {
    this.exit = new Promise<number | null>((resolveExit, rejectExit) => {
      this.resolveExit = resolveExit;
      this.rejectExit = rejectExit;
    });
    // Guard consumer: on the error path a caller catches the iterator rejection and
    // never awaits exit, so its rejection would surface as an unhandled rejection and
    // crash the process. This no-op marks it handled; real awaiters still see the throw.
    void this.exit.catch(() => undefined);
  }

  [Symbol.asyncIterator](): AsyncIterator<RuntimeLine> {
    return this.lines[Symbol.asyncIterator]();
  }

  finish(code: number | null): void {
    this.lines.close();
    this.resolveExit(code);
  }

  fail(error: Error): void {
    this.lines.fail(error);
    this.rejectExit(error);
  }

  async kill(): Promise<void> {
    await this.sendKill(this.id);
  }
}

export class DockerEntrantContainer implements EntrantContainer {
  private readonly executions = new Map<string, DockerRuntimeExecution>();
  private activeExecution: DockerRuntimeExecution | undefined;
  private readonly ready: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;
  private tornDown = false;

  private constructor(
    private readonly container: Docker.Container,
    private readonly network: Docker.Network,
    private readonly input: NodeJS.WritableStream,
    private readonly credentialDir: string | undefined,
    runnerOutput: NodeJS.ReadableStream,
    runnerError: NodeJS.ReadableStream,
  ) {
    this.ready = new Promise<void>((resolveReady, rejectReady) => {
      this.resolveReady = resolveReady;
      this.rejectReady = rejectReady;
    });

    const outputLines = createInterface({ input: runnerOutput, crlfDelay: Infinity });
    outputLines.on('line', (line) => this.receive(line));
    const errorLines = createInterface({ input: runnerError, crlfDelay: Infinity });
    errorLines.on('line', (line) => console.warn(`[arena runner stderr] ${line}`));
  }

  static async create(options: ContainerOptions, docker = new Docker()): Promise<DockerEntrantContainer> {
    await removeStaleResources(docker, options.runId, options.entrantId);

    const suffix = randomUUID().slice(0, 8);
    const networkName = safeDockerName(`arena-${options.runId}-${options.entrantId}-${suffix}`);
    const network = await docker.createNetwork({
      Name: networkName,
      Driver: 'bridge',
      Labels: {
        'arena.runId': options.runId,
        'arena.entrantId': options.entrantId,
      },
    });

    let container: Docker.Container | undefined;
    try {
      const binds = options.credentialDir === undefined
        ? []
        : [`${resolve(options.credentialDir)}:${options.credentialTarget ?? '/creds'}:rw`];

      container = await docker.createContainer({
        Image: options.image ?? 'arena-entrant:dev',
        name: safeDockerName(`arena-${options.runId}-${options.entrantId}`),
        Env: Object.entries(options.env ?? {}).map(([key, value]) => `${key}=${value}`),
        Labels: {
          'arena.runId': options.runId,
          'arena.entrantId': options.entrantId,
        },
        OpenStdin: true,
        StdinOnce: false,
        AttachStdin: true,
        AttachStdout: true,
        AttachStderr: true,
        Tty: false,
        WorkingDir: '/work',
        HostConfig: {
          AutoRemove: false,
          Binds: binds,
          NetworkMode: networkName,
          Init: true,
          ExtraHosts: ['host.docker.internal:host-gateway'],
          // hardening: no capabilities, no privilege escalation, bounded PIDs, memory, and CPU.
          // hardening: each entrant gets a private network and its own credential mount.
          // hardening: never mount the Docker socket and never run a privileged container.
          CapDrop: ['ALL'],
          SecurityOpt: ['no-new-privileges'],
          PidsLimit: 512,
          Memory: 2 * 1024 * 1024 * 1024,
          NanoCpus: 2_000_000_000,
          Privileged: false,
        },
      });

      const attachment = await container.attach({
        stream: true,
        stdin: true,
        stdout: true,
        stderr: true,
        hijack: true,
      });
      const runnerOutput = new PassThrough();
      const runnerError = new PassThrough();
      container.modem.demuxStream(attachment, runnerOutput, runnerError);
      const runtime = new DockerEntrantContainer(
        container,
        network,
        attachment,
        options.credentialDir,
        runnerOutput,
        runnerError,
      );
      await container.start();
      await runtime.waitUntilReady(options.readyTimeoutMs ?? 15_000);
      return runtime;
    } catch (error) {
      const failedContainer = container;
      if (failedContainer !== undefined) {
        await ignoreDockerError(() => failedContainer.remove({ force: true }));
      }
      await ignoreDockerError(() => network.remove());
      if (options.credentialDir !== undefined) await removeCredentialTempDir(options.credentialDir);
      throw error;
    }
  }

  async exec(argv: string[], env?: Record<string, string>): Promise<RuntimeExecution> {
    if (this.tornDown) throw new Error('Container is already torn down');
    if (this.activeExecution !== undefined) {
      throw new Error(`Exec ${this.activeExecution.id} is still running`);
    }
    if (argv.length === 0) throw new Error('argv must not be empty');

    const id = randomUUID();
    const execution = new DockerRuntimeExecution(id, async (executionId) => {
      await this.write({ cmd: 'kill', id: executionId });
    });
    this.executions.set(id, execution);
    this.activeExecution = execution;
    try {
      await this.write({ cmd: 'exec', id, argv, ...(env === undefined ? {} : { env }) });
    } catch (error) {
      this.executions.delete(id);
      this.activeExecution = undefined;
      execution.fail(asError(error));
      throw error;
    }
    return execution;
  }

  async teardown(): Promise<void> {
    if (this.tornDown) return;
    this.tornDown = true;

    if (this.activeExecution !== undefined) {
      await ignoreDockerError(() => this.activeExecution?.kill() ?? Promise.resolve());
    }
    await ignoreDockerError(() => this.write({ cmd: 'shutdown' }));
    await ignoreDockerError(() => this.container.stop({ t: 3 }));
    await ignoreDockerError(() => this.container.remove({ force: true }));
    await ignoreDockerError(() => this.network.remove());
    if (this.credentialDir !== undefined) await removeCredentialTempDir(this.credentialDir);
  }

  private receive(line: string): void {
    let message: RunnerMessage;
    try {
      message = JSON.parse(line) as RunnerMessage;
    } catch {
      console.warn(`[arena runner] malformed JSON: ${line}`);
      return;
    }

    if (message.ev === 'ready') {
      this.resolveReady();
      return;
    }
    if (message.ev === 'error') {
      const error = new Error(message.msg);
      if (this.activeExecution !== undefined) {
        this.activeExecution.fail(error);
        this.executions.delete(this.activeExecution.id);
        this.activeExecution = undefined;
      } else {
        this.rejectReady(error);
        console.warn(`[arena runner] ${message.msg}`);
      }
      return;
    }

    const execution = this.executions.get(message.id);
    if (execution === undefined) {
      console.warn(`[arena runner] event for unknown exec ${message.id}`);
      return;
    }
    if (message.ev === 'line') {
      execution.lines.push({ stream: message.stream, line: message.line });
      return;
    }

    execution.finish(message.code);
    this.executions.delete(message.id);
    if (this.activeExecution?.id === message.id) this.activeExecution = undefined;
  }

  private async waitUntilReady(timeoutMs: number): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.ready,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('Runner ready timeout')), timeoutMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private async write(message: object): Promise<void> {
    const line = `${JSON.stringify(message)}\n`;
    await new Promise<void>((resolveWrite, rejectWrite) => {
      this.input.write(line, (error?: Error | null) => {
        if (error === undefined || error === null) resolveWrite();
        else rejectWrite(error);
      });
    });
  }
}

export const createDockerContainer: ContainerFactory = (options) => DockerEntrantContainer.create(options);

async function removeStaleResources(docker: Docker, runId: string, entrantId: string): Promise<void> {
  const labels = [`arena.runId=${runId}`, `arena.entrantId=${entrantId}`];
  const staleContainers = await docker.listContainers({ all: true, filters: { label: labels } });
  await Promise.all(staleContainers.map(async ({ Id }) => {
    await ignoreDockerError(() => docker.getContainer(Id).remove({ force: true }));
  }));

  const staleNetworks = await docker.listNetworks({ filters: { label: labels } });
  await Promise.all(staleNetworks.map(async ({ Id }) => {
    if (Id !== undefined) await ignoreDockerError(() => docker.getNetwork(Id).remove());
  }));
}

async function removeCredentialTempDir(path: string): Promise<void> {
  const resolved = resolve(path);
  const tempRoot = `${resolve(tmpdir())}/`;
  if (!resolved.startsWith(tempRoot) || !basename(resolved).startsWith('arena-')) {
    throw new Error(`Refusing to remove non-arena credential directory: ${resolved}`);
  }
  await rm(resolved, { recursive: true, force: true });
}

async function ignoreDockerError(action: () => Promise<unknown>): Promise<void> {
  try {
    await action();
  } catch {
    // Cleanup is best effort. The daemon can report an object as already gone.
  }
}

function safeDockerName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 63);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
