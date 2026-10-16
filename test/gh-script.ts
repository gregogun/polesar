import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runWithFakes, type LoopScript } from './loop-script.ts';
import type { RecordedCall } from './recording.ts';

/** One check as `gh pr checks --json` reports it; unset fields default to empty. */
export type ScriptedCheck = {
  name: string;
  bucket: 'pass' | 'fail' | 'pending' | 'skipping' | 'cancel';
  state?: string;
  description?: string;
  link?: string;
  workflow?: string;
};

/**
 * How GitHub behaves for the real gate, as the fake `gh` and `git` play it.
 * Commits come from the fake implementer's branches.
 */
export type GhScript = {
  /** PRs already open, by head branch. Others are opened by `gh pr create`, numbered from 100. */
  openPrs?: Record<string, number>;
  /**
   * What `gh pr checks --required` reports, per branch: one entry per call,
   * the last repeating. 'none' is gh's "no required checks reported".
   * Unscripted: one passing check.
   */
  checks?: Record<string, (ScriptedCheck[] | 'none')[]>;
  /** What `gh run view <id> --json jobs` reports, by run id. */
  runs?: Record<
    string,
    {
      jobs: {
        databaseId: number;
        name: string;
        conclusion: string;
        steps: { name: string; conclusion: string }[];
      }[];
    }
  >;
  /** Commands that fail, by program subcommand (e.g. `pr merge`, `push`), with their stderr. */
  fail?: Record<string, string>;
};

const FAKE = fileURLToPath(new URL('./fake-gh.ts', import.meta.url));

/** A directory holding `gh` and `git` shims that run the fake, to put first on PATH. */
const shims = async (dir: string) => {
  const bin = path.join(dir, 'bin');
  await mkdir(bin, { recursive: true });
  for (const program of ['gh', 'git']) {
    const shim = path.join(bin, program);
    await writeFile(
      shim,
      `#!/bin/sh\nexec "${process.execPath}" --disable-warning=ExperimentalWarning "${FAKE}" ${program} "$@"\n`
    );
    await chmod(shim, 0o755);
  }
  return bin;
};

/**
 * Runs `polesar loop` with a fake tracker, executor and usage, and the real
 * GitHub gate talking to a fake `gh` and `git` scripted by `gh`.
 */
export const runWithGitHub = async (
  script: LoopScript,
  gh: GhScript,
  { args = [], config = {} }: { args?: string[]; config?: object } = {}
) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'polesar-gate-'));
  try {
    const bin = await shims(dir);
    return await runWithFakes(
      ['loop', ...args],
      script,
      {
        'gh.json': JSON.stringify(gh),
        'polesar.json': JSON.stringify(config),
      },
      {
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        POLESAR_GH_FAKE: path.join(dir, 'gh.json'),
        POLESAR_GH_STATE: path.join(dir, 'gh-state.json'),
        POLESAR_FAKE_STATE: path.join(dir, 'fake-state.json'),
      },
      dir
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

/** The `gh` and `git` commands polesar ran, as argv lists. */
export const commands = (calls: RecordedCall[]) =>
  calls
    .filter(({ port }) => port === 'gh' || port === 'git')
    .map(({ port, args }) => [port, ...(args as string[])]);
