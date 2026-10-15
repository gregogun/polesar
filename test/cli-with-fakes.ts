import type { Executor } from '../src/executor.ts';
import type { Gate } from '../src/gate.ts';
import { GitHubTracker } from '../src/github-tracker.ts';
import { unavailable } from '../src/loop.ts';
import { homedir } from 'node:os';
import path from 'node:path';
import { main } from '../src/main.ts';
import { SandcastleExecutor } from '../src/sandcastle-executor.ts';
import { FileUsage } from '../src/usage.ts';
import { loadFakeLoop } from './fake-loop.ts';
import { loadFakeTracker } from './fake-tracker.ts';
import { loadFakeUsage } from './fake-usage.ts';
import { recording } from './recording.ts';

/**
 * The polesar CLI as tests run it: the real CLI, with fakes scripted by the
 * files POLESAR_TRACKER_FAKE (the tracker's issue graph), POLESAR_LOOP_FAKE
 * (the executor and gate) and POLESAR_USAGE_FAKE (usage readings) name, and
 * the clock set to POLESAR_FAKE_NOW. With POLESAR_FAKE_LOG set, every call the
 * fakes receive is logged there. With POLESAR_FAKE_STATE set, the executor and
 * gate keep their branches and call counts there from one run to the next.
 * The fakes live only here, out of the shipped bin, so nothing outside the
 * tests can swap in a made-up tracker or agent.
 */
const {
  POLESAR_TRACKER_FAKE,
  POLESAR_LOOP_FAKE,
  POLESAR_USAGE_FAKE,
  POLESAR_FAKE_NOW,
  POLESAR_FAKE_LOG,
  POLESAR_FAKE_STATE,
  POLESAR_HOME,
} = process.env;

const home = POLESAR_HOME ?? path.join(homedir(), '.polesar');
const now = () =>
  POLESAR_FAKE_NOW === undefined ? Date.now() : Date.parse(POLESAR_FAKE_NOW);

// Loaded once, on first use, so the executor and gate share one scripted branch state.
let loop: ReturnType<typeof loadFakeLoop> | undefined;
const fakeLoopPort = async <K extends 'executor' | 'gate'>(
  port: K,
  real: () => Promise<{ executor: Executor; gate: Gate }[K]>
): Promise<{ executor: Executor; gate: Gate }[K]> => {
  if (!POLESAR_LOOP_FAKE) return real();
  loop ??= loadFakeLoop(POLESAR_LOOP_FAKE, POLESAR_FAKE_STATE);
  return recording(port, (await loop)[port], POLESAR_FAKE_LOG);
};

await main(process.argv.slice(2), {
  tracker: async () =>
    POLESAR_TRACKER_FAKE
      ? recording(
          'tracker',
          await loadFakeTracker(POLESAR_TRACKER_FAKE),
          POLESAR_FAKE_LOG
        )
      : new GitHubTracker(),
  executor: () =>
    fakeLoopPort('executor', () =>
      SandcastleExecutor.create(process.cwd(), home)
    ),
  gate: () => fakeLoopPort('gate', unavailable.gate),
  usage: async () =>
    POLESAR_USAGE_FAKE
      ? recording(
          'usage',
          await loadFakeUsage(POLESAR_USAGE_FAKE, now()),
          POLESAR_FAKE_LOG
        )
      : new FileUsage(home),
  now,
  home,
});
