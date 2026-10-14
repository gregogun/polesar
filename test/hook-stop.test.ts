import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli } from './run-cli.ts';

/** A Claude Code Stop hook payload for a session working in `<tmp>/project`. */
const stopPayload = (cwd: string) =>
  JSON.stringify({
    session_id: 'abc123',
    transcript_path: path.join(cwd, 'transcript.jsonl'),
    cwd: path.join(cwd, 'project'),
    hook_event_name: 'Stop',
    stop_hook_active: false,
  });

const project = (checks: Record<string, string>) => ({
  'project/polesar.json': JSON.stringify({ verify: { checks } }),
});

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
        typecheck: "echo 'src/a.ts:3:5 - error TS2322: nope'; exit 2",
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

  it.each([
    ['is not JSON', 'not json'],
    ['has no cwd', JSON.stringify({ hook_event_name: 'Stop' })],
  ])(
    'reports a payload that %s without sending the agent back',
    async (_problem, stdin) => {
      const result = await runCli(['hook', 'stop'], { stdin });

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toMatch(/^polesar: .*Stop hook payload/);
    }
  );
});

describe('polesar hook with an unsupported event', () => {
  it('names the event, points at --help and exits 2', async () => {
    const result = await runCli(['hook', 'teleport']);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("'teleport'");
    expect(result.stderr).toContain('polesar --help');
  });
});
