#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const HELP = `Usage: polesar [options]

A trust-first policy layer for running coding agents.

Options:
  -h, --help     Show this help and exit
  -v, --version  Print the version and exit
`;

// Resolves from both src/ (dev, tests) and dist/ (installed bin).
const readVersion = (): string => {
  const pkg = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8')
  ) as { version: string };
  return pkg.version;
};

const parseArgsOrExit = () => {
  try {
    return parseArgs({
      options: {
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `polesar: ${message}\nRun 'polesar --help' for usage.\n`
    );
    process.exit(2);
  }
};

const { values } = parseArgsOrExit();

if (values.version) {
  process.stdout.write(`${readVersion()}\n`);
} else {
  process.stdout.write(HELP);
}
