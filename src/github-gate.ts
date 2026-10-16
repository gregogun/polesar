/**
 * The `ci` gate: GitHub pull requests and their required checks, through the
 * `gh` CLI. It pushes the ticket branch, opens or reuses its PR, waits for the
 * required checks on the commit it pushed, reruns only the failed ones when
 * asked, and merges through GitHub so branch protection applies. It never
 * labels, comments on or closes a ticket: the PR body's closing reference
 * closes it when the loop decides to merge.
 */
import { execFile } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  ConfigError,
  findConfig,
  isRecord,
  MissingConfigError,
  readConfig,
} from './config.ts';
import {
  GateError,
  type Gate,
  type GateInput,
  type GateResult,
} from './gate.ts';

type Run = { code: number; stdout: string; stderr: string };

/** Runs `command`, resolving with its output whatever it exits with. */
const run = (command: string, args: string[], cwd: string): Promise<Run> =>
  new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { cwd, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error && 'code' in error && error.code === 'ENOENT') {
          return reject(
            new GateError(
              command === 'gh'
                ? 'gh is not installed. Install the GitHub CLI (https://cli.github.com) and run `gh auth login`.'
                : `${command} is not installed.`
            )
          );
        }
        const code =
          error === null ? 0 : typeof error.code === 'number' ? error.code : 1;
        resolve({ code, stdout, stderr });
      }
    );
  });

