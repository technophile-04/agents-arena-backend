import type { ArenaEvent } from '../contract.js';

export type ParsedArenaEvent = ArenaEvent extends infer Event
  ? Event extends ArenaEvent
    ? Pick<Event, 'type' | 'payload'>
    : never
  : never;

export interface ParsedHarnessLine {
  events: ParsedArenaEvent[];
  sessionId?: string;
  turnEnded?: boolean;
}

export interface ParserLogger {
  info(message: string): void;
  warn(message: string): void;
}
