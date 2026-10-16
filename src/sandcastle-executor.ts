/**
 * The Executor port on Sandcastle: Claude Code agents in a Docker sandbox on
 * a git worktree of the ticket branch. The implementer and the reviewer share
 * one warm sandbox per branch. Only the Claude OAuth token enters it, never a
 * GitHub token: only polesar, on the host, talks to GitHub.
 *
 * The host never runs git where an agent could have rigged it. Each sandbox
 * works in a throwaway clone under polesar's home, so the repo's own .git
 * (its config, hooks and other branches) never enters the sandbox. polesar
 * inspects the agent's work inside the sandbox, and brings commits back as a
 * git bundle fetched into the repo: on the host, git only ever reads that
 * file.
 */
import {
  claudeCode,
  createWorktree,
  type AgentStreamEvent,
  type Sandbox,
  type SandboxRunResult,
} from '@ai-hero/sandcastle';
import { defaultImageName, docker } from '@ai-hero/sandcastle/sandboxes/docker';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  appendFile,
  lstat,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  EVIDENCE_PATH,
  implementerPrompt,
  parseVerdict,
  reviewerPrompt,
} from './agent-prompts.ts';
import { isRecord } from './config.ts';
import {
  ExecutorError,
  type Effort,
  type Executor,
  type FileChange,
  type ImplementInput,
  type Implementation,
  type RateLimited,
  type Review,
  type ReviewInput,
} from './executor.ts';
import { LoopError } from './loop.ts';
import { repoKey } from './paused-run.ts';
import { readJsonIfPresent, writeJsonAtomically } from './usage.ts';

const TOKEN = 'CLAUDE_CODE_OAUTH_TOKEN';

/**
 * Kept out of git in each clone: the evidence file, which is never committed,
 * the bundle that carries commits back, and Sandcastle's worktrees.
 */
const EXCLUDED = ['/.polesar/', '/.sandcastle/'];

/** Where the sandbox leaves the branch's new commits for polesar, relative to the worktree. */
const BUNDLE = '.polesar/branch.bundle';

/** The model and effort each role runs at; a ticket's labels override the implementer's. */
const DEFAULTS = {
  implementer: { model: 'sonnet', effort: 'medium' },
  reviewer: { model: 'opus', effort: 'medium' },
} as const satisfies Record<string, { model: string; effort: Effort }>;

/** Lets the reviewer re-emit a verdict polesar couldn't read, once. */
const VERDICT_RETRIES = 1;

/**
 * Kills every process in the sandbox but its init: an aborted run's agent
 * keeps going otherwise, and so would anything an agent started in the
 * background. As root where the image allows it, to reach what an agent
 * started with sudo.
 */
const STOP_AGENTS =
  'sudo -n kill -KILL -1 2>/dev/null || kill -KILL -1 2>/dev/null; true';

const execFileAsync = promisify(execFile);

const git = async (cwd: string, ...args: string[]) =>
  (await execFileAsync('git', args, { cwd, maxBuffer: 256 * 1024 * 1024 }))
    .stdout;

/** A command's output as its non-empty lines. */
const lines = (output: string) =>
  output.split('\n').filter((line) => line !== '');

/** `value` as one single-quoted shell word. */
const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

const describeError = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/** Runs `command` in the sandbox's checkout of the branch, failing unless it succeeds. */
const inSandbox = async (sandbox: Sandbox, command: string) => {
  let result;
  try {
    result = await sandbox.exec(command);
  } catch (error) {
    throw new ExecutorError(
      `\`${command}\` couldn't run in the sandbox: ${describeError(error)}`
    );
  }
  if (result.exitCode !== 0) {
    throw new ExecutorError(
      `\`${command}\` failed in the sandbox: ${result.stderr.trim() || `exit ${result.exitCode}`}`
    );
  }
  return result.stdout;
};

/**
 * The branches and tags in the sandbox's clone and what they point at, to
 * tell when an agent moved one.
 */
