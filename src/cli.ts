#!/usr/bin/env node
import { homedir } from 'node:os';
import path from 'node:path';
import { GitHubTracker } from './github-tracker.ts';
import { unavailable } from './loop.ts';
import { main } from './main.ts';
import { SandcastleExecutor } from './sandcastle-executor.ts';
import { FileUsage } from './usage.ts';

const home = process.env.POLESAR_HOME ?? path.join(homedir(), '.polesar');

await main(process.argv.slice(2), {
  tracker: () => Promise.resolve(new GitHubTracker()),
  executor: () => SandcastleExecutor.create(process.cwd(), home),
  ...unavailable,
  usage: () => Promise.resolve(new FileUsage(home)),
  now: () => Date.now(),
  home,
});
