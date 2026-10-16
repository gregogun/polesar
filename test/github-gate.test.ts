import { describe, expect, it } from 'vitest';
import { commands, runWithGitHub, type GhScript } from './gh-script.ts';
import { writes } from './loop-script.ts';

const tickets = [
  {
    number: 7,
    title: 'Docs',
    body: 'Write the docs.',
    labels: ['ready-for-agent'],
  },
];

const CHECKS_JSON = 'name,state,bucket,description,link,workflow';
const poll = (pr: number) => [
  ['gh', 'pr', 'view', String(pr), '--json', 'headRefOid,commits'],
  ['gh', 'pr', 'checks', String(pr), '--required', '--json', CHECKS_JSON],
];
const pushed = (commit: string) => [
  ['git', 'rev-parse', '--verify', 'refs/heads/polesar/7^{commit}'],
  ['git', 'push', 'origin', `${commit}:refs/heads/polesar/7`],
  [
    'gh',
    'pr',
    'list',
    '--head',
    'polesar/7',
    '--state',
    'open',
    '--json',
    'number',
  ],
];
const merged = (pr: number, commit: string) => [
  [
    'gh',
    'pr',
    'list',
    '--head',
    'polesar/7',
    '--state',
    'open',
    '--json',
    'number',
  ],
  ['git', 'rev-parse', '--verify', 'refs/heads/polesar/7^{commit}'],
  ['gh', 'pr', 'merge', String(pr), '--merge', '--match-head-commit', commit],
];

const RUN = 'https://github.com/owner/repo/actions/runs';
const failedTest = {
  name: 'check',
  bucket: 'fail',
  workflow: 'CI',
  link: `${RUN}/11/job/22`,
} as const;
const passedLint = {
  name: 'lint',
  bucket: 'pass',
  workflow: 'CI',
  link: `${RUN}/12/job/23`,
} as const;
const runs: GhScript['runs'] = {
  '11': {
    jobs: [
      {
        databaseId: 22,
        name: 'check',
        conclusion: 'failure',
        steps: [
          { name: 'Set up job', conclusion: 'success' },
          { name: 'Run pnpm test', conclusion: 'failure' },
        ],
      },
    ],
  },
};
const testFailure = (job: number) =>
  `check (CI) failed at step "Run pnpm test" (${RUN}/11/job/${job})`;

