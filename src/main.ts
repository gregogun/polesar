import { readFileSync } from 'node:fs';
import { text } from 'node:stream/consumers';
import { parseArgs, type ParseArgsOptionsConfig } from 'node:util';
import { preToolUseHook, stopHook, type HookResponse } from './hook.ts';
import { describeFrontier, findFrontier } from './frontier.ts';
import { describeInstall, installHooks } from './install-hooks.ts';
import { TrackerError, type Tracker } from './tracker.ts';
import { ConfigError, summarise, verify } from './verify.ts';

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
  hook pre-tool-use
                   Claude Code PreToolUse hook guarding the trust boundary.
                   Reads the hook payload on stdin and blocks (exit 2, reason
                   on stderr) tool calls that add the ready-for-agent label,
                   skip pre-commit hooks (git commit --no-verify, changing
                   core.hooksPath), post commit statuses or check runs, or
                   run decide accept: Bash commands (gh, git, curl to the
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
`;

const help = { type: 'boolean', short: 'h' } as const;

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
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `polesar: ${message}\nRun 'polesar --help' for usage.\n`
    );
    process.exit(2);
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
};

/** Runs `action`, exiting 1 with the message when the tracker fails. */
const orExitOnTrackerError = async <T>(action: () => Promise<T>) => {
  try {
    return await action();
  } catch (error) {
    if (!(error instanceof TrackerError)) throw error;
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
    const result = await orExitOnTrackerError(async () =>
      findFrontier(await ports.tracker())
    );
    writeResult(values.json, result, describeFrontier);
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
      process.stderr.write(
        `polesar: unknown hook '${positionals.join(' ')}'. Supported: pre-tool-use, stop\nRun 'polesar --help' for usage.\n`
      );
      process.exit(2);
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
