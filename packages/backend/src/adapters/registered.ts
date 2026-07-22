import type { EventJournal } from '../journal.js';
import { DockerEntrantDriver } from './docker.js';
import { FakeDriver, type Schedule } from './fake.js';
import type { EntrantDriver, EntrantRecord, RunRecord } from './types.js';

export class RegisteredEntrantDriver implements EntrantDriver {
  private readonly fake: FakeDriver;
  private readonly docker: DockerEntrantDriver;

  constructor(journal: EventJournal, schedule?: Schedule) {
    this.fake = new FakeDriver(journal, schedule);
    this.docker = new DockerEntrantDriver(journal);
  }

  async prepare(run: RunRecord, entrant: EntrantRecord): Promise<void> {
    await this.driver(run).prepare(run, entrant);
  }

  async start(run: RunRecord, entrant: EntrantRecord, openingPrompt: string): Promise<void> {
    await this.driver(run).start(run, entrant, openingPrompt);
  }

  async steer(run: RunRecord, entrant: EntrantRecord, text: string): Promise<void> {
    await this.driver(run).steer(run, entrant, text);
  }

  async stop(run: RunRecord, entrant: EntrantRecord): Promise<void> {
    await this.driver(run).stop(run, entrant);
  }

  private driver(run: RunRecord): EntrantDriver {
    return run.preset === 'docker-duel' ? this.docker : this.fake;
  }
}
