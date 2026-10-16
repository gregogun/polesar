/** What an agent is given about the ticket it works or judges. */
export type TicketSpec = { number: number; title: string; body: string };

/** Why the implementer is sent back to a branch it already committed to. */
export type Feedback =
  /** The blocking findings from the last review. */
  | { review: Finding[] }
  /** The gate's summary of what still fails after a free rerun. */
  | { gate: string };

/** How hard Claude Code thinks (its --effort levels). */
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORTS)[number];

export type ImplementInput = {
  ticket: TicketSpec;
  branch: string;
  /** Absent on the first run. */
  feedback?: Feedback;
  /** The ticket's model:<name> label; absent for the executor's default. */
  model?: string;
  /** The ticket's effort:<level> label; absent for the executor's default. */
  effort?: Effort;
  /** The turns the ticket has left under its per-ticket cap; the agent stops there. */
  maxTurns: number;
};

/** A file a branch changes against main. A rename is its old path deleted and its new path added. */
export type FileChange = {
  path: string;
  change: 'added' | 'modified' | 'deleted';
};

export type Implementation = {
  /** The commits on the branch, oldest first. */
  commits: string[];
  /**
   * The change this run made: against main on the first run, against where the
   * branch stood before on a retry, so a review sees only what it hasn't seen.
   */
  diff: string;
  /** Every file the branch changes against main, whatever run changed it. */
  changes: FileChange[];
  /** The evidence file's contents (what was run and observed); null when there is none. */
  evidence: string | null;
  /** The implementer's session, kept for telemetry. Never shown to the reviewer. */
  transcript: string;
} & Turns;

/** What an agent run cost against the per-ticket cap. */
type Turns = {
  /** Turns the run took. */
  turns: number;
  /** It stopped at `maxTurns` before finishing, so its result can't be trusted. */
  capHit: boolean;
};

/** A repo doc the reviewer judges against, read from the main checkout so the branch can't rewrite it. */
export type StandardsDoc = { path: string; content: string };

/** Everything the reviewer sees: the result, never the story about it. */
export type ReviewInput = {
  ticket: TicketSpec;
  /** The branch under review, which the reviewer reads but never writes. */
  branch: string;
  diff: string;
  evidence: string;
  standards: StandardsDoc[];
  /** Blocking findings this change was meant to fix, to be raised again if it doesn't; empty otherwise. */
  addressing: Finding[];
  /** The turns the ticket has left under its per-ticket cap; the agent stops there. */
  maxTurns: number;
};

export type Finding = {
  /** Spec mismatch or correctness; style and suggestions aren't blocking. */
  blocking: boolean;
  summary: string;
};

export type Review = {
  findings: Finding[];
  /** The reviewer changed the branch or its working tree; the executor discarded what it did, but its findings can't be trusted. */
  wroteToBranch?: boolean;
} & Turns;

/**
 * The plan's rate limit cut an agent run short. Whatever it did is redone
 * once the limit resets: it costs the ticket no retry and no turns.
 */
export type RateLimited = {
  rateLimited: {
    /** ISO time the limit resets. */
    resetsAt: string;
  };
};

/** Runs agents in a sandbox. polesar's core reaches agents only through this port. */
export type Executor = {
  /** Runs the implementer on `branch`. It commits there and never merges. */
  implement(input: ImplementInput): Promise<Implementation | RateLimited>;
  /** Runs the read-only reviewer on `branch`. */
  review(input: ReviewInput): Promise<Review | RateLimited>;
  /** Releases whatever the runs held (sandboxes), once the loop is done with them. */
  close?(): Promise<void>;
};

/**
 * An agent run failed in a way polesar can't explain (the sandbox wouldn't
 * start, the agent crashed). The loop stops without judging the ticket.
 */
export class ExecutorError extends Error {
  override name = 'ExecutorError';
}
