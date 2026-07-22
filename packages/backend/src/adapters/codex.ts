import { chmod, copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import type { EventJournal } from '../journal.js';
import type { EntrantContainer } from '../runtime/container.js';
import { CodexEventParser } from './codex-parser.js';
import {
  HarnessEntrantDriver,
  type HarnessDriverOptions,
} from './harness-driver.js';
import type { EntrantRecord, RunRecord } from './types.js';

export interface CodexDriverOptions extends HarnessDriverOptions {
  authPath?: string;
}

export class CodexDriver extends HarnessEntrantDriver {
  private readonly authPath: string;
  private readonly parsers = new Map<string, CodexEventParser>();

  constructor(journal: EventJournal, options: CodexDriverOptions = {}) {
    super(journal, options);
    this.authPath = options.authPath ?? join(homedir(), '.codex', 'auth.json');
  }

  protected harnessName(): string {
    return 'codex';
  }

  protected assertHarness(entrant: EntrantRecord): void {
    if (entrant.harness !== 'codex') {
      throw new Error(`CodexDriver cannot run harness ${entrant.harness}`);
    }
  }

  protected async createContainer(run: RunRecord, entrant: EntrantRecord): Promise<EntrantContainer> {
    const credentialDir = await createCredentialDir('codex');
    try {
      await copyFile(this.authPath, join(credentialDir, 'auth.json'));
      await writeFile(
        join(credentialDir, 'config.toml'),
        `model = ${tomlString(entrant.model)}\n`,
        { mode: 0o644 },
      );
      return await this.containerFactory({
        runId: run.id,
        entrantId: entrant.id,
        credentialDir,
        credentialTarget: '/creds/codex',
        env: { CODEX_HOME: '/creds/codex' },
      });
    } catch (error) {
      await rm(credentialDir, { recursive: true, force: true });
      throw error;
    }
  }

  protected versionArgv(): string[] {
    return ['codex', '--version'];
  }

  protected startArgv(_entrant: EntrantRecord, prompt: string): string[] {
    return [
      'codex',
      'exec',
      '--json',
      '--dangerously-bypass-approvals-and-sandbox',
      '--skip-git-repo-check',
      '-C',
      '/work',
      prompt,
    ];
  }

  protected resumeArgv(_entrant: EntrantRecord, sessionId: string, text: string): string[] {
    // -C is a global option: it must precede the `resume` subcommand or the CLI
    // rejects it with "unexpected argument '-C'" and the steer never runs.
    return [
      'codex',
      'exec',
      '-C',
      '/work',
      'resume',
      sessionId,
      '--json',
      '--dangerously-bypass-approvals-and-sandbox',
      '--skip-git-repo-check',
      text,
    ];
  }

  protected parseLine(entrantId: string, line: string) {
    let parser = this.parsers.get(entrantId);
    if (parser === undefined) {
      parser = new CodexEventParser(entrantId, this.logger);
      this.parsers.set(entrantId, parser);
    }
    return parser.parse(line);
  }

  protected validateResumeSession(): boolean {
    return true;
  }
}

async function createCredentialDir(harness: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), `arena-${harness}-`));
  await chmod(directory, 0o755);
  return directory;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}
