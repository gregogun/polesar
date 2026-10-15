/**
 * The Executor port on Sandcastle: Claude Code agents in a Docker sandbox on
 * a git worktree of the ticket branch. The implementer and the reviewer share
 * one warm sandbox per branch. Only the Claude OAuth token enters it, never a
 * GitHub token: only polesar, on the host, talks to GitHub.
 */
import {
  claudeCode,
  createSandbox,
  type AgentStreamEvent,
  type Sandbox,
  type SandboxRunResult,
} from '@ai-hero/sandcastle';
import { docker } from '@ai-hero/sandcastle/sandboxes/docker';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  EVIDENCE_PATH,
  implementerPrompt,
  parseVerdict,
  reviewerPrompt,
} from './agent-prompts.ts';
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
import { isRecord } from './config.ts';

const TOKEN = 'CLAUDE_CODE_OAUTH_TOKEN';

/**
 * Kept out of git in every checkout of the repo: the evidence file, which is
 * never committed, and the worktrees Sandcastle makes in the main checkout.
 */
const EXCLUDED = ['/.polesar/', '/.sandcastle/worktrees/'];

/** The model and effort each role runs at; a ticket's labels override the implementer's. */
const DEFAULTS = {
  implementer: { model: 'sonnet', effort: 'medium' },
  reviewer: { model: 'opus', effort: 'medium' },
} as const satisfies Record<string, { model: string; effort: Effort }>;

/** Lets the reviewer re-emit a verdict polesar couldn't read, once. */
const VERDICT_RETRIES = 1;

const execFileAsync = promisify(execFile);

const git = async (cwd: string, ...args: string[]) =>
  (await execFileAsync('git', args, { cwd, maxBuffer: 256 * 1024 * 1024 }))
    .stdout;

/** A command's output as its non-empty lines. */
const lines = (output: string) =>
  output.split('\n').filter((line) => line !== '');

/** The branch checked out in `worktree`; empty when HEAD is detached. */
const currentBranch = async (worktree: string) =>
  (
    await git(worktree, 'symbolic-ref', '--quiet', '--short', 'HEAD').catch(
      () => ''
    )
  ).trim();

/** Tracked and untracked changes in `worktree`, not counting ignored files. */
const worktreeStatus = (worktree: string) =>
  git(worktree, 'status', '--porcelain', '--untracked-files=all');

const describeError = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

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

/**
 * The repo's branches and tags and what they point at, to tell when an agent
 * moved one. Remote-tracking refs and the stash are left out: work on the
 * host, like a fetch, moves those, and the agent can't push.
 */
const snapshotRefs = async (cwd: string) =>
  new Map(
    lines(
      await git(
        cwd,
        'for-each-ref',
        '--format=%(refname) %(objectname)',
        'refs/heads',
        'refs/tags'
      )
    ).map((line) => line.split(' ') as [string, string])
  );

const changedRefs = (
  before: Map<string, string>,
  after: Map<string, string>,
  except: string
) =>
  [...new Set([...before.keys(), ...after.keys()])].filter(
    (ref) => ref !== except && before.get(ref) !== after.get(ref)
  );

const CHANGE_KINDS: Record<string, FileChange['change']> = {
  A: 'added',
  D: 'deleted',
};

export class SandcastleExecutor implements Executor {
  readonly #cwd: string;
  readonly #base: string;
  readonly #token: string;
  readonly #logs: string;
  /**
   * Where each branch stood after the implementer last ran, so a retry's diff
   * shows only what's new. Kept in polesar's home: a paused or failed run
   * resumes in another process.
   */
  readonly #heads: string;
  readonly #sandboxes = new Map<string, Promise<Sandbox>>();

  private constructor(cwd: string, base: string, token: string, home: string) {
    this.#cwd = cwd;
    this.#base = base;
    this.#token = token;
    this.#logs = path.join(home, 'logs', repoKey(cwd));
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
      const exclude = path.resolve(
        cwd,
        (await git(cwd, 'rev-parse', '--git-common-dir')).trim(),
        'info',
        'exclude'
      );
      const excluded = await readFile(exclude, 'utf8').catch(() => '');
      const missing = EXCLUDED.filter(
        (pattern) => !excluded.split('\n').includes(pattern)
      );
      if (missing.length > 0) {
        await mkdir(path.dirname(exclude), { recursive: true });
        await appendFile(
          exclude,
          `${excluded === '' || excluded.endsWith('\n') ? '' : '\n'}${missing.join('\n')}\n`
        );
      }
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
    const sandbox = await this.#sandbox(branch);
    const worktree = sandbox.worktreePath;
    const mergeBase = (
      await git(worktree, 'merge-base', this.#base, 'HEAD')
    ).trim();
    const heads = await this.#readHeads();
    const since = heads[branch] ?? mergeBase;
    const refs = await snapshotRefs(worktree);
    const agent = await this.#run(sandbox, {
      role: 'implementer',
      ticket: ticket.number,
      prompt: implementerPrompt(input),
      model: input.model ?? DEFAULTS.implementer.model,
      effort: input.effort ?? DEFAULTS.implementer.effort,
      maxTurns: input.maxTurns,
    });
    const current = await currentBranch(worktree);
    const moved = changedRefs(
      refs,
      await snapshotRefs(worktree),
      `refs/heads/${branch}`
    );
    if (current !== branch || moved.length > 0) {
      throw new ExecutorError(
        `the implementer left ${branch}${current === branch ? '' : ` (HEAD is ${current || 'detached'})`}${moved.length > 0 ? ` and changed ${moved.join(', ')}` : ''}; check the repo before running polesar loop again`
      );
    }
    if (agent.interrupted && 'rateLimited' in agent.interrupted) {
      return agent.interrupted;
    }
    heads[branch] = (await git(worktree, 'rev-parse', 'HEAD')).trim();
    await writeJsonAtomically(this.#heads, heads);
    return {
      commits: lines(
        await git(worktree, 'rev-list', '--reverse', `${mergeBase}..HEAD`)
      ),
      diff: await git(worktree, 'diff', `${since}..HEAD`),
      changes: lines(
        await git(
          worktree,
          'diff',
          '--name-status',
          '--no-renames',
          `${mergeBase}..HEAD`
        )
      ).map((line) => {
        const [kind = '', file = ''] = line.split('\t');
        return {
          path: file,
          change: CHANGE_KINDS[kind[0] ?? ''] ?? 'modified',
        };
      }),
      evidence: await this.#evidence(worktree),
      transcript: agent.transcript,
      turns: agent.turns,
      capHit: agent.interrupted !== undefined,
    };
  }

