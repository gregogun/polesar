import { describe, expect, it } from 'vitest';
import { runLoop, writes } from './loop-script.ts';

const ticket = { number: 1, title: 'Schema', labels: ['ready-for-agent'] };

describe('polesar loop: protected paths', () => {
  it('escalates a ticket whose diff modifies an existing test, even with a green gate and a clean review', async () => {
    const result = await runLoop({
      tickets: [ticket],
      implement: {
        1: {
          changes: [
            { path: 'src/schema.ts', change: 'modified' },
            { path: 'test/schema.test.ts', change: 'modified' },
          ],
        },
      },
    });

    expect(result.exitCode).toBe(1);
    expect(
      writes(result.calls).map(({ port, method }) => `${port}.${method}`)
    ).toEqual([
      'executor.implement',
      'executor.review',
      'gate.check',
      'tracker.addLabel',
      'tracker.removeLabel',
      'tracker.comment',
    ]);
    const comment = result.calls.find(({ method }) => method === 'comment');
    expect(comment?.args).toEqual([
      1,
      [
        'Escalated to ready-for-human by polesar.',
        '',
        '- protected paths changed: test/schema.test.ts',
        '',
        'Branch: `polesar/1`',
        '',
        '## Protected paths changed',
        '',
        '- `test/schema.test.ts` (modified; matches `**/*.test.*`)',
        '',
        'Record your verdict on this escalation with `polesar verdict 1 approved` or `polesar verdict 1 rejected`.',
        '',
        '## Trail',
        '',
        '1. Implement: committed c1',
        '2. Review of c1: no findings',
        '3. Gate on c1: green: all checks passed',
        '',
        '## Evidence',
        '',
        'evidence for #1',
        '',
      ].join('\n'),
    ]);
  });

  it.each([
    ['an existing test', 'src/frontier.spec.ts'],
    ['a test helper', 'test/run-cli.ts'],
    ['the verify config', 'polesar.json'],
    ['lint config', 'eslint.config.mjs'],
    ['format config', 'packages/web/.prettierrc.json'],
    ['typecheck config', 'tsconfig.build.json'],
    ['hook config', 'lefthook.yml'],
    ["Claude Code's hook settings", '.claude/settings.json'],
    ['a CI workflow', '.github/workflows/ci.yml'],
  ])(
    'escalates a ticket whose diff modifies or deletes %s (%s), even when green',
    async (_kind, path) => {
      for (const change of ['modified', 'deleted'] as const) {
        const result = await runLoop({
          tickets: [ticket],
          implement: { 1: { changes: [{ path, change }] } },
        });

        expect(result.exitCode).toBe(1);
        expect(writes(result.calls).map(({ method }) => method)).not.toContain(
          'merge'
        );
        const comment = result.calls.find(({ method }) => method === 'comment');
        expect(comment?.args[1]).toContain(
          `- protected paths changed: ${path}\n`
        );
        expect(comment?.args[1]).toContain(`- \`${path}\` (${change}; `);
      }
    }
  );

  it('merges a ticket that adds new test files, CI workflows or config without touching existing ones', async () => {
    const result = await runLoop({
      tickets: [ticket],
      implement: {
        1: {
          changes: [
            { path: 'src/schema.ts', change: 'modified' },
            { path: 'test/schema.test.ts', change: 'added' },
            { path: 'src/schema.spec.ts', change: 'added' },
            { path: '.github/workflows/release.yml', change: 'added' },
          ],
        },
      },
    });

    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
    expect(writes(result.calls).map(({ method }) => method)).toContain('merge');
  });

  it('judges the branch as it ends up, so a protected change reverted on a retry merges', async () => {
    const red = { green: false, summary: 'test failed: schema.test.ts' };
    const result = await runLoop({
      tickets: [ticket],
      implement: {
        1: [
          { changes: [{ path: 'test/schema.test.ts', change: 'modified' }] },
          { changes: [{ path: 'src/schema.ts', change: 'modified' }] },
        ],
      },
      gate: { 1: [red, red, {}] },
    });

    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
    expect(writes(result.calls).map(({ method }) => method)).toContain('merge');
  });

  it('names the protected files touched when a ticket escalates for another reason', async () => {
    const result = await runLoop({
      tickets: [ticket],
      implement: {
        1: { changes: [{ path: 'test/schema.test.ts', change: 'modified' }] },
      },
      review: {
        1: { findings: [{ blocking: true, summary: 'drops the index' }] },
      },
    });

    expect(result.exitCode).toBe(1);
    const comment = result.calls.find(({ method }) => method === 'comment');
    expect(comment?.args[1]).toContain(
      '- `test/schema.test.ts` (modified; matches `**/*.test.*`)\n'
    );
    expect(comment?.args[1]).toContain('`polesar verdict 1 approved`');
  });

  describe('per-repo override in polesar.json', () => {
    const config = (protectedPaths: unknown) => ({
      'polesar.json': JSON.stringify({
        verify: { checks: { lint: 'true' } },
        protectedPaths,
      }),
    });

    it('adds patterns to the default list', async () => {
      const result = await runLoop(
        {
          tickets: [ticket],
          implement: {
            1: {
              changes: [{ path: 'src/policy/merge.ts', change: 'modified' }],
            },
          },
        },
        [],
        config({ add: ['src/policy/**'] })
      );

      expect(result.exitCode).toBe(1);
      const comment = result.calls.find(({ method }) => method === 'comment');
      expect(comment?.args[1]).toContain(
        '- `src/policy/merge.ts` (modified; matches `src/policy/**`)'
      );
    });

    it('removes patterns from the default list', async () => {
      const result = await runLoop(
        {
          tickets: [ticket],
          implement: {
            1: { changes: [{ path: 'tsconfig.json', change: 'modified' }] },
          },
        },
        [],
        config({ remove: ['**/tsconfig*.json'] })
      );

      expect(result.stderr).toBe('');
      expect(result.exitCode).toBe(0);
    });

    it('needs no verify checks to override protected paths', async () => {
      const result = await runLoop(
        {
          tickets: [ticket],
          implement: {
            1: { changes: [{ path: 'docs/policy.md', change: 'deleted' }] },
          },
        },
        [],
        {
          'polesar.json': JSON.stringify({
            protectedPaths: { add: ['docs/policy.md'] },
          }),
        }
      );

      expect(result.exitCode).toBe(1);
    });

    it.each([
      [
        'a pattern to remove that is not a default',
        { remove: ['**/tsconfig.json'] },
        /"\*\*\/tsconfig\.json" is not a default protected path[\s\S]*\*\*\/tsconfig\*\.json/,
      ],
      [
        'patterns that are not strings',
        { add: [3] },
        /"protectedPaths\.add" must be a list of glob strings/,
      ],
      [
        'a pattern to add that can never match a repo-relative path',
        { add: ['/src/**'] },
        /"\/src\/\*\*" can never match: patterns are relative to the repo root/,
      ],
      [
        'an unknown key',
        { only: ['src/**'] },
        /"protectedPaths" takes only "add" and "remove"/,
      ],
    ])(
      'refuses to run, before touching any ticket, on %s',
      async (_problem, protectedPaths, message) => {
        const result = await runLoop(
          { tickets: [ticket] },
          [],
          config(protectedPaths)
        );

        expect(result.exitCode).toBe(2);
        expect(result.stderr).toMatch(/^polesar: .*polesar\.json/);
        expect(result.stderr).toMatch(message);
        expect(writes(result.calls)).toEqual([]);
      }
    );
  });
});
