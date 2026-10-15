/**
 * A run paused by a rate limit, saved in polesar's home so the next run in the
 * same repo picks its ticket up where it stopped, retries and turns intact.
 */
import { rm } from 'node:fs/promises';
import path from 'node:path';
import type { RunSpend } from './budget.ts';
import { ConfigError, isRecord } from './config.ts';
import type { Feedback, Finding } from './executor.ts';
import type { ProtectedChange } from './protected-paths.ts';
import type { Step } from './templates.ts';
import { readJsonIfPresent, writeJsonAtomically } from './usage.ts';

/** Where a ticket's work stands: everything the loop needs to carry on with it. */
export type TicketState = {
  trail: Step[];
  reviewed: string[];
  /** Red gate summaries that turned green on a rerun with no code change: the gate's fault, not the agent's. */
  flaky: string[];
  /** Every review's non-blocking findings: posted and logged, never blocking. */
  nonBlocking: string[];
  /** The latest evidence file there was, for the trail even if a retry dropped it. */
  lastEvidence: string | null;
  /** Protected files the branch, as it last stood, modified or deleted: named on any escalation. */
  touched: ProtectedChange[];
  /** Why the implementer is going back to the branch; absent before its first run. */
  feedback?: Feedback;
  addressing: Finding[];
  reviewRetries: number;
  ciRetries: number;
  /** Agent turns spent on the ticket so far, against its per-ticket cap. */
  turns: number;
  /** The next agent run: the implementer, or a review of what it last committed. */
  next:
    | { step: 'implement' }
    | { step: 'review'; committed: string[]; diff: string; evidence: string };
};

export type PausedRun = {
  ticket: number;
  /** ISO time the rate limit resets; the run can't resume before. */
  until: string;
  state: TicketState;
  /** The paused run's spend, so resuming doesn't hand it a fresh run cap. */
  spend: RunSpend;
};

const isPausedRun = (value: unknown): value is PausedRun =>
  isRecord(value) &&
  typeof value.ticket === 'number' &&
  typeof value.until === 'string' &&
  isRecord(value.state) &&
  isRecord(value.spend);

/** The paused run for the repo at `cwd`, if there is one. */
export class PausedRuns {
  readonly #file: string;

  constructor(home: string, cwd: string) {
    this.#file = path.join(
      home,
      'paused',
      `${cwd.replaceAll(/[^A-Za-z0-9]/g, '-')}.json`
    );
  }

  async load(): Promise<PausedRun | undefined> {
    const stored = await readJsonIfPresent(this.#file);
    if (stored === undefined) return undefined;
    if (!isPausedRun(stored)) {
      // Dropping it would quietly restart the ticket with its retries back.
      throw new ConfigError(
        `${this.#file} can't be read as a paused run. Fix it, or delete it to start the paused ticket afresh.`
      );
    }
    return stored;
  }

  save(run: PausedRun): Promise<void> {
    return writeJsonAtomically(this.#file, run);
  }

  clear(): Promise<void> {
    return rm(this.#file, { force: true });
  }
}
