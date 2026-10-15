import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { GitHubTracker } from '../src/github-tracker.ts';
import type { Tracker } from '../src/tracker.ts';
import { FakeTracker } from './fake-tracker.ts';

/**
 * The Tracker port's contract: what the loop relies on, checked against the
 * fake on every run and, opt-in, against a real GitHub repo, so the fake used
 * by the CLI tests can't drift from GitHub.
 *
 * To run against GitHub, point POLESAR_CONTRACT_REPO at a throwaway repo you
 * can create, close and delete issues in (`gh auth status` must be logged in):
 *   POLESAR_CONTRACT_REPO=you/polesar-contract pnpm vitest run test/tracker-contract.test.ts
 * It never runs in pre-commit, and is skipped in CI unless that variable is set.
 */

type Arranged = {
  tracker: Tracker;
  /** The real ticket numbers of the scenario's tickets. */
  open: number;
  closed: number;
  blocked: number;
};

/** One open ticket, one closed, and a ready-for-agent ticket blocked by both. */
type Arrange = () => Promise<Arranged>;

const LABELS = ['ready-for-agent', 'ready-for-human'];

const BODY = 'Created by the polesar tracker contract tests; safe to delete.';

/**
 * Retries `check` until it passes: GitHub's issue list lags a few seconds
 * behind writes, so a read straight after one can be stale.
 */
const eventually = (check: () => Promise<void>) =>
  vi.waitFor(check, { timeout: 30_000, interval: 2_000 });

const contract = (arrange: Arrange) => {
  it('lists only open tickets, with their labels and every blocker and whether it is open', async () => {
    const { tracker, open, closed, blocked } = await arrange();

    await eventually(async () => {
      const tickets = await tracker.openTickets();
      const numbers = tickets.map((ticket) => ticket.number);

      expect(numbers).toContain(open);
      expect(numbers).toContain(blocked);
      expect(numbers).not.toContain(closed);
      expect(numbers).toEqual([...numbers].sort((a, b) => a - b));
      const ticket = tickets.find((each) => each.number === blocked);
      expect(ticket?.title).toBe('Blocked ticket');
      expect(ticket?.body).toBe(BODY);
      expect(ticket?.labels).toEqual(['ready-for-agent']);
      expect(
        [...(ticket?.blockedBy ?? [])].sort((a, b) => a.number - b.number)
      ).toEqual([
        { number: open, open: true },
        { number: closed, open: false },
      ]);
      expect(tickets.find((each) => each.number === open)?.blockedBy).toEqual(
        []
      );
    });
  });

  it('adds and removes labels, ignoring a label already there or already gone', async () => {
    const { tracker, open } = await arrange();
    const labelsOf = async () =>
      (await tracker.openTickets())
        .find((ticket) => ticket.number === open)
        ?.labels.sort();

    await tracker.addLabel(open, 'ready-for-human');
    await tracker.addLabel(open, 'ready-for-human');
    await tracker.addLabel(open, 'ready-for-agent');
    await eventually(async () => {
      expect(await labelsOf()).toEqual(['ready-for-agent', 'ready-for-human']);
    });

    await tracker.removeLabel(open, 'ready-for-agent');
    await tracker.removeLabel(open, 'ready-for-agent');
    await eventually(async () => {
      expect(await labelsOf()).toEqual(['ready-for-human']);
    });
  });

  it('comments on and closes a ticket, ignoring a close of one already closed', async () => {
    const { tracker, open } = await arrange();

    await tracker.comment(open, 'Merged by polesar.');
    await tracker.close(open);
    await tracker.close(open);

    await eventually(async () => {
      const numbers = (await tracker.openTickets()).map(({ number }) => number);
      expect(numbers).not.toContain(open);
    });
  });
};

describe('Tracker contract: fake', () => {
  contract(() =>
    Promise.resolve({
      tracker: new FakeTracker([
        { number: 1, title: 'Open' },
        { number: 2, title: 'Closed', state: 'closed' },
        {
          number: 3,
          title: 'Blocked ticket',
          body: BODY,
          labels: ['ready-for-agent'],
          blockedBy: [1, 2],
        },
      ]),
      open: 1,
      closed: 2,
      blocked: 3,
    })
  );
});

const repo = process.env.POLESAR_CONTRACT_REPO;

describe.skipIf(!repo)('Tracker contract: GitHub', { timeout: 120_000 }, () => {
  const run = promisify(execFile);
  const gh = async (...args: string[]) =>
    (await run('gh', [...args, ...(args[0] === 'api' ? [] : ['-R', repo!])]))
      .stdout;
  const created: number[] = [];

  const createIssue = async (title: string, labels: string[] = []) => {
    const url = await gh(
      'issue',
      'create',
      '--title',
      title,
      '--body',
      BODY,
      ...labels.flatMap((label) => ['--label', label])
    );
    const number = Number(url.trim().split('/').pop());
    created.push(number);
    return number;
  };

  const addBlocker = async (ticket: number, blocker: number) => {
    const id = (
      await gh('api', `repos/${repo}/issues/${blocker}`, '--jq', '.id')
    ).trim();
    await gh(
      'api',
      '--method',
      'POST',
      `repos/${repo}/issues/${ticket}/dependencies/blocked_by`,
      '-F',
      `issue_id=${id}`
    );
  };

  afterAll(async () => {
    await Promise.all(
      created.map((number) =>
        // Deleting needs admin rights; closing keeps the repo's open list short either way.
        gh('issue', 'delete', String(number), '--yes').catch(() =>
          gh('issue', 'close', String(number))
        )
      )
    );
  }, 120_000);

  contract(async () => {
    for (const label of LABELS) {
      await gh('label', 'create', label, '--force');
    }
    const open = await createIssue('Open');
    const closed = await createIssue('Closed');
    await gh('issue', 'close', String(closed));
    const blocked = await createIssue('Blocked ticket', ['ready-for-agent']);
    await addBlocker(blocked, open);
    await addBlocker(blocked, closed);
    return { tracker: new GitHubTracker(repo), open, closed, blocked };
  });
});