const REFS =
  "git for-each-ref --format='%(refname) %(objectname)' refs/heads refs/tags";

const snapshotRefs = async (sandbox: Sandbox) =>
  new Map(
    lines(await inSandbox(sandbox, REFS)).map(
      (line) => line.split(' ') as [string, string]
    )
  );

const changedRefs = (
  before: Map<string, string>,
  after: Map<string, string>,
  except: string
) =>
  [...new Set([...before.keys(), ...after.keys()])].filter(
    (ref) => ref !== except && before.get(ref) !== after.get(ref)
  );

/** The branch checked out in the sandbox; empty when HEAD is detached. */
const currentBranch = async (sandbox: Sandbox) =>
  (
    await inSandbox(sandbox, 'git symbolic-ref --quiet --short HEAD || true')
  ).trim();

/**
 * The file at `relative` in `root`, read on the host; null when it's missing
 * or isn't a plain file inside `root`. An agent can make the path a symlink,
 * and polesar mustn't follow it to the host's own files.
 */
const readInside = async (
  root: string,
  relative: string
): Promise<Buffer | null> => {
  try {
    const inside = await realpath(root);
    const file = await realpath(path.join(root, relative));
    if (
      !file.startsWith(`${inside}${path.sep}`) ||
      !(await lstat(file)).isFile()
    ) {
      return null;
    }
    return await readFile(file);
  } catch {
    return null;
  }
};

/**
 * The keys `.sandcastle/.env` would pass into the sandbox. Sandcastle forwards
 * each one, falling back to polesar's own environment, so any key but the
 * Claude token could hand the agent a GitHub token.
 */
const sandboxEnvKeys = async (cwd: string) => {
  let text: string;
  try {
    text = await readFile(path.join(cwd, '.sandcastle', '.env'), 'utf8');
  } catch {
    return [];
  }
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
    .map(
      (line) =>
        line
          .replace(/^export\s+/, '')
          .split('=')[0]
          ?.trim() ?? ''
    );
};

type InterruptReason = { capHit: true } | RateLimited;

/** Why an agent run was cut short by polesar rather than by the agent. */
class Interrupt {
  readonly reason: InterruptReason;

  constructor(reason: InterruptReason) {
    this.reason = reason;
  }
}

/** One line of Claude Code's stream-json output, as far as polesar reads it. */
type StreamLine = {
  type?: string;
  message?: { id?: string };
  rate_limit_info?: { status?: string; resetsAt?: number | string };
};

const parseLine = (line: string): StreamLine | undefined => {
  try {
    const parsed: unknown = JSON.parse(line);
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as StreamLine)
      : undefined;
  } catch {
    return undefined;
  }
};

/** A rate_limit_event's reset time as ISO, an hour from now if it gives none. */
const resetTime = (resetsAt: number | string | undefined) => {
  if (typeof resetsAt === 'number')
    return new Date(resetsAt * 1000).toISOString();
  if (typeof resetsAt === 'string' && !Number.isNaN(Date.parse(resetsAt))) {
    return new Date(resetsAt).toISOString();
  }
  return new Date(Date.now() + 60 * 60 * 1000).toISOString();
};

/** What an agent run came to: its result, or how polesar cut it short, and the turns it took. */
type AgentRun = {
  result: SandboxRunResult | undefined;
  interrupted: InterruptReason | undefined;
  turns: number;
  transcript: string;
};

/** A ticket branch's throwaway clone and the warm sandbox working in it. */
type Workspace = {
  clone: string;
  sandbox: Sandbox;
  /** The commit the repo last had for the branch: the bundle's base. */
  known: string;
};

const CHANGE_KINDS: Record<string, FileChange['change']> = {
  A: 'added',
  D: 'deleted',
};