const failure = (result: Run) =>
  result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`;

/** A check as `gh pr checks --json` reports it. */
type Check = {
  name: string;
  /** pass, fail, pending, skipping or cancel. */
  bucket: string;
  description: string;
  link: string;
  workflow: string;
};

const CHECK_FIELDS = 'name,bucket,description,link,workflow';

const isFailed = ({ bucket }: Check) =>
  bucket === 'fail' || bucket === 'cancel';
const isPassed = ({ bucket }: Check) =>
  bucket === 'pass' || bucket === 'skipping';

/** The GitHub Actions run and job a check's link points at, if it's one. */
const actionsJob = (link: string) => {
  const match = /\/actions\/runs\/(\d+)(?:\/job\/(\d+))?/.exec(link);
  return match ? { run: match[1]!, job: match[2] } : undefined;
};

type Job = {
  databaseId: number;
  name: string;
  steps: { name: string; conclusion: string }[];
};

type PullRequest = {
  number: number;
  head: string;
  commits: string[];
  /** The branch it merges into. */
  base: string;
};

const short = (commit: string) => commit.slice(0, 7);

const DEFAULT_TIMEOUT_MINUTES = 30;
const GATE_EXAMPLE = `"gate": ${JSON.stringify({ timeoutMinutes: DEFAULT_TIMEOUT_MINUTES })}`;

/** How long to wait for required checks: `gate.timeoutMinutes` in the nearest polesar.json, or the default. */
const loadTimeoutMinutes = async (cwd: string): Promise<number> => {
  let file: string;
  try {
    file = await findConfig(cwd);
  } catch (error) {
    if (error instanceof MissingConfigError) return DEFAULT_TIMEOUT_MINUTES;
    throw error;
  }
  const config = await readConfig(file);
  const gate = isRecord(config) ? config.gate : undefined;
  if (gate === undefined) return DEFAULT_TIMEOUT_MINUTES;
  const minutes = isRecord(gate)
    ? (gate.timeoutMinutes ?? DEFAULT_TIMEOUT_MINUTES)
    : gate;
  if (typeof minutes !== 'number' || !(minutes > 0)) {
    throw new ConfigError(
      `${file}: "gate.timeoutMinutes" must be a positive number of minutes, e.g.:\n${GATE_EXAMPLE}`
    );
  }
  return minutes;
};

export class GitHubGate implements Gate {
  readonly #cwd: string;
  readonly #timeoutMinutes: number;
  readonly #pollMs: number;

  private constructor(cwd: string, timeoutMinutes: number, pollMs: number) {
    this.#cwd = cwd;
    this.#timeoutMinutes = timeoutMinutes;
    this.#pollMs = pollMs;
  }

  /** The gate for the repo at `cwd`, which pushes to its `origin`; its timeout comes from polesar.json. */
  static async create(
    cwd: string,
    { pollMs = 15_000 }: { pollMs?: number } = {}
  ): Promise<GitHubGate> {
    return new GitHubGate(cwd, await loadTimeoutMinutes(cwd), pollMs);
  }

  async check({ ticket, branch, prBody }: GateInput): Promise<GateResult> {
    const head = await this.#head(branch);
    const pushed = await run(
      'git',
      ['push', 'origin', `${head}:refs/heads/${branch}`],
      this.#cwd
    );
    if (pushed.code !== 0) {
      throw new GateError(
        `couldn't push ${branch} to origin: ${failure(pushed)}\nCheck \`git remote -v\` and that origin's ${branch} holds nothing the local branch lacks.`
      );
    }
    const open = await this.#openPr(branch);
    if (open === undefined) {
      const created = await this.#gh([
        'pr',
        'create',
        '--head',
        branch,
        '--title',
        ticket.title,
        '--body',
        prBody,
      ]);
      const number = Number(/\/pull\/(\d+)/.exec(created)?.[1]);
      if (!Number.isInteger(number)) {
        throw new GateError(
          `gh pr create gave no PR URL for ${branch}: ${created.trim()}`
        );
      }
      return this.#wait(number, head, new Set());
    }
    // The evidence and findings may have changed since the PR was opened.
    await this.#gh(['pr', 'edit', String(open), '--body', prBody]);
    return this.#wait(open, head, new Set());
  }

  async rerun({ branch }: { branch: string }): Promise<GateResult> {
    const pr = await this.#existingPr(branch);
    const head = await this.#head(branch);
    const failed = (await this.#checks(pr)).filter(isFailed);
    const rerun = new Set<string>();
    const runs = new Set<string>();
    for (const check of failed) {
      const job = actionsJob(check.link);
      // Only GitHub Actions runs can be rerun through gh; anything else stays failed.
      if (job === undefined) continue;
      rerun.add(check.link);
      runs.add(job.run);
    }
    for (const id of runs) await this.#gh(['run', 'rerun', id, '--failed']);
    return this.#wait(pr, head, rerun);
  }

  async merge({ branch }: { branch: string }): Promise<void> {
    const pr = await this.#existingPr(branch);
    const head = await this.#head(branch);
    // Not --admin: branch protection decides, and only the commit the gate checked merges.
    const merged = await run(
      'gh',
      ['pr', 'merge', String(pr), '--merge', '--match-head-commit', head],
      this.#cwd
    );
    if (merged.code !== 0) {
      throw new GateError(
        `GitHub would not merge PR #${pr} (${branch}): ${failure(merged)}\nBranch protection applies to polesar too: see the PR on GitHub, then run polesar loop again.`
      );
    }
    // gh exits 0 when it only adds the PR to a merge queue: the loop mustn't close the ticket then.
    const { state } = JSON.parse(
      await this.#gh(['pr', 'view', String(pr), '--json', 'state'])
    ) as { state: string };
    if (state !== 'MERGED') {
      throw new GateError(
        `PR #${pr} (${branch}) is ${state}, not merged: GitHub may have added it to a merge queue. Once it merges, GitHub closes the ticket; run polesar loop again after.`
      );
    }
  }

  /**
   * Polls until GitHub shows the PR at `head`, every check its base branch
   * requires has reported and every required check has finished, or the
   * timeout. Checks whose links are in `stale` are the failures just rerun,
   * not yet replaced by their new runs.
   */
  async #wait(
    pr: number,
    head: string,
    stale: Set<string>
  ): Promise<GateResult> {
    const deadline = Date.now() + this.#timeoutMinutes * 60_000;
    let required: string[] | undefined;
    for (;;) {
      const view = await this.#view(pr);
      required ??= await this.#required(view.base);
      const checks =
        view.head === head
          ? (await this.#checks(pr)).map((check) =>
              stale.has(check.link) ? { ...check, bucket: 'pending' } : check
            )
          : undefined;
      const done =
        checks !== undefined &&
        required.every((name) => checks.some((check) => check.name === name)) &&
        checks.every((check) => isFailed(check) || isPassed(check));
      if (done) {
        const failed = checks.filter(isFailed);
        return {
          green: failed.length === 0,
          summary:
            failed.length === 0
              ? `required checks passed on ${short(head)}: ${checks.map(({ name }) => name).join(', ')}`
              : `required checks failed on ${short(head)}: ${await this.#describe(failed)}`,
          commits: view.commits,
        };
      }
      if (Date.now() >= deadline) {
        return {
          green: false,
          timedOut: true,
          summary: `timed out after ${this.#timeoutMinutes} min waiting for required checks on ${short(head)}: ${await this.#describeUnfinished({ view, head, checks, required })}`,
          commits: view.commits,
        };
      }
      await sleep(this.#pollMs);
    }
  }

  async #describeUnfinished({
    view,
    head,
    checks,
    required,
  }: {
    view: PullRequest;
    head: string;
    checks: Check[] | undefined;
    required: string[];
  }) {
    if (checks === undefined) {
      return `GitHub shows the PR at ${short(view.head)}, not ${short(head)}`;
    }
    const running = checks.filter(
      (check) => !isFailed(check) && !isPassed(check)
    );
    const missing = required.filter(
      (name) => !checks.some((check) => check.name === name)
    );
    const failed = checks.filter(isFailed);
    return [
      ...(running.length > 0
        ? [`still running: ${running.map(({ name }) => name).join(', ')}`]
        : []),
      ...(missing.length > 0
        ? [`not reported yet: ${missing.join(', ')}`]
        : []),
      ...(failed.length > 0 ? [await this.#describe(failed)] : []),
    ].join('; ');
  }

  /**
   * The status checks `base` requires, from its rulesets and its classic
   * branch protection. None is a setup error: the gate could never tell
   * green from untested.
   */
  async #required(base: string): Promise<string[]> {
    const rules = JSON.parse(
      await this.#gh(['api', `repos/{owner}/{repo}/rules/branches/${base}`])
    ) as {
      type: string;
      parameters?: { required_status_checks?: { context: string }[] };
    }[];
    // The branch itself, not its protection endpoint: reading that needs admin rights.
    const branch = JSON.parse(
      await this.#gh(['api', `repos/{owner}/{repo}/branches/${base}`])
    ) as { protection?: { required_status_checks?: { contexts?: string[] } } };
    const names = new Set([
      ...rules
        .filter(({ type }) => type === 'required_status_checks')
        .flatMap(
          ({ parameters }) =>
            parameters?.required_status_checks?.map(({ context }) => context) ??
            []
        ),
      ...(branch.protection?.required_status_checks?.contexts ?? []),
    ]);
    if (names.size === 0) {
      throw new GateError(
        `${base} requires no status checks, so the gate can't tell green from untested. Require status checks on ${base} (a ruleset or branch protection), then run polesar loop again.`
      );
    }
    return [...names];
  }

  /** Each failed check, briefly: its name, the step that failed (for GitHub Actions) or its description, and its link. */
  async #describe(failed: Check[]): Promise<string> {
    const jobs = new Map<string, Job[]>();
    const jobsOf = async (id: string) => {
      if (!jobs.has(id)) {
        const result = await run(
          'gh',
          ['run', 'view', id, '--json', 'jobs'],
          this.#cwd
        );
        // Unreadable, the run's failed step is left out: the description and link still say enough.
        jobs.set(
          id,
          result.code === 0
            ? (JSON.parse(result.stdout) as { jobs: Job[] }).jobs
            : []
        );
      }
      return jobs.get(id)!;
    };
    const described = await Promise.all(
      failed.map(async (check) => {
        const job = actionsJob(check.link);
        let why = check.description ? `: ${check.description}` : '';
        if (job !== undefined) {
          const all = await jobsOf(job.run);
          const found =
            all.find(({ databaseId }) => String(databaseId) === job.job) ??
            all.find(({ name }) => name === check.name);
          const step = found?.steps.find(
            ({ conclusion }) => conclusion === 'failure'
          );
          if (step) why = ` at step "${step.name}"`;
        }
        const name = check.workflow
          ? `${check.name} (${check.workflow})`
          : check.name;
        const verb = check.bucket === 'cancel' ? 'was cancelled' : 'failed';
        const link = check.link ? ` (${check.link})` : '';
        return `${name} ${verb}${why}${link}`;
      })
    );
    return described.join('; ');
  }

  /** The required checks on the PR's head; none while GitHub has yet to report any. */
  async #checks(pr: number): Promise<Check[]> {
    const result = await run(
      'gh',
      ['pr', 'checks', String(pr), '--required', '--json', CHECK_FIELDS],
      this.#cwd
    );
    // With --json, gh prints the checks and exits 0 whatever their state; with none reported yet it exits 1.
    try {
      const checks: unknown = JSON.parse(result.stdout);
      if (Array.isArray(checks)) return checks as Check[];
    } catch {
      // Not JSON: an error, or no checks yet.
    }
    // Required checks are known from the base branch: none reported yet means they're on their way.
    if (/no (required )?checks reported/.test(result.stderr)) return [];
    throw new GateError(
      `couldn't read the checks on PR #${pr}: ${failure(result)}\nCheck \`gh auth status\`.`
    );
  }

  async #view(pr: number): Promise<PullRequest> {
    const { headRefOid, commits, baseRefName } = JSON.parse(
      await this.#gh([
        'pr',
        'view',
        String(pr),
        '--json',
        'headRefOid,commits,baseRefName',
      ])
    ) as {
      headRefOid: string;
      commits: { oid: string }[];
      baseRefName: string;
    };
    return {
      number: pr,
      head: headRefOid,
      commits: commits.map(({ oid }) => oid),
      base: baseRefName,
    };
  }

  async #openPr(branch: string): Promise<number | undefined> {
    const prs = JSON.parse(
      await this.#gh([
        'pr',
        'list',
        '--head',
        branch,
        '--state',
        'open',
        '--json',
        'number',
      ])
    ) as { number: number }[];
    return prs[0]?.number;
  }

  async #existingPr(branch: string): Promise<number> {
    const pr = await this.#openPr(branch);
    if (pr === undefined) {
      throw new GateError(
        `no open PR for ${branch} on GitHub: it was closed or merged outside polesar. Look at it on GitHub, then run polesar loop again.`
      );
    }
    return pr;
  }

  /** The commit the local branch points at: what the gate pushes, checks and merges. */
  async #head(branch: string): Promise<string> {
    const result = await run(
      'git',
      ['rev-parse', '--verify', `refs/heads/${branch}^{commit}`],
      this.#cwd
    );
    if (result.code !== 0) {
      throw new GateError(`no local branch ${branch}: ${failure(result)}`);
    }
    return result.stdout.trim();
  }

  async #gh(args: string[]): Promise<string> {
    const result = await run('gh', args, this.#cwd);
    if (result.code !== 0) {
      throw new GateError(
        `GitHub request failed (gh ${args.slice(0, 2).join(' ')}): ${failure(result)}\nCheck \`gh auth status\` and that this directory is a clone of a GitHub repo.`
      );
    }
    return result.stdout;
  }
}
