#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { text } from 'node:stream/consumers';
import { parseArgs, type ParseArgsOptionsConfig } from 'node:util';
import { stopHook } from './hook.ts';
import { ConfigError, summarise, verify } from './verify.ts';

const HELP = `Usage: polesar [options]
       polesar <command> [options]

A trust-first policy layer for running coding agents.

Commands:
  verify [--json]  Run the repo's cheap checks, listed under "verify.checks"
                   in polesar.json. Prints only failing checks: where they
                   failed and a path to the full log. --json gives structured
                   results for every check.
                   Exit: 0 all passed, 1 a check failed, 2 bad usage or config.
  hook stop        Claude Code Stop hook. Reads the hook payload on stdin and
                   runs verify in its cwd; sends the agent back with the
                   failure summary while checks fail. Allows the stop in repos
                   without polesar.json.

Options:
  -h, --help       Show this help and exit
  -v, --version    Print the version and exit
`;

const help = { type: 'boolean', short: 'h' } as const;

// Resolves from both src/ (dev, tests) and dist/ (installed bin).
const readVersion = (): string => {
  const pkg = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8')
  ) as { version: string };
  return pkg.version;
};

const parseArgsOrExit = <T extends ParseArgsOptionsConfig>(
  args: string[],
  options: T,
  allowPositionals = false
) => {
  try {
    return parseArgs({ args, options, allowPositionals });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `polesar: ${message}\nRun 'polesar --help' for usage.\n`
    );
    process.exit(2);
  }
};

const verifyOrExit = async (cwd: string) => {
  try {
    return await verify(cwd);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    process.stderr.write(`polesar: ${error.message}\n`);
    process.exit(2);
  }
};

const [command, ...rest] = process.argv.slice(2);

if (command === 'verify') {
  const { values } = parseArgsOrExit(rest, {
    help,
    json: { type: 'boolean' },
  });
  if (values.help) {
    process.stdout.write(HELP);
    process.exit(0);
  }
  const checks = await verifyOrExit(process.cwd());
  const passed = checks.every((check) => check.passed);
  process.stdout.write(
    values.json
      ? `${JSON.stringify({ passed, checks }, null, 2)}\n`
      : summarise(checks)
  );
  process.exitCode = passed ? 0 : 1;
} else if (command === 'hook') {
  const { values, positionals } = parseArgsOrExit(rest, { help }, true);
  if (values.help) {
    process.stdout.write(HELP);
    process.exit(0);
  }
  if (positionals.length !== 1 || positionals[0] !== 'stop') {
    process.stderr.write(
      `polesar: unknown hook '${positionals.join(' ')}'. Supported: stop\nRun 'polesar --help' for usage.\n`
    );
    process.exit(2);
  }
  const response = await stopHook(await text(process.stdin));
  process.stdout.write(response.stdout);
  process.stderr.write(response.stderr);
  process.exitCode = response.exitCode;
} else {
  const { values } = parseArgsOrExit(process.argv.slice(2), {
    help,
    version: { type: 'boolean', short: 'v' },
  });
  if (values.version) {
    process.stdout.write(`${readVersion()}\n`);
  } else {
    process.stdout.write(HELP);
  }
}
