import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ConfigError, exists, isRecord } from './verify.ts';

const SETTINGS_FILE = path.join('.claude', 'settings.json');

type HookSpec = {
  event: string;
  matcher?: string;
  command: string;
  /** Recognises this hook whatever command it runs polesar with. */
  installed: RegExp;
};

/**
 * polesar's Claude Code hooks, run through `polesar` (or another command
 * that runs the CLI). The guard sees Bash and every MCP tool, since MCP
 * servers (GitHub's among them) can do what the guard blocks in Bash. Any
 * failure of the guard, even polesar missing from PATH, becomes exit 2 so
 * the tool call is blocked: Claude Code treats other exit codes as
 * non-blocking.
 */
const polesarHooks = (polesar: string): HookSpec[] => [
  {
    event: 'PreToolUse',
    matcher: 'Bash|mcp__.*',
    command: `${polesar} hook pre-tool-use || exit 2`,
    installed: /(^|\s)hook pre-tool-use(\s|$)/,
  },
  {
    event: 'Stop',
    command: `${polesar} hook stop`,
    installed: /(^|\s)hook stop(\s|$)/,
  },
];

/** The git root above `cwd`, or `cwd` itself outside git. */
const projectRoot = async (cwd: string): Promise<string> => {
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    if (await exists(path.join(dir, '.git'))) return dir;
    if (path.dirname(dir) === dir) return path.resolve(cwd);
  }
};

const readSettings = async (file: string): Promise<Record<string, unknown>> => {
  if (!(await exists(file))) return {};
  let settings: unknown;
  try {
    settings = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new ConfigError(
      `${file} is not valid JSON: ${reason}. Fix it and run install-hooks again.`
    );
  }
  if (!isRecord(settings)) {
    throw new ConfigError(
      `${file} must hold a JSON object. Fix it and run install-hooks again.`
    );
  }
  return settings;
};

type Group = { matcher?: unknown; hooks: unknown[] };

const isGroup = (group: unknown): group is Group =>
  isRecord(group) && Array.isArray(group.hooks);

const commandOf = (hook: unknown) =>
  isRecord(hook) && typeof hook.command === 'string' ? hook.command : '';

/** Whether the event's groups hold exactly this hook, once, under its matcher. */
const isInstalled = (groups: unknown[], spec: HookSpec) => {
  const found = groups
    .filter(isGroup)
    .flatMap((group) =>
      group.hooks
        .filter((hook) => spec.installed.test(commandOf(hook)))
        .map((hook) => ({ group, hook }))
    );
  return (
    found.length === 1 &&
    commandOf(found[0]!.hook) === spec.command &&
    found[0]!.group.matcher === spec.matcher
  );
};

/** The groups with any copy of the hook taken out, dropping groups left empty. */
const withoutHook = (groups: unknown[], spec: HookSpec) => {
  let removed = false;
  const kept = groups.flatMap((group) => {
    if (!isGroup(group)) return [group];
    const hooks = group.hooks.filter(
      (hook) => !spec.installed.test(commandOf(hook))
    );
    if (hooks.length === group.hooks.length) return [group];
    removed = true;
    return hooks.length === 0 ? [] : [{ ...group, hooks }];
  });
  return { kept, removed };
};

type HookStatus = 'added' | 'updated' | 'present';

type InstalledHook = {
  event: string;
  matcher?: string;
  command: string;
  status: HookStatus;
};

type InstallResult = {
  file: string;
  /** Whether the settings file was written (false on a dry run or when up to date). */
  written: boolean;
  hooks: InstalledHook[];
};

/**
 * Adds polesar's hooks to the project's `.claude/settings.json`, keeping
 * everything already there. A polesar hook installed with another command
 * or matcher is replaced rather than duplicated, and running it again
 * changes nothing.
 */
export const installHooks = async (
  cwd: string,
  { polesar = 'polesar', dryRun = false } = {}
): Promise<InstallResult> => {
  const file = path.join(await projectRoot(cwd), SETTINGS_FILE);
  const settings = await readSettings(file);
  const hooks = settings.hooks ?? {};
  if (!isRecord(hooks)) {
    throw new ConfigError(
      `${file}: "hooks" must map event names to arrays of hook groups. Fix it and run install-hooks again.`
    );
  }
  const installed: InstalledHook[] = [];
  for (const spec of polesarHooks(polesar)) {
    const { event, matcher, command } = spec;
    const groups = hooks[event] ?? [];
    if (!Array.isArray(groups)) {
      throw new ConfigError(
        `${file}: "hooks.${event}" must be an array of hook groups. Fix it and run install-hooks again.`
      );
    }
    let status: HookStatus = 'present';
    if (!isInstalled(groups, spec)) {
      const { kept, removed } = withoutHook(groups, spec);
      hooks[event] = [
        ...kept,
        {
          ...(matcher === undefined ? {} : { matcher }),
          hooks: [{ type: 'command', command }],
        },
      ];
      status = removed ? 'updated' : 'added';
    }
    installed.push({
      event,
      ...(matcher === undefined ? {} : { matcher }),
      command,
      status,
    });
  }
  const changed = installed.some((hook) => hook.status !== 'present');
  if (changed && !dryRun) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(
      file,
      `${JSON.stringify({ ...settings, hooks }, null, 2)}\n`
    );
  }
  return { file, written: changed && !dryRun, hooks: installed };
};

const VERBS: Record<Exclude<HookStatus, 'present'>, [string, string]> = {
  added: ['Added', 'Would add'],
  updated: ['Updated', 'Would update'],
};

export const describeInstall = (
  { file, written, hooks }: InstallResult,
  { dryRun = false } = {}
): string => {
  const lines = hooks.map(({ event, command, status }) =>
    status === 'present'
      ? `${event} hook already installed`
      : `${VERBS[status][dryRun ? 1 : 0]} ${event} hook: ${command}`
  );
  const outcome = written
    ? `Wrote ${file}.`
    : dryRun && hooks.some((hook) => hook.status !== 'present')
      ? `Dry run: ${file} not written.`
      : `${file} is up to date.`;
  return `${[...lines, outcome].join('\n')}\n`;
};
