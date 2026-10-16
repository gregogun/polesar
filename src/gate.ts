export type GateInput = {
  ticket: { number: number; title: string };
  branch: string;
  /** The PR body, rendered by polesar. */
  prBody: string;
};

export type GateResult = {
  green: boolean;
  /** One line on what ran and, when red, what failed. */
  summary: string;
  /** The branch's commits the checks ran on, oldest first. */
  commits: string[];
};

/** Runs the expensive checks for a branch and merges it. polesar's core reaches the gate only through this port. */
export type Gate = {
  check(input: GateInput): Promise<GateResult>;
  /** Reruns the checks on the branch as it is, with no agent and no code change. */
  rerun(input: { ticket: number; branch: string }): Promise<GateResult>;
  /** Merges `branch` into main. Called only once the loop's merge condition holds. */
  merge(input: { ticket: number; branch: string }): Promise<void>;
};

/**
 * The gate couldn't do what the loop asked (push, open a PR, read checks,
 * merge); the message says what to do next. The loop stops without judging
 * the ticket.
 */
export class GateError extends Error {
  override name = 'GateError';
}
