import { GitHubTracker } from '../src/github-tracker.ts';
import { unavailable } from '../src/loop.ts';
import { main } from '../src/main.ts';
import { loadFakeLoop } from './fake-loop.ts';
import { loadFakeTracker } from './fake-tracker.ts';
import { recording } from './recording.ts';

/**
 * The polesar CLI as tests run it: the real CLI, with fakes scripted by the
 * files POLESAR_TRACKER_FAKE (the tracker's issue graph) and POLESAR_LOOP_FAKE
 * (the executor and gate) name. With POLESAR_FAKE_LOG set, every call the fakes
 * receive is logged there. The fakes live only here, out of the shipped bin, so
 * nothing outside the tests can swap in a made-up tracker or agent.
 */
const { POLESAR_TRACKER_FAKE, POLESAR_LOOP_FAKE, POLESAR_FAKE_LOG } =
  process.env;
// Loaded once, on first use, so the executor and gate share one scripted branch state.
let loop: ReturnType<typeof loadFakeLoop> | undefined;
const fakeLoop = (file: string) => (loop ??= loadFakeLoop(file));
await main(process.argv.slice(2), {
  tracker: async () =>
    POLESAR_TRACKER_FAKE
      ? recording(
          'tracker',
          await loadFakeTracker(POLESAR_TRACKER_FAKE),
          POLESAR_FAKE_LOG
        )
      : new GitHubTracker(),
  executor: async () =>
    POLESAR_LOOP_FAKE
      ? recording(
          'executor',
          (await fakeLoop(POLESAR_LOOP_FAKE)).executor,
          POLESAR_FAKE_LOG
        )
      : unavailable.executor(),
  gate: async () =>
    POLESAR_LOOP_FAKE
      ? recording(
          'gate',
          (await fakeLoop(POLESAR_LOOP_FAKE)).gate,
          POLESAR_FAKE_LOG
        )
      : unavailable.gate(),
});
