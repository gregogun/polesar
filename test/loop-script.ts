import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Implementation, RateLimited, Review } from '../src/executor.ts';
import type { GateResult } from '../src/gate.ts';
import type { ScriptedReading } from './fake-usage.ts';
import type { RecordedCall } from './recording.ts';
import { runCli, type CliResult } from './run-cli.ts';
import type { ScriptedTicket } from './tracker-graph.ts';

/** How a port behaves for one ticket: the same on every call, or one entry per call with the last repeating. */
export type Scripted<T> = Partial<T> | Partial<T>[];

/**
 * The tracker graph plus, per ticket number, how the implementer, reviewer and
 * gate behave. Unscripted, they succeed. The gate's checks and reruns share
 * one sequence.
 */
export type LoopScript = {
  tickets: ScriptedTicket[];
  implement?: Record<number, Scripted<Implementation & RateLimited>>;
  review?: Record<number, Scripted<Review & RateLimited>>;
  gate?: Record<number, Scripted<GateResult>>;
  /** Usage readings, one per read, the last repeating. Unscripted: fresh and low. */
  usage?: ScriptedReading | ScriptedReading[];
};

/** The clock in loop runs, unless a test sets another. */
export const NOW = '2026-10-15T12:00:00.000Z';

const SCRIPT_FILE = 'fakes.json';
const LOG_FILE = 'calls.jsonl';

type LoopResult = CliResult & {
  /** Every call the fake ports received, in order. */
  calls: RecordedCall[];
};

/** Runs polesar with `args` against fakes scripted by `script`, returning what the ports were asked to do. */
export const runWithFakes = async (
  args: string[],
  script: LoopScript,
  files: Record<string, string> = {},
  env: Record<string, string> = {},
  /** An existing directory to run in, left in place; a fresh one otherwise. */
  shared?: string
): Promise<LoopResult> => {
  const dir = shared ?? (await mkdtemp(path.join(tmpdir(), 'polesar-loop-')));
  await rm(path.join(dir, LOG_FILE), { force: true });
  try {
    const result = await runCli(args, {
      dir,
      files: { ...files, [SCRIPT_FILE]: JSON.stringify(script) },
      env: {
        POLESAR_TRACKER_FAKE: SCRIPT_FILE,
        POLESAR_LOOP_FAKE: SCRIPT_FILE,
        POLESAR_USAGE_FAKE: SCRIPT_FILE,
        POLESAR_FAKE_NOW: NOW,
        POLESAR_HOME: path.join(dir, 'home'),
        POLESAR_FAKE_LOG: path.join(dir, LOG_FILE),
        ...env,
      },
    });
    const log = await readFile(path.join(dir, LOG_FILE), 'utf8').catch(
      () => ''
    );
    const calls = log
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as RecordedCall);
    return { ...result, calls };
  } finally {
    if (shared === undefined) await rm(dir, { recursive: true, force: true });
  }
};

/** Runs `polesar loop` against fakes scripted by `script`, returning what the ports were asked to do. */
export const runLoop = (
  script: LoopScript,
  args: string[] = [],
  files: Record<string, string> = {},
  env: Record<string, string> = {}
) => runWithFakes(['loop', ...args], script, files, env);

export type LoopSession = {
  /** Runs `polesar loop` in the session's repo, at `now`. */
  run(
    script: LoopScript,
    options: { now: string; args?: string[] }
  ): Promise<LoopResult>;
  close(): Promise<void>;
};

/**
 * Successive `polesar loop` runs in one repo, sharing polesar's home and the
 * fakes' branches and call counts, as if the same agent and gate carried on.
 */
export const loopSession = async (): Promise<LoopSession> => {
  const dir = await mkdtemp(path.join(tmpdir(), 'polesar-session-'));
  return {
    run: (script, { now, args = [] }) =>
      runWithFakes(
        ['loop', ...args],
        script,
        {},
        {
          POLESAR_FAKE_NOW: new Date(now).toISOString(),
          POLESAR_FAKE_STATE: path.join(dir, 'fake-state.json'),
        },
        dir
      ),
    close: () => rm(dir, { recursive: true, force: true }),
  };
};

/** The calls that changed something: everything but tracker and usage reads. */
export const writes = (calls: RecordedCall[]) =>
  calls.filter(
    (call) => call.method !== 'openTickets' && call.port !== 'usage'
  );
