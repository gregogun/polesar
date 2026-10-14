import { spawn, type ChildProcess } from 'node:child_process';
import { access, mkdtemp, open, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { stripVTControlCharacters } from 'node:util';

/** Failure output beyond this many lines is left to the full log. */
const EXCERPT_LINES = 20;

type Check = { name: string; command: string };

type CheckResult = Check & {
  passed: boolean;
  exitCode: number | null;
  /** The last lines of the check's output: where it failed. */
  excerpt: string[];
  /** Path to the check's full stdout and stderr. */
  log: string;
};

const CONFIG_FILE = 'polesar.json';

const CONFIG_EXAMPLE = `{
  "verify": {
    "checks": {
      "typecheck": "pnpm tsc --noEmit",
      "lint": "pnpm eslint ."
    }
  }
}`;

/** The repo's polesar config is missing or malformed; the message says how to fix it. */
export class ConfigError extends Error {
  override name = 'ConfigError';
}

/** The repo has no polesar config at all. */
export class MissingConfigError extends ConfigError {
  override name = 'MissingConfigError';
}

const exists = (file: string) =>
  access(file).then(
    () => true,
    () => false
  );

/** The nearest polesar.json from `cwd` up to its git root (or the filesystem root outside git). */
const findConfig = async (cwd: string): Promise<string> => {
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    const file = path.join(dir, CONFIG_FILE);
    if (await exists(file)) return file;
    if ((await exists(path.join(dir, '.git'))) || path.dirname(dir) === dir) {
      throw new MissingConfigError(
        `no ${CONFIG_FILE} in ${cwd} or its parents up to ${dir}. Create one at the repo root listing the cheap checks to run, e.g.:\n${CONFIG_EXAMPLE}`
      );
    }
  }
};

const readConfig = async (file: string): Promise<unknown> => {
  const text = await readFile(file, 'utf8');
  try {
    return JSON.parse(text);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new ConfigError(`${file} is not valid JSON: ${reason}`);
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const loadChecks = async (file: string): Promise<Check[]> => {
  const config = await readConfig(file);
  const checks =
    isRecord(config) && isRecord(config.verify)
      ? config.verify.checks
      : undefined;
  if (!isRecord(checks) || Object.keys(checks).length === 0) {
    throw new ConfigError(
      `${file} must map "verify.checks" names to shell commands, e.g.:\n${CONFIG_EXAMPLE}`
    );
  }
  return Object.entries(checks).map(([name, command]) => {
    if (typeof command !== 'string') {
      throw new ConfigError(
        `${file}: check "${name}" must be a shell command string, got ${JSON.stringify(command)}`
      );
    }
    return { name, command };
  });
};

/** Waits for a check to exit, failing if it couldn't be started. */
const exitOf = (child: ChildProcess): Promise<number | null> =>
  new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });

const runCheck = async (
  check: Check,
  cwd: string,
  log: string
): Promise<CheckResult> => {
  // One file for stdout and stderr keeps them in the order the check wrote them.
  const file = await open(log, 'w');
  let exitCode: number | null;
  try {
    exitCode = await exitOf(
      spawn(check.command, {
        cwd,
        shell: true,
        stdio: ['ignore', file.fd, file.fd],
      })
    );
  } finally {
    await file.close();
  }
  const excerpt = stripVTControlCharacters(await readFile(log, 'utf8'))
    .split('\n')
    .filter((line) => line.trim() !== '')
    .slice(-EXCERPT_LINES);
  return { ...check, passed: exitCode === 0, exitCode, excerpt, log };
};

const logName = (index: number, check: Check) =>
  `${index + 1}-${check.name.replace(/[^\w.-]/g, '_')}.log`;

type VerifyResult = { passed: boolean; checks: CheckResult[] };

/** Runs the repo's configured cheap checks, in parallel, from the directory holding its polesar.json. */
export const verify = async (cwd: string): Promise<VerifyResult> => {
  const file = await findConfig(cwd);
  const configured = await loadChecks(file);
  const logDir = await mkdtemp(path.join(tmpdir(), 'polesar-verify-'));
  const checks = await Promise.all(
    configured.map((check, index) =>
      runCheck(
        check,
        path.dirname(file),
        path.join(logDir, logName(index, check))
      )
    )
  );
  return { passed: checks.every((check) => check.passed), checks };
};

/** Short, agent-facing summary: only what failed, where, and the full log. */
export const summarise = ({ passed, checks }: VerifyResult): string => {
  if (passed) {
    return `verify: all ${checks.length} checks passed\n`;
  }
  const failed = checks.filter((check) => !check.passed);
  const sections = failed.map((check) =>
    [
      `✗ ${check.name} (exit ${check.exitCode}): ${check.command}`,
      ...check.excerpt.map((line) => `  ${line}`),
      `  Full log: ${check.log}`,
    ].join('\n')
  );
  return `verify: ${failed.length} of ${checks.length} checks failed\n\n${sections.join('\n\n')}\n`;
};
