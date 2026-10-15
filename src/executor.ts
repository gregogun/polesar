/** What an agent is given about the ticket it works or judges. */
export type TicketSpec = { number: number; title: string; body: string };

type ImplementInput = { ticket: TicketSpec; branch: string };

export type Implementation = {
  /** The commits on the branch, oldest first. */
  commits: string[];
  /** The branch's change against main. */
  diff: string;
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
