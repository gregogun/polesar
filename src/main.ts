import { readFileSync } from 'node:fs';
import { text } from 'node:stream/consumers';
import { parseArgs, type ParseArgsOptionsConfig } from 'node:util';
import { preToolUseHook, stopHook, type HookResponse } from './hook.ts';
import { ConfigError } from './config.ts';
import { describeFrontier, findFrontier } from './frontier.ts';
import type { Executor } from './executor.ts';
import type { Gate } from './gate.ts';
import type { Usage } from './usage.ts';
import { describeInstall, installHooks } from './install-hooks.ts';
import { LoopError, planLoop, runLoop } from './loop.ts';
import {
  describeOutcome,
  describePlan,
  describeVerdict,
  runSummary,
} from './templates.ts';
import { TrackerError, type Tracker } from './tracker.ts';
import { statusLine } from './statusline.ts';
import { isVerdict, recordVerdict } from './verdict.ts';
import { summarise, verify } from './verify.ts';

const HELP = `Usage: polesar [options]
       polesar <command> [options]

A trust-first policy layer for running coding agents.

Commands:
  verify [--json]  Run the repo's cheap checks, listed under "verify.checks"
                   in the nearest polesar.json up to the git root; checks run
                   from that file's directory. Prints only failing checks:
                   where they failed and a path to the full log. --json gives
                   structured results for every check.
                   Exit: 0 all passed, 1 a check failed, 2 bad usage or config.
  frontier [--json]
                   List the frontier: open ready-for-agent tickets whose
                   blockers (GitHub's native "blocked by") are all closed.
                   ready-for-human tickets are never on it; those holding up
                   AFK work are listed with how many ready-for-agent tickets
                   the loop could then finish on its own (unblocks), how many
                   wait on them in all, and their own open blockers.
                   Reads GitHub Issues via gh for the current directory's repo.
                   --json gives {tickets, humanBlockers}.
                   Exit: 0 listed (even if empty), 1 GitHub couldn't be read,
                   2 bad usage.
  loop [--dry-run] [--json]
                   Work the frontier unattended, one ticket at a time: the
                   implementer (Claude Code, sonnet at medium effort; labels
                   model:<name> and effort:low|medium|high|xhigh|max override
                   them per ticket) commits on polesar/<n> and writes an
                   evidence file, .polesar/evidence.md, never committed. A
                   read-only reviewer (opus, medium effort) judges the
                   ticket, diff, evidence and standards docs (AGENTS.md,
                   CLAUDE.md, GLOSSARY.md, docs/adr/); one that changes the
                   branch has its changes discarded and escalates. Both run
                   in one Docker sandbox per ticket via Sandcastle (its image
                   from \`npx @ai-hero/sandcastle init\`), on a throwaway
                   clone of the repo, with ~/.claude/skills mounted
                   read-only. Only the branch's new commits come back to the
                   repo, as a git bundle. Then the gate runs.
                   Blocking findings go back to the implementer (1 review
                   retry, shared with reviews of later fixes). A red gate is rerun once with no agent; green
                   with no code change is logged as a flaky gate. Still red,
                   it goes back to the implementer with the failure summary
                   (2 CI retries), and only the new change is reviewed.
                   Non-blocking findings go in the PR body and the log.
                   Evidence over 60,000 characters is cut short in the PR
                   body and comments; the full file is saved under
                   POLESAR_HOME/evidence/.
                   polesar merges only when the gate is green, no finding
                   blocks, every commit was reviewed and the evidence exists,
                   then closes the ticket with an evidence comment. A branch
                   that modifies or deletes a protected file (existing tests,
                   verify/lint/typecheck config, hook config, CI workflows)
                   escalates even when green; adding files never does.
                   "protectedPaths": {"add": [...], "remove": [...]} in
                   polesar.json adjusts the default globs. Anything
                   else (no commits, no evidence, a budget used up) escalates:
                   the ticket is relabelled ready-for-human with a comment
                   giving the trail. The loop never applies ready-for-agent.
                   Budget, set under "budget" in polesar.json (defaults):
                   ticketTurns (200) agent turns per ticket across all its
                   runs, escalating when used up; and, as percents of weekly
                   usage, weeklyFloor (70) no new ticket at or above it,
                   loopShare (25) the loop's share per week across runs,
                   runCap (10) per run, each checked before a ticket starts,
                   so the ticket in progress can take a run over. Weekly usage
                   comes from the reading polesar statusline saved; with
                   none, or one older than maxReadingAgeMinutes (30), no
                   ticket starts. A rate limit pauses the run with no retry
                   used and no label changed; run polesar loop after the
                   reset to resume the ticket where it stopped, budget
                   permitting. An agent run that fails any other way (the
                   sandbox won't start, the agent crashes) stops the run the
                   same way, with the ticket untouched; run polesar loop
                   again to resume it.
                   Stops when nothing is left, naming ready-for-human tickets
                   blocking AFK work. --dry-run shows the planned transitions
                   without running agents or changing anything. --json gives
                   {outcomes, humanBlockers, stopped} ({planned,
                   humanBlockers} with --dry-run); stopped.reason is done,
                   budget (with rule and detail), paused (with until and
                   ticket) or failed (with ticket and detail).
                   Exit: 0 every ticket merged (or dry run), 1 a ticket was
                   escalated, an agent run failed, or GitHub couldn't be
                   read, 2 bad usage or config, 3 stopped early by the
                   budget or paused by a rate limit.
  verdict <ticket> approved|rejected [--dry-run] [--json]
                   Record your verdict on polesar's latest escalation of a
                   ticket, as a comment on it for telemetry: approved if the
                   change it held back was fine to merge, rejected if it
                   wasn't. Verdicts on protected-path escalations show which
                   rules can be relaxed. Only you may run it: the PreToolUse
                   hook blocks agents. --dry-run shows what would be recorded.
                   --json gives {ticket, verdict, recorded}.
                   Exit: 0 recorded (or dry run), 1 GitHub couldn't be
                   written, 2 bad usage.
  statusline [--command <cmd>]
                   Claude Code status line that saves the plan's usage
                   (rate_limits in the payload, Pro and Max plans) for the
                   loop's budget, then runs <cmd> through /bin/sh with the
                   same payload so it shows exactly what <cmd> would. Without
                   --command it shows nothing. Set it in settings.json:
                   "statusLine": {"type": "command", "command":
                   "polesar statusline --command 'your status line'"}.
                   Exit: <cmd>'s exit code (0 without one).
  hook pre-tool-use
                   Claude Code PreToolUse hook guarding the trust boundary.
                   Reads the hook payload on stdin and blocks (exit 2, reason
                   on stderr) tool calls that add the ready-for-agent label,
                   skip pre-commit hooks (git commit --no-verify, changing
                   core.hooksPath), post commit statuses or check runs, or
                   run decide accept or verdict: Bash commands (gh, git, curl to the
                   GitHub API) and MCP tools.
                   Fails closed: a payload it can't read, or any error, blocks.
  hook stop        Claude Code Stop hook. Reads the hook payload on stdin and
                   runs verify from its cwd. Sends the agent back once with the
                   failure summary while checks fail; if it stops again with
                   checks still failing, the stop goes through with a warning.
                   Allows the stop in repos without polesar.json.
  install-hooks [--dry-run] [--command <cmd>] [--json]
                   Add the PreToolUse and Stop hooks to .claude/settings.json
                   at the git root, keeping existing settings. A polesar hook
                   installed with another command is replaced, not
                   duplicated, so rerunning changes nothing.
                   --command sets how hooks run polesar (default: polesar),
                   e.g. 'node "$CLAUDE_PROJECT_DIR/src/cli.ts"'. --dry-run
                   reports what would change without writing. --json gives
                   each hook's status (added, updated, present).
                   Exit: 0 installed or up to date, 2 bad usage or settings.

Options:
  -h, --help       Show this help and exit
  -v, --version    Print the version and exit

Environment:
  POLESAR_HOME     Where polesar keeps usage readings, the loop's weekly
                   usage, paused runs, agent logs, full evidence files and
                   the sandboxes' clones (default: ~/.polesar)
  CLAUDE_CODE_OAUTH_TOKEN
                   The token polesar loop's agents run on, from \`claude
                   setup-token\`. It is the only secret that enters the
                   sandbox: polesar refuses to run if .sandcastle/.env
                   passes any other key, so no GitHub token gets in.
`;

