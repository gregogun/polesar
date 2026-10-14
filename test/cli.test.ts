import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { runCli } from './run-cli.ts';

describe('polesar --help', () => {
  it('prints usage to stdout and exits 0', async () => {
    const result = await runCli(['--help']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/^Usage: polesar /m);
    expect(result.stdout).toContain('--help');
    expect(result.stdout).toContain('--version');
    expect(result.stderr).toBe('');
  });
});

describe('polesar --version', () => {
  it('prints the package version and exits 0', async () => {
    const { version } = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8')
    ) as { version: string };
    const result = await runCli(['--version']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`${version}\n`);
  });
});

describe('polesar with an unknown option', () => {
  it('names the option, points at --help and exits 2', async () => {
    const result = await runCli(['--frobnicate']);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain("'--frobnicate'");
    expect(result.stderr).toContain('polesar --help');
  });
});
