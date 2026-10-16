import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { GitHubGate } from '../src/github-gate.ts';
import { prBody } from '../src/templates.ts';

/**
 * The GitHub gate against real GitHub: a PR, real required checks, a rerun of
 * only the failed ones and a merge through branch protection. The CLI tests
 * drive the same adapter against a fake `gh`; this proves the fake's answers
 * are GitHub's.
 *
 * Opt-in, against a throwaway repo you own (`gh auth status` must be logged
 * in), whose main branch protection requires a status check named `contract`
 * and nothing else (no required reviews). The test brings its own workflow on
 * its branch, so the repo needs no other setup:
 *   POLESAR_GATE_CONTRACT_REPO=you/polesar-gate-contract pnpm vitest run test/gate-contract.test.ts
 * It never runs in pre-commit, and is skipped in CI unless that variable is set.
 * It runs real GitHub Actions jobs, so it takes minutes.
 */

const repo = process.env.POLESAR_GATE_CONTRACT_REPO;

const WORKFLOW = `name: polesar-contract
on: pull_request
jobs:
  contract:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Fail while FAIL exists
        run: test ! -f FAIL
  passing:
    runs-on: ubuntu-latest
    steps:
      - run: 'true'
`;

describe.skipIf(!repo)('Gate contract: GitHub', { timeout: 900_000 }, () => {
  const run = promisify(execFile);
  let dir: string;
  let ticket: number;
  const branch = `polesar-contract/${Date.now()}`;
  const sh = async (command: string, ...args: string[]) =>
    (await run(command, args, { cwd: dir })).stdout.trim();
  const git = (...args: string[]) =>
    sh(
      'git',
      '-c',
      'user.name=polesar contract',
      '-c',
      'user.email=polesar-contract@example.com',
      ...args
    );
  const gh = (...args: string[]) => sh('gh', ...args);
  const branchCommits = async () =>
    (await git('rev-list', '--reverse', `origin/main..${branch}`)).split('\n');
  const input = () => ({
    ticket: { number: ticket, title: 'polesar gate contract' },
    branch,
    prBody: prBody({
      ticket,
      evidence: 'Created by the polesar gate contract tests; safe to delete.',
      nonBlocking: [],
    }),
  });

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'polesar-gate-contract-'));
    await run('gh', ['repo', 'clone', repo!, dir]);
    const url = await gh(
      'issue',
      'create',
      '--title',
      'polesar gate contract',
      '--body',
      'Created by the polesar gate contract tests; safe to delete.'
    );
    ticket = Number(url.split('/').pop());
    await git('checkout', '-b', branch);
    await mkdir(path.join(dir, '.github/workflows'), { recursive: true });
    await writeFile(
      path.join(dir, '.github/workflows/polesar-contract.yml'),
      WORKFLOW
    );
    await writeFile(path.join(dir, 'FAIL'), 'remove me to pass\n');
    await git('add', '.');
    await git('commit', '-m', 'test: polesar gate contract (failing)');
  }, 120_000);

  afterAll(async () => {
    if (dir === undefined) return;
    await gh('pr', 'close', branch, '--delete-branch').catch(() => undefined);
    await gh(
      'api',
      '--method',
      'DELETE',
      `repos/${repo}/git/refs/heads/${branch}`
    ).catch(() => undefined);
    await gh('issue', 'delete', String(ticket), '--yes').catch(() =>
      gh('issue', 'close', String(ticket)).catch(() => undefined)
    );
    await rm(dir, { recursive: true, force: true });
  }, 120_000);

  it('reports red with the failed check and step, reruns only that, then goes green and merges, closing the ticket', async () => {
    const gate = await GitHubGate.create(dir, { pollMs: 5_000 });

    const red = await gate.check(input());

    expect(red.green).toBe(false);
    expect(red.summary).toContain('contract');
    expect(red.summary).toContain('failed at step "Fail while FAIL exists"');
    expect(red.commits).toEqual(await branchCommits());
    const pr = JSON.parse(
      await gh('pr', 'view', branch, '--json', 'body,closingIssuesReferences')
    ) as { body: string; closingIssuesReferences: { number: number }[] };
    expect(pr.body).toBe(input().prBody);
    expect(pr.closingIssuesReferences.map(({ number }) => number)).toEqual([
      ticket,
    ]);
    const runId = /\/actions\/runs\/(\d+)/.exec(red.summary)?.[1];
    const jobs = async () =>
      (
        JSON.parse(await gh('run', 'view', runId!, '--json', 'jobs')) as {
          jobs: { name: string; startedAt: string }[];
        }
      ).jobs;
    const passingBefore = (await jobs()).find(({ name }) => name === 'passing');

    const rerun = await gate.rerun({ branch });

    expect(rerun.green).toBe(false);
    expect(rerun.commits).toEqual(red.commits);
    const attempt = JSON.parse(
      await gh(
        'api',
        `repos/${repo}/actions/runs/${runId}`,
        '--jq',
        '{run_attempt}'
      )
    ) as { run_attempt: number };
    expect(attempt.run_attempt).toBe(2);
    // The passing job wasn't rerun: it kept its first attempt's start.
    expect((await jobs()).find(({ name }) => name === 'passing')).toEqual(
      passingBefore
    );

    await git('rm', 'FAIL');
    await git('commit', '-m', 'test: polesar gate contract (passing)');
    const green = await gate.check(input());

    expect(green.green).toBe(true);
    expect(green.summary).toContain('required checks passed');
    expect(green.commits).toEqual(await branchCommits());

    await gate.merge({ branch });

    const merged = JSON.parse(
      await gh('pr', 'view', branch, '--json', 'state,mergeCommit')
    ) as { state: string };
    expect(merged.state).toBe('MERGED');
    await vi.waitFor(
      async () => {
        const issue = JSON.parse(
          await gh('issue', 'view', String(ticket), '--json', 'state')
        ) as { state: string };
        expect(issue.state).toBe('CLOSED');
      },
      { timeout: 60_000, interval: 5_000 }
    );
  });
});
