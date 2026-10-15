import { readFile } from 'node:fs/promises';
import type {
  Executor,
  Implementation,
  Review,
  ReviewInput,
  TicketSpec,
} from '../src/executor.ts';
import type { Gate, GateResult } from '../src/gate.ts';
import type { LoopScript } from './loop-script.ts';

/** The branches the fake implementer has committed to, shared with the fake gate. */
type Branches = Map<string, string[]>;

/**
 * A scripted implementer and reviewer. Unscripted tickets succeed: one commit,
 * a diff and an evidence file from the implementer, no findings from the reviewer.
 */
class FakeExecutor implements Executor {
  readonly #script: LoopScript;
  readonly #branches: Branches;

  constructor(script: LoopScript, branches: Branches) {
    this.#script = script;
    this.#branches = branches;
  }

  implement({
    ticket,
    branch,
  }: {
    ticket: TicketSpec;
    branch: string;
  }): Promise<Implementation> {
    const { number } = ticket;
    const implementation = {
      commits: [`c${number}`],
      diff: `diff for #${number}`,
      evidence: `evidence for #${number}`,
      transcript: `implementer transcript for #${number}`,
      ...this.#script.implement?.[number],
    };
    this.#branches.set(branch, implementation.commits);
    return Promise.resolve(implementation);
  }

  review({ ticket }: ReviewInput): Promise<Review> {
    return Promise.resolve({
      findings: [],
      ...this.#script.review?.[ticket.number],
    });
  }
}

/** A scripted gate: green on the branch's commits unless the script says otherwise. */
class FakeGate implements Gate {
  readonly #script: LoopScript;
  readonly #branches: Branches;

  constructor(script: LoopScript, branches: Branches) {
    this.#script = script;
    this.#branches = branches;
  }

  check({
    ticket,
    branch,
  }: {
    ticket: { number: number };
    branch: string;
  }): Promise<GateResult> {
    return Promise.resolve({
      green: true,
      summary: 'all checks passed',
      commits: this.#branches.get(branch) ?? [],
      ...this.#script.gate?.[ticket.number],
    });
  }

  merge(): Promise<void> {
    return Promise.resolve();
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