// Every gh and git call spawns the fake, so these run slower than other CLI tests.
describe('polesar loop with the GitHub gate', { timeout: 20_000 }, () => {
  it('pushes the branch, opens a PR whose templated body closes the ticket, waits for required checks and merges through GitHub', async () => {
    const result = await runWithGitHub(
      { tickets },
      {
        checks: {
          'polesar/7': [
            'none',
            [{ name: 'check', bucket: 'pending' }],
            [{ name: 'check', bucket: 'pass', workflow: 'CI' }],
          ],
        },
      }
    );

    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
    expect(commands(result.calls)).toEqual([
      ...pushed('c7'),
      [
        'gh',
        'pr',
        'create',
        '--head',
        'polesar/7',
        '--title',
        'Docs',
        '--body',
        'Closes #7\n\n## Evidence\n\nevidence for #7\n',
      ],
      ...poll(100),
      ...poll(100),
      ...poll(100),
      ...merged(100, 'c7'),
    ]);
    const comment = writes(result.calls).find(
      ({ method }) => method === 'comment'
    );
    expect(comment?.args[1]).toContain(
      '- Gate: required checks passed on c7: check\n'
    );
    expect(writes(result.calls).at(-1)).toMatchObject({
      port: 'tracker',
      method: 'close',
    });
  });

  it('reuses the open PR for the branch, refreshing its body', async () => {
    const result = await runWithGitHub(
      { tickets },
      { openPrs: { 'polesar/7': 42 } }
    );

    expect(result.exitCode).toBe(0);
    expect(commands(result.calls)).toEqual([
      ...pushed('c7'),
      [
        'gh',
        'pr',
        'edit',
        '42',
        '--body',
        'Closes #7\n\n## Evidence\n\nevidence for #7\n',
      ],
      ...poll(42),
      ...merged(42, 'c7'),
    ]);
  });

  it('reruns only the failed checks on the free rerun, and merges when they pass, logging a flaky gate', async () => {
    const red = [failedTest, passedLint];
    const result = await runWithGitHub(
      { tickets },
      {
        checks: {
          'polesar/7': [
            red,
            // The rerun reads which checks failed, then GitHub is slow to show it started.
            red,
            red,
            [
              { ...failedTest, bucket: 'pending', link: `${RUN}/11/job/24` },
              passedLint,
            ],
            [
              { ...failedTest, bucket: 'pass', link: `${RUN}/11/job/24` },
              passedLint,
            ],
          ],
        },
        runs,
      }
    );

    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
    const reruns = commands(result.calls).filter(
      ([, command, sub]) => command === 'run' && sub === 'rerun'
    );
    expect(reruns).toEqual([['gh', 'run', 'rerun', '11', '--failed']]);
    expect(result.stdout).toBe(
      [
        '#7 Docs: merged',
        `  flaky gate: required checks failed on c7: ${testFailure(22)} (green on rerun with no code change)`,
        'loop stopped: nothing left on the frontier (1 merged)',
        '',
      ].join('\n')
    );
  });

  it('sends what still fails after the rerun back to the implementer, naming each failed check and why', async () => {
    const preview = {
      name: 'preview',
      bucket: 'fail',
      description: 'Deployment failed',
      link: 'https://deploys.example/7',
    } as const;
    const result = await runWithGitHub(
      { tickets },
      {
        checks: {
          'polesar/7': [
            [failedTest, preview],
            [failedTest, preview],
            [{ ...failedTest, link: `${RUN}/11/job/25` }, preview],
          ],
        },
        runs,
      },
      { config: { gate: { timeoutMinutes: 0.001 } } }
    );

    expect(result.exitCode).toBe(1);
    const implementations = result.calls.filter(
      ({ method }) => method === 'implement'
    );
    expect(implementations[1]?.args[0]).toMatchObject({
      feedback: {
        gate: `required checks failed on c7: ${testFailure(25)}; preview failed: Deployment failed (https://deploys.example/7)`,
      },
    });
    // A check that isn't a GitHub Actions run can't be rerun through gh.
    const reruns = commands(result.calls).filter(
      ([, command, sub]) => command === 'run' && sub === 'rerun'
    );
    expect(reruns[0]).toEqual(['gh', 'run', 'rerun', '11', '--failed']);
    expect(reruns.every((argv) => argv[3] === '11')).toBe(true);
  });

  it('stops waiting at the timeout and reports the checks still running', async () => {
    const result = await runWithGitHub(
      { tickets },
      { checks: { 'polesar/7': [[{ name: 'check', bucket: 'pending' }]] } },
      { args: ['--json'], config: { gate: { timeoutMinutes: 0.001 } } }
    );

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout).outcomes[0].escalated).toEqual([
      'CI retries used up (2 of 2)',
      'gate red: timed out after 0.001 min waiting for required checks on c7.3: still running: check',
    ]);
    expect(
      commands(result.calls).some(([, command]) => command === 'run')
    ).toBe(false);
  });

  it('says when no required checks are reported, so a repo without branch protection never looks green', async () => {
    const result = await runWithGitHub(
      { tickets },
      { checks: { 'polesar/7': ['none'] } },
      { args: ['--json'], config: { gate: { timeoutMinutes: 0.001 } } }
    );

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout).outcomes[0].escalated).toContain(
      'gate red: timed out after 0.001 min waiting for required checks on c7.3: no required checks reported; require status checks on the base branch with branch protection'
    );
  });

  it('stops with what to do when GitHub refuses the merge, leaving the ticket open', async () => {
    const result = await runWithGitHub(
      { tickets },
      {
        fail: {
          'pr merge':
            'X Pull request owner/repo#100 is not mergeable: the base branch policy prohibits the merge.',
        },
      }
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(
      'polesar: GitHub would not merge PR #100 (polesar/7): X Pull request owner/repo#100 is not mergeable: the base branch policy prohibits the merge.\nBranch protection applies to polesar too: see the PR on GitHub, then run polesar loop again.\n'
    );
    expect(
      writes(result.calls).filter(({ port }) => port === 'tracker')
    ).toEqual([]);
  });

  it('stops with what to do when the branch cannot be pushed', async () => {
    const result = await runWithGitHub(
      { tickets },
      { fail: { push: '! [rejected] polesar/7 (fetch first)' } }
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(
      "polesar: couldn't push polesar/7 to origin: ! [rejected] polesar/7 (fetch first)\nCheck `git remote -v` and that origin's polesar/7 holds nothing the local branch lacks.\n"
    );
    expect(commands(result.calls).some(([, command]) => command === 'pr')).toBe(
      false
    );
  });

  it('rejects a gate timeout that is not a positive number of minutes', async () => {
    const result = await runWithGitHub(
      { tickets },
      {},
      { config: { gate: { timeoutMinutes: 'soon' } } }
    );

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toMatch(
      /"gate.timeoutMinutes" must be a positive number of minutes, e.g.:\n"gate": \{"timeoutMinutes":30\}\n$/
    );
  });
});
