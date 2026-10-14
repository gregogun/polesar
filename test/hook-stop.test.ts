import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { polesarConfig } from './polesar-config.ts';
import { runCli } from './run-cli.ts';

/** A Claude Code Stop hook payload for a session working in `<tmp>/project`. */
const payload =
  ({ stopHookActive = false } = {}) =>
  (tmp: string) =>
    JSON.stringify({
      session_id: 'abc123',
      transcript_path: path.join(tmp, 'transcript.jsonl'),
      cwd: path.join(tmp, 'project'),
      hook_event_name: 'Stop',
      stop_hook_active: stopHookActive,
    });

const stopPayload = payload();

const failingTypecheck = "echo 'src/a.ts:3:5 - error TS2322: nope'; exit 2";

const project = (checks: Record<string, string>) =>
  polesarConfig(checks, 'project');

describe('polesar hook stop', () => {
  it('allows the stop when verify passes', async () => {
    const result = await runCli(['hook', 'stop'], {
      stdin: stopPayload,
      files: project({ lint: 'true' }),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('');
  });

  it('blocks the stop with the failure summary when verify fails', async () => {
    const result = await runCli(['hook', 'stop'], {
      stdin: stopPayload,
      files: project({
        lint: 'true',
        typecheck: failingTypecheck,
      }),
    });

    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout) as {
      decision: string;
      reason: string;
    };
    expect(output.decision).toBe('block');
    expect(output.reason).toContain('✗ typecheck (exit 2)');
    expect(output.reason).toContain('src/a.ts:3:5 - error TS2322: nope');
    expect(output.reason).not.toContain('lint');
  });

  it('lets the stop through with a warning once the agent has already been sent back', async () => {
    const result = await runCli(['hook', 'stop'], {
      stdin: payload({ stopHookActive: true }),
      files: project({ typecheck: failingTypecheck }),
    });

    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(output).not.toHaveProperty('decision');
    expect(output.systemMessage).toContain('still failing');
    expect(output.systemMessage).toContain('✗ typecheck (exit 2)');
  });

  it('allows the stop in a repo with no polesar config', async () => {
    const result = await runCli(['hook', 'stop'], { stdin: stopPayload });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('');
  });

  it('reports a broken config to the user without sending the agent back', async () => {
    const result = await runCli(['hook', 'stop'], {
      stdin: stopPayload,
      files: { 'project/polesar.json': '{ verify: ' },
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/^polesar: .*polesar\.json/);
  });

  it('reports a malformed payload without sending the agent back', async () => {
    const result = await runCli(['hook', 'stop'], { stdin: 'not json' });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/^polesar: .*Stop hook payload/);
  });
});

describe('polesar hook with an unsupported event', () => {
  it('names the event, points at --help and exits 2', async () => {
    const result = await runCli(['hook', 'teleport']);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("'teleport'");
    expect(result.stderr).toContain('polesar --help');
  });
});