  async review(input: ReviewInput): Promise<Review | RateLimited> {
    const sandbox = await this.#sandbox(input.branch);
    const worktree = sandbox.worktreePath;
    const before = {
      refs: await snapshotRefs(worktree),
      status: await worktreeStatus(worktree),
      evidence: await this.#evidence(worktree),
    };
    let prompt = reviewerPrompt(input);
    let turns = 0;
    for (let attempt = 0; ; attempt++) {
      if (turns >= input.maxTurns) return { findings: [], turns, capHit: true };
      const agent = await this.#run(sandbox, {
        role: 'reviewer',
        ticket: input.ticket.number,
        prompt,
        ...DEFAULTS.reviewer,
        maxTurns: input.maxTurns - turns,
      });
      turns += agent.turns;
      const wrote = await this.#restoreIfWritten(
        worktree,
        input.branch,
        before
      );
      if (wrote)
        return { findings: [], turns, capHit: false, wroteToBranch: true };
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

  /** Tears down every sandbox this executor started. A clean worktree goes with it; the branch stays. */
  async close(): Promise<void> {
    const sandboxes = [...this.#sandboxes.values()];
    this.#sandboxes.clear();
    await Promise.allSettled(
      sandboxes.map(async (sandbox) => (await sandbox).close())
    );
  }

  /** The warm sandbox for `branch`, started on first use. */
  #sandbox(branch: string): Promise<Sandbox> {
    let sandbox = this.#sandboxes.get(branch);
    if (sandbox === undefined) {
      const skills = path.join(homedir(), '.claude', 'skills');
      sandbox = createSandbox({
        branch,
        baseBranch: this.#base,
        cwd: this.#cwd,
        sandbox: docker({
          env: { [TOKEN]: this.#token },
          mounts: existsSync(skills)
            ? [
                {
                  hostPath: skills,
                  sandboxPath: '~/.claude/skills',
                  readonly: true,
                },
              ]
            : [],
        }),
      }).catch((error: unknown) => {
        this.#sandboxes.delete(branch);
        throw new ExecutorError(
          `the sandbox for ${branch} wouldn't start: ${describeError(error)}`
        );
      });
      this.#sandboxes.set(branch, sandbox);
    }
    return sandbox;
  }

  /**
   * Runs one agent in `sandbox`, counting its turns from the stream and
   * cutting it short at `maxTurns` or on a rate limit. Any other failure is
   * one polesar can't explain.
   */
  async #run(
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

  /** The evidence file in `worktree`; null when there is none. */
  async #evidence(worktree: string): Promise<string | null> {
    try {
      return await readFile(path.join(worktree, EVIDENCE_PATH), 'utf8');
    } catch {
      return null;
    }
  }

  /**
   * Whether the reviewer changed the repo since `before`. If it did, puts
   * everything back: refs, the branch's checkout, untracked files and the
   * evidence file.
   */
  async #restoreIfWritten(
    worktree: string,
    branch: string,
    before: {
      refs: Map<string, string>;
      status: string;
      evidence: string | null;
    }
  ): Promise<boolean> {
    const after = await snapshotRefs(worktree);
    const moved = changedRefs(before.refs, after, '');
    const status = await worktreeStatus(worktree);
    const onBranch = (await currentBranch(worktree)) === branch;
    const evidence = await this.#evidence(worktree);
    if (
      moved.length === 0 &&
      status === before.status &&
      onBranch &&
      evidence === before.evidence
    ) {
      return false;
    }
    for (const ref of moved) {
      const was = before.refs.get(ref);
      await (was === undefined
        ? git(worktree, 'update-ref', '-d', ref)
        : git(worktree, 'update-ref', ref, was));
    }
    await git(worktree, 'checkout', '--force', branch);
    await git(worktree, 'reset', '--hard', 'HEAD');
    await git(worktree, 'clean', '-fd');
    const file = path.join(worktree, EVIDENCE_PATH);
    if (before.evidence === null) {
      await rm(file, { force: true });
    } else {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, before.evidence);
    }
    return true;
  }
}
