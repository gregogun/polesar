/** What an agent is given about the ticket it works or judges. */
export type TicketSpec = { number: number; title: string; body: string };

/** Why the implementer is sent back to a branch it already committed to. */
export type Feedback =
  /** The blocking findings from the last review. */
  | { review: Finding[] }
  /** The gate's summary of what still fails after a free rerun. */
  | { gate: string };

export type ImplementInput = {
  ticket: TicketSpec;
  branch: string;
  /** Absent on the first run. */
  feedback?: Feedback;
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
};

/** A repo doc the reviewer judges against, read from the main checkout so the branch can't rewrite it. */
export type StandardsDoc = { path: string; content: string };

/** Everything the reviewer sees: the result, never the story about it. */
export type ReviewInput = {
  ticket: TicketSpec;
  diff: string;
  evidence: string;
  standards: StandardsDoc[];
  /** Blocking findings this change was meant to fix, to be raised again if it doesn't; empty otherwise. */
  addressing: Finding[];
};

export type Finding = {
  /** Spec mismatch or correctness; style and suggestions aren't blocking. */
  blocking: boolean;
  summary: string;
};

export type Review = { findings: Finding[] };

/** Runs agents in a sandbox. polesar's core reaches agents only through this port. */
export type Executor = {
  /** Runs the implementer on `branch`. It commits there and never merges. */
  implement(input: ImplementInput): Promise<Implementation>;
  /** Runs the read-only reviewer. */
  review(input: ReviewInput): Promise<Review>;
};
