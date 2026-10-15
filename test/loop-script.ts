import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Implementation, Review } from '../src/executor.ts';
import type { GateResult } from '../src/gate.ts';
import type { RecordedCall } from './recording.ts';
import { runCli, type CliResult } from './run-cli.ts';
import type { ScriptedTicket } from './tracker-graph.ts';

/** The tracker graph plus, per ticket number, how the implementer, reviewer and gate behave. Unscripted, they succeed. */
export type LoopScript = {
  tickets: ScriptedTicket[];
  implement?: Record<number, Partial<Implementation>>;
  review?: Record<number, Partial<Review>>;
  gate?: Record<number, Partial<GateResult>>;
};

const SCRIPT_FILE = 'fakes.json';
const LOG_FILE = 'calls.jsonl';

type LoopResult = CliResult & {
  /** Every call the fake ports received, in order. */
  calls: RecordedCall[];
};

/** Runs `polesar loop` against fakes scripted by `script`, returning what the ports were asked to do. */
export const runLoop = async (
  script: LoopScript,
  args: string[] = [],
  files: Record<string, string> = {}
): Promise<LoopResult> => {
  const dir = await mkdtemp(path.join(tmpdir(), 'polesar-loop-'));
  try {
    const result = await runCli(['loop', ...args], {
      dir,
      files: { ...files, [SCRIPT_FILE]: JSON.stringify(script) },
      env: {
        POLESAR_TRACKER_FAKE: SCRIPT_FILE,
        POLESAR_LOOP_FAKE: SCRIPT_FILE,
        POLESAR_FAKE_LOG: path.join(dir, LOG_FILE),
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
    await rm(dir, { recursive: true, force: true });
  }
};

/** The calls that changed something: everything but tracker reads. */
export const writes = (calls: RecordedCall[]) =>
  calls.filter((call) => call.method !== 'openTickets');
