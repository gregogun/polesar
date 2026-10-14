import { GitHubTracker } from '../src/github-tracker.ts';
import { main } from '../src/main.ts';
import { loadFakeTracker } from './fake-tracker.ts';

/**
 * The polesar CLI as tests run it: the real CLI, with a fake tracker scripted
 * by the graph file POLESAR_TRACKER_FAKE names. The fakes live only here, out
 * of the shipped bin, so nothing outside the tests can swap in a made-up
 * tracker.
 */
const fake = process.env.POLESAR_TRACKER_FAKE;
await main(process.argv.slice(2), {
  tracker: async () => (fake ? loadFakeTracker(fake) : new GitHubTracker()),
});