const help = { type: 'boolean', short: 'h' } as const;

/** Exits 2 with `message` and a pointer to --help. */
const exitWithUsage = (message: string): never => {
  process.stderr.write(
    `polesar: ${message}\nRun 'polesar --help' for usage.\n`
  );
  process.exit(2);
};

// Resolves from both src/ (dev, tests) and dist/ (installed bin).
const readVersion = (): string => {
  const pkg = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8')
  ) as { version: string };
  return pkg.version;
};

const parseArgsOrExit = <T extends ParseArgsOptionsConfig>(
  args: string[],
  options: T,
  { allowPositionals = false } = {}
) => {
  try {
    return parseArgs({ args, options, allowPositionals });
  } catch (error) {
    return exitWithUsage(
      error instanceof Error ? error.message : String(error)
    );
  }
};

/** Parses a command's args; `--help` after any command prints usage. */
const parseCommandArgsOrExit = <T extends ParseArgsOptionsConfig>(
  args: string[],
  options: T,
  { allowPositionals = false } = {}
) => {
  const parsed = parseArgsOrExit(
    args,
    { ...options, help },
    { allowPositionals }
  );
  if ((parsed.values as { help?: boolean }).help) {
    process.stdout.write(HELP);
    process.exit(0);
  }
  return parsed;
};

