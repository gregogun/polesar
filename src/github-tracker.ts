import { execFile } from 'node:child_process';
import {
  TrackerError,
  type Blocker,
  type Ticket,
  type Tracker,
} from './tracker.ts';

type ListedIssue = {
  number: number;
  title: string;
  body: string;
  labels: string[];
  /** The issue's repo, as an API URL. */
  repositoryUrl: string;
  /** All blockers, open or closed; null where GitHub didn't say. */
  totalBlockedBy: number | null;
};

type ListedBlocker = { number: number; open: boolean; repositoryUrl: string };

/** Blocker lists fetched at once; more risks GitHub's secondary rate limits. */
const CONCURRENCY = 8;

/** Maps `items` through `fn`, running at most `limit` at a time, keeping order. */
const mapLimited = async <T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> => {
  const results: R[] = [];
  let next = 0;
  const worker = async () => {
    for (let index = next++; index < items.length; index = next++) {
      results[index] = await fn(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: limit }, worker));
  return results;
};

/** `owner/name` from an API repo URL like https://api.github.com/repos/owner/name. */
const repoName = (url: string) => url.split('/').slice(-2).join('/');

const gh = (args: string[]): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(
      'gh',
      args,
      { maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (!error) return resolve(stdout);
        reject(
          new TrackerError(
            'code' in error && error.code === 'ENOENT'
              ? 'gh is not installed. Install the GitHub CLI (https://cli.github.com) and run `gh auth login`.'
              : `GitHub request failed: ${stderr.trim() || error.message}\nCheck \`gh auth status\` and that this directory is a clone of a GitHub repo.`
          )
        );
      }
    );
  });

/** Parses `gh api --paginate --jq` output: one JSON value per line. */
const jsonLines = <T>(output: string): T[] =>
  output
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as T);

/**
 * GitHub Issues through the `gh` CLI, with blockers from GitHub's native
 * issue dependencies ("blocked by").
 */
export class GitHubTracker implements Tracker {
  /** `owner/name`; by default gh resolves the repo from the current directory's git remote. */
  readonly #repo: string | undefined;

  constructor(repo?: string) {
    this.#repo = repo;
  }

  async openTickets(): Promise<Ticket[]> {
    const issues = jsonLines<ListedIssue>(
      await gh([
        'api',
        '--paginate',
        `repos/${this.#apiRepo}/issues?state=open&per_page=100`,
        '--jq',
        '.[] | select(.pull_request == null) | {number, title, body: (.body // ""), labels: [.labels[].name], repositoryUrl: .repository_url, totalBlockedBy: .issue_dependencies_summary.total_blocked_by}',
      ])
    );
    const tickets = await mapLimited(
      issues,
      CONCURRENCY,
      async ({
        number,
        title,
        body,
        labels,
        repositoryUrl,
        totalBlockedBy,
      }) => ({
        number,
        title,
        body,
        labels,
        // Fetch blockers unless GitHub says there are none, so a missing summary can't hide one.
        blockedBy:
          totalBlockedBy === 0
            ? []
            : await this.#blockers(number, repositoryUrl),
      })
    );
    return tickets.sort((a, b) => a.number - b.number);
  }

  async addLabel(ticket: number, label: string): Promise<void> {
    await gh([
      'issue',
      'edit',
      String(ticket),
      '--add-label',
      label,
      ...this.#repoFlag,
    ]);
  }

  async removeLabel(ticket: number, label: string): Promise<void> {
    await gh([
      'issue',
      'edit',
      String(ticket),
      '--remove-label',
      label,
      ...this.#repoFlag,
    ]);
  }

  async comment(ticket: number, body: string): Promise<void> {
    await gh([
      'issue',
      'comment',
      String(ticket),
      '--body',
      body,
      ...this.#repoFlag,
    ]);
  }

  async close(ticket: number): Promise<void> {
    // gh exits 0 on an issue that's already closed, e.g. by its PR merging.
    await gh(['issue', 'close', String(ticket), ...this.#repoFlag]);
  }

  async #blockers(ticket: number, ownRepoUrl: string): Promise<Blocker[]> {
    const blockers = jsonLines<ListedBlocker>(
      await gh([
        'api',
        '--paginate',
        `repos/${this.#apiRepo}/issues/${ticket}/dependencies/blocked_by?per_page=100`,
        '--jq',
        '.[] | {number, open: (.state == "open"), repositoryUrl: .repository_url}',
      ])
    );
    return blockers.map(({ number, open, repositoryUrl }) =>
      repositoryUrl === ownRepoUrl
        ? { number, open }
        : { number, open, repo: repoName(repositoryUrl) }
    );
  }

  get #apiRepo() {
    return this.#repo ?? '{owner}/{repo}';
  }

  get #repoFlag() {
    return this.#repo === undefined ? [] : ['-R', this.#repo];
  }
}
