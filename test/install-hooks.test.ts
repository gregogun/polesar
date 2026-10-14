import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCli } from './run-cli.ts';

let project: string;

beforeEach(async () => {
  project = await mkdtemp(path.join(tmpdir(), 'polesar-project-'));
  await mkdir(path.join(project, '.git'));
});

afterEach(async () => {
  await rm(project, { recursive: true, force: true });
});

const settingsFile = () => path.join(project, '.claude', 'settings.json');

const readSettings = async () =>
  JSON.parse(await readFile(settingsFile(), 'utf8')) as Record<string, unknown>;

const writeSettings = async (settings: unknown) => {
  await mkdir(path.dirname(settingsFile()), { recursive: true });
  await writeFile(settingsFile(), `${JSON.stringify(settings, null, 2)}\n`);
};

const install = (args: string[] = [], cwd?: string) =>
  runCli(['install-hooks', ...args], { dir: project, cwd });

const POLESAR_HOOKS = {
  PreToolUse: [
    {
      matcher: 'Bash|mcp__.*',
      hooks: [
        { type: 'command', command: 'polesar hook pre-tool-use || exit 2' },
      ],
    },
  ],
  Stop: [{ hooks: [{ type: 'command', command: 'polesar hook stop' }] }],
};

describe('polesar install-hooks', () => {
  it("adds the guard and Stop hooks to the project's Claude Code settings", async () => {
    const result = await install();

    expect(result.exitCode).toBe(0);
    expect(await readSettings()).toEqual({ hooks: POLESAR_HOOKS });
    expect(result.stdout).toContain('Added PreToolUse hook');
    expect(result.stdout).toContain('Added Stop hook');
  });

  it('changes nothing when run again', async () => {
    await install();
    const before = await readFile(settingsFile(), 'utf8');

    const result = await install();

    expect(result.exitCode).toBe(0);
    expect(await readFile(settingsFile(), 'utf8')).toBe(before);
    expect(result.stdout).toContain('PreToolUse hook already installed');
    expect(result.stdout).toContain('Stop hook already installed');
  });

  it('keeps existing settings and hooks', async () => {
    const lint = { type: 'command', command: 'pnpm lint' };
    await writeSettings({
      permissions: { deny: ['Read(**/.env)'] },
      hooks: {
        PreToolUse: [{ matcher: 'Write', hooks: [lint] }],
        PostToolUse: [{ matcher: 'Edit', hooks: [lint] }],
      },
    });

    await install();

    expect(await readSettings()).toEqual({
      permissions: { deny: ['Read(**/.env)'] },
      hooks: {
        PreToolUse: [
          { matcher: 'Write', hooks: [lint] },
          ...POLESAR_HOOKS.PreToolUse,
        ],
        PostToolUse: [{ matcher: 'Edit', hooks: [lint] }],
        Stop: POLESAR_HOOKS.Stop,
      },
    });
  });

  it('installs at the git root when run from a subdirectory', async () => {
    const result = await install([], 'packages/app');

    expect(result.exitCode).toBe(0);
    expect(await readSettings()).toEqual({ hooks: POLESAR_HOOKS });
  });

  it('runs polesar through --command, e.g. from source in a dev checkout', async () => {
    await install(['--command', 'node "$CLAUDE_PROJECT_DIR/src/cli.ts"']);

    const { hooks } = (await readSettings()) as {
      hooks: Record<string, { hooks: { command: string }[] }[]>;
    };
    expect(hooks.PreToolUse?.[0]?.hooks[0]?.command).toBe(
      'node "$CLAUDE_PROJECT_DIR/src/cli.ts" hook pre-tool-use || exit 2'
    );
    expect(hooks.Stop?.[0]?.hooks[0]?.command).toBe(
      'node "$CLAUDE_PROJECT_DIR/src/cli.ts" hook stop'
    );
  });

  it('replaces polesar hooks installed with another command instead of adding a second copy', async () => {
    const lint = { type: 'command', command: 'pnpm lint' };
    await writeSettings({
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [
              { type: 'command', command: 'npx polesar hook pre-tool-use' },
            ],
          },
          { matcher: 'Write', hooks: [lint] },
        ],
        Stop: [
          {
            hooks: [
              lint,
              { type: 'command', command: 'node cli.js hook stop' },
            ],
          },
        ],
      },
    });

    const result = await install();

    expect(result.exitCode).toBe(0);
    expect(await readSettings()).toEqual({
      hooks: {
        PreToolUse: [
          { matcher: 'Write', hooks: [lint] },
          ...POLESAR_HOOKS.PreToolUse,
        ],
        Stop: [{ hooks: [lint] }, ...POLESAR_HOOKS.Stop],
      },
    });
    expect(result.stdout).toContain('Updated PreToolUse hook');
    expect(result.stdout).toContain('Updated Stop hook');
    expect((await install()).stdout).toContain('is up to date');
  });

  it('reports what it did as JSON with --json', async () => {
    await writeSettings({ hooks: { Stop: POLESAR_HOOKS.Stop } });

    const result = await install(['--json']);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      file: expect.stringMatching(/\.claude\/settings\.json$/),
      written: true,
      hooks: [
        {
          event: 'PreToolUse',
          matcher: 'Bash|mcp__.*',
          command: 'polesar hook pre-tool-use || exit 2',
          status: 'added',
        },
        {
          event: 'Stop',
          command: 'polesar hook stop',
          status: 'present',
        },
      ],
    });
  });

  it('reports what it would add without writing on --dry-run', async () => {
    const result = await install(['--dry-run']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Would add PreToolUse hook');
    await expect(readFile(settingsFile())).rejects.toThrow();
    const json = await install(['--dry-run', '--json']);
    expect(JSON.parse(json.stdout)).toMatchObject({ written: false });
  });

  it('leaves invalid settings alone, says why and exits 2', async () => {
    await mkdir(path.dirname(settingsFile()), { recursive: true });
    await writeFile(settingsFile(), '{ "hooks": ');

    const result = await install();

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toMatch(
      /^polesar: .*settings\.json is not valid JSON/
    );
    expect(await readFile(settingsFile(), 'utf8')).toBe('{ "hooks": ');
  });
});
