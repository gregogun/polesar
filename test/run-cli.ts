import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('./cli-with-fakes.ts', import.meta.url));

type RunCliOptions = {
  /** Written to the child's stdin, which is then closed. A function gets the child's cwd. */
  stdin?: string | ((cwd: string) => string);
  /** An existing directory to run in instead of a fresh temp dir; it's left in place. */
  dir?: string;
  /** Files (e.g. config) written into a fresh temp dir used as the child's cwd. */
  files?: Record<string, string>;
  /** Subdirectory of that temp dir to run in, created if missing. */
  cwd?: string;
  /** Extra environment variables, on top of a minimal base. */
  env?: Record<string, string>;
};

export type CliResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
};

/** Spawns the polesar CLI (with fakes for any ports the test scripts), as a user or agent would, and captures the result. */
export const runCli = async (
  args: string[],
  options: RunCliOptions = {}
): Promise<CliResult> => {
  const cwd =
    options.dir ?? (await mkdtemp(path.join(tmpdir(), 'polesar-test-')));
  try {
    for (const [name, content] of Object.entries(options.files ?? {})) {
      const file = path.join(cwd, name);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, content);
    }
    const childCwd = path.join(cwd, options.cwd ?? '');
    await mkdir(childCwd, { recursive: true });
    return await new Promise<CliResult>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        // Node <24 warns on type stripping; that's runtime noise, not CLI output.
        ['--disable-warning=ExperimentalWarning', CLI, ...args],
        {
          cwd: childCwd,
          env: { PATH: process.env.PATH ?? '', ...options.env },
        }
      );
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
        stderr += chunk;
      });
      child.on('error', reject);
      child.on('close', (exitCode) => resolve({ exitCode, stdout, stderr }));
      const { stdin = '' } = options;
      child.stdin.end(typeof stdin === 'function' ? stdin(cwd) : stdin);
    });
  } finally {
    if (options.dir === undefined) {
      await rm(cwd, { recursive: true, force: true });
    }
  }
};
