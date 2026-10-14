import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
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

const readConfig = async (file: string): Promise<unknown> => {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    throw new MissingConfigError(
      `no ${CONFIG_FILE} in ${path.dirname(file)}. Create one listing the cheap checks to run, e.g.:\n${CONFIG_EXAMPLE}`
    );
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new ConfigError(`${file} is not valid JSON: ${reason}`);
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const loadChecks = async (cwd: string): Promise<Check[]> => {
  const file = path.join(cwd, CONFIG_FILE);
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

const runCheck = (
  check: Check,
  cwd: string,
  log: string
): Promise<CheckResult> =>
  new Promise((resolve, reject) => {
    const child = spawn(check.command, {
      cwd,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const collect = (chunk: string) => {
      output += chunk;
    };
    child.stdout.setEncoding('utf8').on('data', collect);
    child.stderr.setEncoding('utf8').on('data', collect);
    child.on('error', reject);
    child.on('close', (exitCode) => {
      const excerpt = stripVTControlCharacters(output)
        .split('\n')
        .filter((line) => line.trim() !== '')
        .slice(-EXCERPT_LINES);
      writeFile(log, output).then(
        () =>
          resolve({ ...check, passed: exitCode === 0, exitCode, excerpt, log }),
        reject
      );
    });
  });

const logName = (index: number, check: Check) =>
  `${index + 1}-${check.name.replace(/[^\w.-]/g, '_')}.log`;

/** Runs the repo's configured cheap checks in `cwd`, in parallel. */
export const verify = async (cwd: string): Promise<CheckResult[]> => {
  const checks = await loadChecks(cwd);
  const logs = await mkdtemp(path.join(tmpdir(), 'polesar-verify-'));
  return Promise.all(
    checks.map((check, index) =>
      runCheck(check, cwd, path.join(logs, logName(index, check)))
    )
  );
};

/** Short, agent-facing summary: only what failed, where, and the full log. */
export const summarise = (results: CheckResult[]): string => {
  const failed = results.filter((result) => !result.passed);
  if (failed.length === 0) {
    return `verify: all ${results.length} checks passed\n`;
  }
  const sections = failed.map((result) =>
    [
      `✗ ${result.name} (exit ${result.exitCode}): ${result.command}`,
      ...result.excerpt.map((line) => `  ${line}`),
      `  Full log: ${result.log}`,
    ].join('\n')
  );
  return `verify: ${failed.length} of ${results.length} checks failed\n\n${sections.join('\n\n')}\n`;
};