/** Runs `action`, exiting 2 with the message on a config error. */
const orExitOnConfigError = async <T>(action: () => Promise<T>) => {
  try {
    return await action();
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    process.stderr.write(`polesar: ${error.message}\n`);
    process.exit(2);
  }
};

const writeHookResponse = (response: HookResponse) => {
  process.stdout.write(response.stdout);
  process.stderr.write(response.stderr);
  process.exitCode = response.exitCode;
};

/** Prints `result` as JSON, or as the command's short summary. */
const writeResult = <T>(
  json: boolean | undefined,
  result: T,
  describe: (result: T) => string
) => {
  process.stdout.write(
    json ? `${JSON.stringify(result, null, 2)}\n` : describe(result)
  );
};

/** The adapters polesar reaches the outside world through. */
export type Ports = {
  tracker: () => Promise<Tracker>;
  executor: () => Promise<Executor>;
  gate: () => Promise<Gate>;
  usage: () => Promise<Usage>;
  /** The time now, in milliseconds since the epoch. */
  now: () => number;
  /** polesar's own directory, outside any repo: usage readings and the loop's books. */
  home: string;
};

/** Runs `action`, exiting 1 with the message when the tracker fails or the loop can't run. */
const orExitOnPortError = async <T>(action: () => Promise<T>) => {
  try {
    return await action();
  } catch (error) {
    if (!(error instanceof TrackerError || error instanceof LoopError)) {
      throw error;
    }
    process.stderr.write(`polesar: ${error.message}\n`);
    process.exit(1);
  }
};

