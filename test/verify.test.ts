import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { polesarConfig } from './polesar-config.ts';
import { runCli } from './run-cli.ts';

describe('polesar verify', () => {
  it('reports success and exits 0 when every check passes', async () => {
    const result = await runCli(['verify'], {
      files: polesarConfig({ format: 'echo formatted', lint: 'true' }),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('verify: all 2 checks passed\n');
    expect(result.stderr).toBe('');
  });

  it('finds the config at the git root and runs checks there when run from a subdirectory', async () => {
    const result = await runCli(['verify'], {
      cwd: 'packages/app',
      files: {
        '.git/HEAD': 'ref: refs/heads/main\n',
        ...polesarConfig({ 'at-root': 'test -f polesar.json' }),
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('verify: all 1 checks passed\n');
  });

  it('does not look for config above the git root', async () => {
    const result = await runCli(['verify'], {
      cwd: 'project',
      files: {
        'project/.git/HEAD': 'ref: refs/heads/main\n',
        ...polesarConfig({}),
      },
    });

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('no polesar.json');
  });

  it('lists only the failing checks, where they failed and their full log, and exits 1', async () => {
    const result = await runCli(['verify'], {
      files: polesarConfig({
        format: 'echo all files formatted',
        typecheck:
          "echo 'src/a.ts:3:5 - error TS2322: nope' >&2; echo 'Found 1 error.'; exit 2",
      }),
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toMatch(/^verify: 1 of 2 checks failed\n/);
    expect(result.stdout).toContain('✗ typecheck (exit 2)');
    expect(result.stdout).toContain('src/a.ts:3:5 - error TS2322: nope');
    expect(result.stdout).not.toContain('format');
    expect(result.stdout).not.toContain('all files formatted');

    const log = /Full log: (.+)$/m.exec(result.stdout)?.[1];
    expect(log).toBeDefined();
    expect(await readFile(log!, 'utf8')).toBe(
      'src/a.ts:3:5 - error TS2322: nope\nFound 1 error.\n'
    );
  });

  it('gives structured results for every check with --json', async () => {
    const result = await runCli(['verify', '--json'], {
      files: polesarConfig({
        format: 'true',
        lint: "echo 'src/b.ts:7:1 no-unused-vars'; exit 1",
      }),
    });

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual({
      passed: false,
      checks: [
        {
          name: 'format',
          command: 'true',
          passed: true,
          exitCode: 0,
          excerpt: [],
          log: expect.any(String),
        },
        {
          name: 'lint',
          command: "echo 'src/b.ts:7:1 no-unused-vars'; exit 1",
          passed: false,
          exitCode: 1,
          excerpt: ['src/b.ts:7:1 no-unused-vars'],
          log: expect.any(String),
        },
      ],
    });
  });

  it('explains how to configure checks and exits 2 when there is no config', async () => {
    const result = await runCli(['verify']);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('polesar.json');
    expect(result.stderr).toContain('"checks"');
  });

  it.each([
    ['is not JSON', '{ verify: '],
    ['has no checks', JSON.stringify({ verify: {} })],
    ['has an empty checks list', JSON.stringify({ verify: { checks: {} } })],
    [
      'has a non-string check command',
      JSON.stringify({ verify: { checks: { lint: 42 } } }),
    ],
  ])(
    'names the problem and exits 2 when the config %s',
    async (_problem, content) => {
      const result = await runCli(['verify'], {
        files: { 'polesar.json': content },
      });

      expect(result.exitCode).toBe(2);
      expect(result.stdout).toBe('');
      expect(result.stderr).toMatch(/^polesar: .*polesar\.json/);
    }
  );

  it('keeps stdout and stderr in the order the check wrote them', async () => {
    const result = await runCli(['verify'], {
      files: polesarConfig({
        interleaved:
          'for i in $(seq 1 200); do echo "out $i"; echo "err $i" >&2; done; exit 1',
      }),
    });

    const log = /Full log: (.+)$/m.exec(result.stdout)?.[1];
    const expected = Array.from(
      { length: 200 },
      (_, i) => `out ${i + 1}\nerr ${i + 1}\n`
    ).join('');
    expect(await readFile(log!, 'utf8')).toBe(expected);
  });

  it('shows only the tail of a long failure, leaving the rest to the full log', async () => {
    const result = await runCli(['verify'], {
      files: polesarConfig({
        test: 'for i in $(seq 1 100); do echo "line $i"; done; exit 1',
      }),
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('line 100');
    expect(result.stdout).not.toMatch(/line 1$/m);
  });
});
