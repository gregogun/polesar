import { readFileSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import {
  ExecutorError,
  type Executor,
  type ImplementInput,
  type Implementation,
  type RateLimited,
  type Review,
  type ReviewInput,
} from '../src/executor.ts';
import type { Gate, GateInput, GateResult } from '../src/gate.ts';
import type { Failed, LoopScript, Scripted } from './loop-script.ts';

/**
 * What the fakes remember: the branches the fake implementer has committed
 * to, shared with the fake gate, and how many calls each port has had per
 * ticket. Saved to a state file when there is one, so runs can carry on
 * where the last left off.
 */
type FakeState = {
  branches: Record<string, string[]>;
  calls: Record<'implement' | 'review' | 'gate', Record<number, number>>;
};

class Store {
  readonly state: FakeState;
  readonly #file: string | undefined;

  constructor(file: string | undefined) {
    this.#file = file;
    let saved: FakeState | undefined;
    try {
      if (file) saved = JSON.parse(readFileSync(file, 'utf8')) as FakeState;
    } catch {
      // No state yet: this is the first run.
    }
    this.state = saved ?? {
      branches: {},
      calls: { implement: {}, review: {}, gate: {} },
    };
  }

  save() {
    if (this.#file) writeFileSync(this.#file, JSON.stringify(this.state));
  }
}

/**
 * Counts calls per ticket and picks that call's scripted behaviour: a list is
 * used one entry per call, its last entry repeating; a single entry is used
 * for every call.
 */
class Sequence<T> {
  readonly #script: Record<number, Scripted<T>> | undefined;
  readonly #calls: Record<number, number>;
  readonly #store: Store;

  constructor(
    script: Record<number, Scripted<T>> | undefined,
    store: Store,
    port: keyof FakeState['calls']
  ) {
    this.#script = script;
    this.#calls = store.state.calls[port];
    this.#store = store;
  }

  /** This call's scripted behaviour for `ticket`, and which call it is (1 for the first). */
  next(ticket: number): { scripted: Partial<T> | undefined; call: number } {
    const call = (this.#calls[ticket] ?? 0) + 1;
    this.#calls[ticket] = call;
    this.#store.save();
    const entry = this.#script?.[ticket];
    const scripted = Array.isArray(entry)
      ? entry[Math.min(call, entry.length) - 1]
      : entry;
    return { scripted, call };
  }
}

const rateLimit = (
  scripted: Partial<RateLimited> | undefined
): RateLimited | undefined =>
  scripted?.rateLimited && { rateLimited: scripted.rateLimited };

/** Throws as the real executor does when a run fails in a way it can't explain. */
const failIfScripted = (scripted: Partial<Failed> | undefined) => {
  if (scripted?.failed !== undefined) {
    throw new ExecutorError(scripted.failed);
  }
};

/**
 * A scripted implementer and reviewer. Unscripted tickets succeed: each
 * implementer run adds a commit (c7, then c7.2, c7.3…) with a diff, no
 * changed files and an evidence file, and the reviewer finds nothing. A run
 * scripted as rate limited or failed does nothing else.
 */
class FakeExecutor implements Executor {
  readonly #implement: Sequence<Implementation & RateLimited & Failed>;
  readonly #review: Sequence<Review & RateLimited & Failed>;
  readonly #store: Store;

  constructor(script: LoopScript, store: Store) {
    this.#implement = new Sequence(script.implement, store, 'implement');
    this.#review = new Sequence(script.review, store, 'review');
    this.#store = store;
  }

  async implement({
    ticket,
    branch,
  }: ImplementInput): Promise<Implementation | RateLimited> {
    const { number } = ticket;
    const { scripted, call } = this.#implement.next(number);
    failIfScripted(scripted);
    const limited = rateLimit(scripted);
    if (limited) return limited;
    const suffix = call === 1 ? '' : `.${call}`;
    const { branches } = this.#store.state;
    const { failed: _, ...outcome } = scripted ?? {};
    const implementation = {
      commits: [...(branches[branch] ?? []), `c${number}${suffix}`],
      diff: `diff for #${number}${suffix}`,
      changes: [],
      evidence: `evidence for #${number}`,
      transcript: `implementer transcript for #${number}`,
      turns: 1,
      capHit: false,
      ...outcome,
    };
    branches[branch] = implementation.commits;
    this.#store.save();
    return implementation;
  }

  async review({ ticket }: ReviewInput): Promise<Review | RateLimited> {
    const { scripted } = this.#review.next(ticket.number);
    failIfScripted(scripted);
    return (
      rateLimit(scripted) ?? {
        findings: [],
        turns: 1,
        capHit: false,
        ...scripted,
      }
    );
  }
}

/**
 * A scripted gate: green on the branch's commits unless the script says
 * otherwise. Checks and reruns share one sequence per ticket.
 */
class FakeGate implements Gate {
  readonly #results: Sequence<GateResult>;
  readonly #store: Store;

  constructor(script: LoopScript, store: Store) {
    this.#results = new Sequence(script.gate, store, 'gate');
    this.#store = store;
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
      commits: this.#store.state.branches[branch] ?? [],
      ...this.#results.next(ticket).scripted,
    });
  }
}

/**
 * A fake executor and gate scripted by a JSON loop script, for running the CLI
 * end to end. With a state file, they pick up where the last run's left off.
 */
export const loadFakeLoop = async (file: string, stateFile?: string) => {
  const script = JSON.parse(await readFile(file, 'utf8')) as LoopScript;
  const store = new Store(stateFile);
  return {
    executor: new FakeExecutor(script, store),
    gate: new FakeGate(script, store),
  };
};
