import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ConfigError, exists, isRecord } from './verify.ts';

const SETTINGS_FILE = path.join('.claude', 'settings.json');

type HookSpec = { event: string; matcher?: string; command: string };

/**
 * polesar's Claude Code hooks, run through `polesar` (or another command
 * that runs the CLI). Any failure of the guard, even polesar missing from
 * PATH, becomes exit 2 so the tool call is blocked: Claude Code treats other
 * exit codes as non-blocking.
 */
const polesarHooks = (polesar: string): HookSpec[] => [
  {
    event: 'PreToolUse',
    matcher: 'Bash',
    command: `${polesar} hook pre-tool-use || exit 2`,
  },
  { event: 'Stop', command: `${polesar} hook stop` },
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

const isInstalled = (groups: unknown[], command: string) =>
  groups.some(
    (group) =>
      isRecord(group) &&
      Array.isArray(group.hooks) &&
      group.hooks.some((hook) => isRecord(hook) && hook.command === command)
  );

type InstallResult = { file: string; added: HookSpec[]; present: HookSpec[] };

/**
 * Adds polesar's hooks to the project's `.claude/settings.json`, keeping
 * everything already there. A hook whose command is already present is left
 * alone, so running it again changes nothing.
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
  const added: HookSpec[] = [];
  const present: HookSpec[] = [];
  for (const spec of polesarHooks(polesar)) {
    const groups = hooks[spec.event] ?? [];
    if (!Array.isArray(groups)) {
      throw new ConfigError(
        `${file}: "hooks.${spec.event}" must be an array of hook groups. Fix it and run install-hooks again.`
      );
    }
    if (isInstalled(groups, spec.command)) {
      present.push(spec);
      continue;
    }
    const { matcher } = spec;
    hooks[spec.event] = [
      ...groups,
      {
        ...(matcher === undefined ? {} : { matcher }),
        hooks: [{ type: 'command', command: spec.command }],
      },
    ];
    added.push(spec);
  }
  if (added.length > 0 && !dryRun) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(
      file,
      `${JSON.stringify({ ...settings, hooks }, null, 2)}\n`
    );
  }
  return { file, added, present };
};

export const describeInstall = (
  { file, added, present }: InstallResult,
  { dryRun = false } = {}
): string => {
  const lines = [
    ...added.map(
      (spec) =>
        `${dryRun ? 'Would add' : 'Added'} ${spec.event} hook: ${spec.command}`
    ),
    ...present.map((spec) => `${spec.event} hook already installed`),
  ];
  const outcome =
    added.length === 0
      ? `${file} is up to date.`
      : dryRun
        ? `Dry run: ${file} not written.`
        : `Wrote ${file}.`;
  return `${[...lines, outcome].join('\n')}\n`;
};
