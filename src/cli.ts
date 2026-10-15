#!/usr/bin/env node
import { GitHubTracker } from './github-tracker.ts';
import { unavailable } from './loop.ts';
import { main } from './main.ts';

await main(process.argv.slice(2), {
  tracker: () => Promise.resolve(new GitHubTracker()),
  ...unavailable,
});
