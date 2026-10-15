import { readFile } from 'node:fs/promises';
import type {
  Executor,
  ImplementInput,
  Implementation,
  Review,
  ReviewInput,
} from '../src/executor.ts';
import type { Gate, GateInput, GateResult } from '../src/gate.ts';
import type { LoopScript, Scripted } from './loop-script.ts';

/** The branches the fake implementer has committed to, shared with the fake gate. */
type Branches = Map<string, string[]>;

/**
 * Counts calls per ticket and picks that call's scripted behaviour: a list is
 * used one entry per call, its last entry repeating; a single entry is used
 * for every call.
 */
class Sequence<T> {
  readonly #script: Record<number, Scripted<T>> | undefined;
  readonly #calls = new Map<number, number>();

  constructor(script: Record<number, Scripted<T>> | undefined) {
    this.#script = script;
  }

  /** This call's scripted behaviour for `ticket`, and which call it is (1 for the first). */
  next(ticket: number): { scripted: Partial<T> | undefined; call: number } {
    const call = (this.#calls.get(ticket) ?? 0) + 1;
    this.#calls.set(ticket, call);
    const entry = this.#script?.[ticket];
    const scripted = Array.isArray(entry)
      ? entry[Math.min(call, entry.length) - 1]
      : entry;
    return { scripted, call };
  }
}

/**
 * A scripted implementer and reviewer. Unscripted tickets succeed: each
 * implementer run adds a commit (c7, then c7.2, c7.3…) with a diff, no
 * changed files and an evidence file, and the reviewer finds nothing.
 */
class FakeExecutor implements Executor {
  readonly #implement: Sequence<Implementation>;
  readonly #review: Sequence<Review>;
  readonly #branches: Branches;

  constructor(script: LoopScript, branches: Branches) {
    this.#implement = new Sequence(script.implement);
    this.#review = new Sequence(script.review);
    this.#branches = branches;
  }

  implement({ ticket, branch }: ImplementInput): Promise<Implementation> {
    const { number } = ticket;
    const { scripted, call } = this.#implement.next(number);
    const suffix = call === 1 ? '' : `.${call}`;
    const implementation = {
      commits: [...(this.#branches.get(branch) ?? []), `c${number}${suffix}`],
      diff: `diff for #${number}${suffix}`,
      changes: [],
      evidence: `evidence for #${number}`,
      transcript: `implementer transcript for #${number}`,
      ...scripted,
    };
    this.#branches.set(branch, implementation.commits);
    return Promise.resolve(implementation);
  }

  review({ ticket }: ReviewInput): Promise<Review> {
    return Promise.resolve({
      findings: [],
      ...this.#review.next(ticket.number).scripted,
    });
  }
}

/**
 * A scripted gate: green on the branch's commits unless the script says
 * otherwise. Checks and reruns share one sequence per ticket.
 */
class FakeGate implements Gate {
  readonly #results: Sequence<GateResult>;
  readonly #branches: Branches;

  constructor(script: LoopScript, branches: Branches) {
    this.#results = new Sequence(script.gate);
    this.#branches = branches;
  }

  check({ ticket, branch }: GateInput): Promise<GateResult> {
    return this.#result(ticket.number, branch);
  }

  rerun({ ticket, branch }: { ticket: number; branch: string }) {
    return this.#result(ticket, branch);
  }

  merge(): Promise<void> {
    return Promise.resolve();
  }

  #result(ticket: number, branch: string): Promise<GateResult> {
    return Promise.resolve({
      green: true,
      summary: 'all checks passed',
      commits: this.#branches.get(branch) ?? [],
      ...this.#results.next(ticket).scripted,
    });
  }
}

/** A fake executor and gate scripted by a JSON loop script, for running the CLI end to end. */
export const loadFakeLoop = async (file: string) => {
  const script = JSON.parse(await readFile(file, 'utf8')) as LoopScript;
  const branches: Branches = new Map();
  return {
    executor: new FakeExecutor(script, branches),
    gate: new FakeGate(script, branches),
  };
};