export class SandcastleExecutor implements Executor {
  readonly #cwd: string;
  readonly #base: string;
  readonly #token: string;
  readonly #logs: string;
  readonly #clones: string;
  /**
   * Where each branch stood after the implementer last ran, so a retry's diff
   * shows only what's new. Kept in polesar's home: a paused or failed run
   * resumes in another process.
   */
  readonly #heads: string;
  readonly #workspaces = new Map<string, Promise<Workspace>>();

  private constructor(cwd: string, base: string, token: string, home: string) {
    this.#cwd = cwd;
    this.#base = base;
    this.#token = token;
    this.#logs = path.join(home, 'logs', repoKey(cwd));
    this.#clones = path.join(home, 'clones', repoKey(cwd));
    this.#heads = path.join(home, 'heads', `${repoKey(cwd)}.json`);
  }

  /**
   * An executor for the repo at `cwd`, branching tickets off its current
   * branch. Fails with what to do when the token is missing or the sandbox
   * could be handed anything else.
   */
  static async create(
    cwd: string,
    home: string,
    env: NodeJS.ProcessEnv = process.env
  ): Promise<SandcastleExecutor> {
    const token = env[TOKEN];
    if (token === undefined || token === '') {
      throw new LoopError(
        `polesar loop needs ${TOKEN} for its agents: run \`claude setup-token\` and export the token it prints as ${TOKEN}.`
      );
    }
    const extra = (await sandboxEnvKeys(cwd)).filter((key) => key !== TOKEN);
    if (extra.length > 0) {
      throw new LoopError(
        `.sandcastle/.env passes ${extra.join(', ')} into the agents' sandbox; only ${TOKEN} may enter it, so a GitHub token can't. Remove the other keys.`
      );
    }
    let base: string;
    try {
      base = (await git(cwd, 'symbolic-ref', '--short', 'HEAD')).trim();
    } catch (error) {
      throw new LoopError(
        `polesar loop runs from a git checkout with a branch checked out: ${describeError(error)}`
      );
    }
    return new SandcastleExecutor(cwd, base, token, home);
  }