/** Runs the polesar CLI with these arguments, reaching the outside world through `ports`. */
export const main = async (argv: string[], ports: Ports) => {
  const [command, ...rest] = argv;

  if (command === 'verify') {
    const { values } = parseCommandArgsOrExit(rest, {
      json: { type: 'boolean' },
    });
    const result = await orExitOnConfigError(() => verify(process.cwd()));
    writeResult(values.json, result, summarise);
    process.exitCode = result.passed ? 0 : 1;
  } else if (command === 'frontier') {
    const { values } = parseCommandArgsOrExit(rest, {
      json: { type: 'boolean' },
    });
    const result = await orExitOnPortError(async () =>
      findFrontier(await ports.tracker())
    );
    writeResult(values.json, result, describeFrontier);
  } else if (command === 'loop') {
    const { values } = parseCommandArgsOrExit(rest, {
      'dry-run': { type: 'boolean' },
      json: { type: 'boolean' },
    });
    if (values['dry-run']) {
      const plan = await orExitOnPortError(async () =>
        planLoop(await ports.tracker())
      );
      writeResult(values.json, plan, describePlan);
      return;
    }
    const result = await orExitOnConfigError(() =>
      orExitOnPortError(async () => {
        const loopPorts = {
          tracker: await ports.tracker(),
          // The gate first: a missing gate shouldn't wait on the executor's setup.
          gate: await ports.gate(),
          executor: await ports.executor(),
          usage: await ports.usage(),
        };
        try {
          return await runLoop(loopPorts, {
            cwd: process.cwd(),
            home: ports.home,
            now: ports.now,
            onOutcome: (outcome) => {
              if (!values.json) process.stdout.write(describeOutcome(outcome));
            },
          });
        } finally {
          await loopPorts.executor.close?.();
        }
      })
    );
    writeResult(values.json, result, runSummary);
    process.exitCode =
      !result.outcomes.every((outcome) => outcome.merged) ||
      result.stopped.reason === 'failed'
        ? 1
        : result.stopped.reason === 'done'
          ? 0
          : 3;
  } else if (command === 'verdict') {
    const { values, positionals } = parseCommandArgsOrExit(
      rest,
      { 'dry-run': { type: 'boolean' }, json: { type: 'boolean' } },
      { allowPositionals: true }
    );
    if (positionals.length !== 2) {
      return exitWithUsage(
        'expected a ticket number and a verdict: polesar verdict <ticket> approved|rejected'
      );
    }
    const [ticket = '', verdict = ''] = positionals;
    if (!/^\d+$/.test(ticket)) {
      return exitWithUsage(`ticket must be a number, got '${ticket}'`);
    }
    if (!isVerdict(verdict)) {
      return exitWithUsage(
        `verdict must be approved or rejected, got '${verdict}'`
      );
    }
    const result = await orExitOnPortError(async () =>
      recordVerdict(await ports.tracker(), Number(ticket), verdict, {
        dryRun: values['dry-run'],
      })
    );
    writeResult(values.json, result, describeVerdict);
  } else if (command === 'install-hooks') {
    const { values } = parseCommandArgsOrExit(rest, {
      'dry-run': { type: 'boolean' },
      command: { type: 'string' },
      json: { type: 'boolean' },
    });
    const options = { polesar: values.command, dryRun: values['dry-run'] };
    const result = await orExitOnConfigError(() =>
      installHooks(process.cwd(), options)
    );
    writeResult(values.json, result, (installed) =>
      describeInstall(installed, options)
    );
  } else if (command === 'statusline') {
    const { values } = parseCommandArgsOrExit(rest, {
      command: { type: 'string' },
    });
    process.exitCode = await statusLine(
      await text(process.stdin),
      values.command,
      { home: ports.home, now: ports.now() }
    );
  } else if (command === 'hook') {
    const { positionals } = parseCommandArgsOrExit(
      rest,
      {},
      { allowPositionals: true }
    );
    const event = positionals.length === 1 ? positionals[0] : undefined;
    if (event === 'pre-tool-use') {
      writeHookResponse(await preToolUseHook(text(process.stdin)));
    } else if (event === 'stop') {
      writeHookResponse(await stopHook(await text(process.stdin)));
    } else {
      exitWithUsage(
        `unknown hook '${positionals.join(' ')}'. Supported: pre-tool-use, stop`
      );
    }
  } else {
    const { values } = parseArgsOrExit(argv, {
      help,
      version: { type: 'boolean', short: 'v' },
    });
    if (values.version) {
      process.stdout.write(`${readVersion()}\n`);
    } else {
      process.stdout.write(HELP);
    }
  }
};