  async implement(
    input: ImplementInput
  ): Promise<Implementation | RateLimited> {
    const { branch, ticket } = input;
    const workspace = await this.#workspace(branch);
    const { sandbox } = workspace;
    const heads = await this.#readHeads();
    const refs = await snapshotRefs(sandbox);
    const agent = await this.#run(branch, sandbox, {
      role: 'implementer',
      ticket: ticket.number,
      prompt: implementerPrompt(input),
      model: input.model ?? DEFAULTS.implementer.model,
      effort: input.effort ?? DEFAULTS.implementer.effort,
      maxTurns: input.maxTurns,
    });
    const current = await currentBranch(sandbox);
    const moved = changedRefs(
      refs,
      await snapshotRefs(sandbox),
      `refs/heads/${branch}`
    );
    if (current !== branch || moved.length > 0) {
      await this.#discard(branch);
      throw new ExecutorError(
        `the implementer left ${branch}${current === branch ? '' : ` (HEAD is ${current || 'detached'})`}${moved.length > 0 ? ` and changed ${moved.join(', ')}` : ''}; polesar discarded its sandbox, and nothing from that run reached the repo`
      );
    }
    const evidence = await this.#evidence(sandbox);
    await this.#bringBack(branch, workspace);
    if (agent.interrupted && 'rateLimited' in agent.interrupted) {
      return agent.interrupted;
    }
    const mergeBase = (
      await git(this.#cwd, 'merge-base', this.#base, branch)
    ).trim();
    const since = heads[branch] ?? mergeBase;
    heads[branch] = workspace.known;
    await writeJsonAtomically(this.#heads, heads);
    return {
      commits: lines(
        await git(this.#cwd, 'rev-list', '--reverse', `${mergeBase}..${branch}`)
      ),
      diff: await git(this.#cwd, 'diff', `${since}..${branch}`),
      changes: lines(
        await git(
          this.#cwd,
          'diff',
          '--name-status',
          '--no-renames',
          `${mergeBase}..${branch}`
        )
      ).map((line) => {
        const [kind = '', file = ''] = line.split('\t');
        return {
          path: file,
          change: CHANGE_KINDS[kind[0] ?? ''] ?? 'modified',
        };
      }),
      evidence,
      transcript: agent.transcript,
      turns: agent.turns,
      capHit: agent.interrupted !== undefined,
    };
  }

  async review(input: ReviewInput): Promise<Review | RateLimited> {
    const { sandbox } = await this.#workspace(input.branch);
    const before = await this.#snapshot(sandbox);
    let prompt = reviewerPrompt(input);
    let turns = 0;
    for (let attempt = 0; ; attempt++) {
      if (turns >= input.maxTurns) return { findings: [], turns, capHit: true };
      const agent = await this.#run(input.branch, sandbox, {
        role: 'reviewer',
        ticket: input.ticket.number,
        prompt,
        ...DEFAULTS.reviewer,
        maxTurns: input.maxTurns - turns,
      });
      turns += agent.turns;
      // Nothing the reviewer did reaches the repo: polesar fetches only what
      // the implementer commits. Discarding the sandbox drops it for good.
      if ((await this.#snapshot(sandbox)) !== before) {
        await this.#discard(input.branch);
        return { findings: [], turns, capHit: false, wroteToBranch: true };
      }
      if (agent.interrupted && 'rateLimited' in agent.interrupted) {
        return agent.interrupted;
      }
      if (agent.interrupted) return { findings: [], turns, capHit: true };
      const verdict = parseVerdict(agent.result?.stdout ?? '');
      if (!('error' in verdict)) return { ...verdict, turns, capHit: false };
      if (attempt === VERDICT_RETRIES) {
        throw new ExecutorError(
          `the reviewer gave no usable verdict: ${verdict.error}`
        );
      }
      prompt = `${reviewerPrompt(input)}\n\nYour last answer couldn't be read: ${verdict.error}. Review again and end with the <review> JSON exactly as described.`;
    }
  }

  /** Removes every sandbox this executor started, and its clone. The branches stay in the repo. */
  async close(): Promise<void> {
    await Promise.allSettled(
      [...this.#workspaces.keys()].map((branch) => this.#discard(branch))
    );
  }

  /** The warm sandbox for `branch`, started on first use. */
  #workspace(branch: string): Promise<Workspace> {
    let workspace = this.#workspaces.get(branch);
    if (workspace === undefined) {
      workspace = this.#startWorkspace(branch).catch((error: unknown) => {
        this.#workspaces.delete(branch);
        throw new ExecutorError(
          `the sandbox for ${branch} wouldn't start: ${describeError(error)}`
        );
      });
      this.#workspaces.set(branch, workspace);
    }
    return workspace;
  }

  /**
   * A fresh clone of the repo with `branch` as the repo has it, and a sandbox
   * on a worktree of it. Every git command polesar runs in the clone runs
   * here, before any agent has been near it.
   */
  async #startWorkspace(branch: string): Promise<Workspace> {
    const clone = path.join(this.#clones, branch.replaceAll('/', '-'));
    await rm(clone, { recursive: true, force: true });
    await mkdir(this.#clones, { recursive: true });
    const known = (
      await git(
        this.#cwd,
        'rev-parse',
        '--verify',
        `${(await this.#hasBranch(branch)) ? branch : this.#base}^{commit}`
      )
    ).trim();
    // --no-local copies the objects rather than hard-linking them, so what an
    // agent does to the clone's files can't reach the repo's.
    await git(
      this.#cwd,
      'clone',
      '--quiet',
      '--no-local',
      '--branch',
      this.#base,
      this.#cwd,
      clone
    );
    await git(clone, 'branch', branch, known);
    // The clone keeps no path back to the repo.
    await git(clone, 'remote', 'remove', 'origin');
    await appendFile(
      path.join(clone, '.git', 'info', 'exclude'),
      `${EXCLUDED.join('\n')}\n`
    );
    const worktree = await createWorktree({
      branchStrategy: { type: 'branch', branch },
      cwd: clone,
    });
    const skills = path.join(homedir(), '.claude', 'skills');
    // A sandbox made from a worktree only removes its container on close:
    // unlike createSandbox's, it runs no git on the host in a worktree the
    // agent has had. The clone's config and hooks are read-only in the
    // sandbox, since Sandcastle reads the clone's HEAD on the host each run.
    const sandbox = await worktree.createSandbox({
      sandbox: docker({
        imageName: defaultImageName(this.#cwd),
        env: { [TOKEN]: this.#token },
        mounts: [
          ...['config', 'hooks'].map((file) => {
            const gitPath = path.join(clone, '.git', file);
            return { hostPath: gitPath, sandboxPath: gitPath, readonly: true };
          }),
          ...(existsSync(skills)
            ? [
                {
                  hostPath: skills,
                  sandboxPath: '~/.claude/skills',
                  readonly: true,
                },
              ]
            : []),
        ],
      }),
    });
    return { clone, sandbox, known };
  }

  /** Removes `branch`'s sandbox and its clone, if it has one. */
  async #discard(branch: string): Promise<void> {
    const workspace = this.#workspaces.get(branch);
    this.#workspaces.delete(branch);
    const started = await workspace?.catch(() => undefined);
    if (started === undefined) return;
    await started.sandbox.close().catch(() => undefined);
    await rm(started.clone, { recursive: true, force: true });
  }

  async #hasBranch(branch: string) {
    return git(
      this.#cwd,
      'rev-parse',
      '--verify',
      '--quiet',
      `refs/heads/${branch}`
    ).then(
      () => true,
      () => false
    );
  }

  /**
   * Brings `branch` from the sandbox into the repo. The sandbox bundles the
   * commits the repo doesn't have, and the repo fetches the bundle, checking
   * every object: git on the host reads the file and nothing else of the
   * clone's.
   */
  async #bringBack(branch: string, workspace: Workspace): Promise<void> {
    const { sandbox, known } = workspace;
    const ref = `refs/heads/${branch}`;
    const tip = (
      await inSandbox(
        sandbox,
        `git rev-parse --verify ${quote(`${ref}^{commit}`)}`
      )
    ).trim();
    if (tip === known) {
      // No new commits; the repo has `known`, so it can take the branch as is.
      await git(this.#cwd, 'update-ref', ref, known);
      return;
    }
    await inSandbox(
      sandbox,
      `mkdir -p .polesar && git bundle create ${BUNDLE} ${quote(ref)} ^${known}`
    );
    const bundle = await readInside(sandbox.worktreePath, BUNDLE);
    await inSandbox(sandbox, `rm -f ${BUNDLE}`);
    if (bundle === null) {
      throw new ExecutorError(
        `polesar couldn't read ${branch}'s commits back from the sandbox`
      );
    }
    const copy = path.join(
      this.#clones,
      `${branch.replaceAll('/', '-')}.bundle`
    );
    await writeFile(copy, bundle);
    try {
      await git(
        this.#cwd,
        '-c',
        'transfer.fsckObjects=true',
        'fetch',
        '--quiet',
        '--no-tags',
        '--no-write-fetch-head',
        copy,
        `+${ref}:${ref}`
      );
    } catch (error) {
      throw new ExecutorError(
        `polesar couldn't fetch ${branch}'s commits from the sandbox: ${describeError(error)}`
      );
    } finally {
      await rm(copy, { force: true });
    }
    workspace.known = (await git(this.#cwd, 'rev-parse', ref)).trim();
  }

  /**
   * Runs one agent in `sandbox`, counting its turns from the stream and
   * cutting it short at `maxTurns` or on a rate limit. Any other failure is
   * one polesar can't explain. Whatever the agent left running is killed
   * when it ends.
   */
  async #run(
    branch: string,
    sandbox: Sandbox,
    {
      role,
      ticket,
      prompt,
      model,
      effort,
      maxTurns,
    }: {
      role: keyof typeof DEFAULTS;
      ticket: number;
      prompt: string;
      model: string;
      effort: Effort;
      maxTurns: number;
    }
  ): Promise<AgentRun> {
    const controller = new AbortController();
    const messages = new Set<string>();
    const log = path.join(
      this.#logs,
      `${ticket}-${role}-${new Date().toISOString().replaceAll(':', '-')}.log`
    );
    await mkdir(this.#logs, { recursive: true });
    const raw: string[] = [];
    const onAgentStreamEvent = (event: AgentStreamEvent) => {
      if (event.type !== 'raw') return;
      raw.push(event.line);
      const line = parseLine(event.line);
      if (line?.type === 'assistant' && line.message?.id !== undefined) {
        messages.add(line.message.id);
        // The cap allows maxTurns messages: the one past it is cut off.
        if (messages.size > maxTurns && !controller.signal.aborted) {
          controller.abort(new Interrupt({ capHit: true }));
        }
      }
      if (
        line?.type === 'rate_limit_event' &&
        line.rate_limit_info?.status === 'rejected' &&
        !controller.signal.aborted
      ) {
        controller.abort(
          new Interrupt({
            rateLimited: { resetsAt: resetTime(line.rate_limit_info.resetsAt) },
          })
        );
      }
    };
    let result: SandboxRunResult | undefined;
    let interrupted: InterruptReason | undefined;
    try {
      result = await sandbox.run({
        agent: claudeCode(model, { effort }),
        prompt,
        name: `polesar #${ticket} ${role}`,
        signal: controller.signal,
        logging: { type: 'file', path: log, onAgentStreamEvent },
      });
    } catch (error) {
      if (!(error instanceof Interrupt)) {
        throw new ExecutorError(
          `the ${role} run failed: ${describeError(error)} (log: ${log})`
        );
      }
      interrupted = error.reason;
    } finally {
      await this.#stopAgents(branch, sandbox);
    }
    const transcript = raw.join('\n');
    await writeFile(`${log}.jsonl`, transcript);
    return {
      result,
      interrupted,
      turns: Math.min(messages.size, maxTurns),
      transcript,
    };
  }

  /**
   * Kills what's left running in `branch`'s sandbox. Aborting a run only
   * stops polesar waiting on it. If the sandbox can't be reached to do that,
   * polesar removes it, which kills everything in it.
   */
  async #stopAgents(branch: string, sandbox: Sandbox): Promise<void> {
    try {
      await sandbox.exec(STOP_AGENTS);
    } catch (error) {
      await this.#discard(branch);
      throw new ExecutorError(
        `polesar couldn't stop the agent in ${branch}'s sandbox, so it removed the sandbox: ${describeError(error)}`
      );
    }
  }

  /** Where each branch stood after the implementer last ran; a file that can't be read counts as none. */
  async #readHeads(): Promise<Record<string, string>> {
    const heads = await readJsonIfPresent(this.#heads).catch(() => null);
    return isRecord(heads)
      ? Object.fromEntries(
          Object.entries(heads).filter(
            (entry): entry is [string, string] => typeof entry[1] === 'string'
          )
        )
      : {};
  }

  /** The evidence file in the sandbox's checkout; null when there is none. */
  async #evidence(sandbox: Sandbox): Promise<string | null> {
    return (
      (await readInside(sandbox.worktreePath, EVIDENCE_PATH))?.toString(
        'utf8'
      ) ?? null
    );
  }

  /** What a read-only agent must leave as it found it: refs, the checkout, untracked files and the evidence. */
  async #snapshot(sandbox: Sandbox): Promise<string> {
    return JSON.stringify([
      await inSandbox(sandbox, REFS),
      await currentBranch(sandbox),
      await inSandbox(sandbox, 'git status --porcelain --untracked-files=all'),
      await this.#evidence(sandbox),
    ]);
  }
}
