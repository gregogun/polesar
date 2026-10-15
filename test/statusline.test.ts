import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NOW, runLoop } from './loop-script.ts';
import { runCli } from './run-cli.ts';

const epoch = (iso: string) => Date.parse(iso) / 1000;

const payload = (rateLimits?: unknown) =>
  JSON.stringify({
    model: { display_name: 'Opus' },
    workspace: { current_dir: '/repo' },
    ...(rateLimits !== undefined && { rate_limits: rateLimits }),
  });

const limits = (weekly: number) => ({
  five_hour: {
    used_percentage: 12.5,
    resets_at: epoch('2026-10-15T14:00:00Z'),
  },
  seven_day: {
    used_percentage: weekly,
    resets_at: epoch('2026-10-18T00:00:00Z'),
  },
});

describe('polesar statusline', () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'polesar-home-'));
  });
  afterEach(() => rm(home, { recursive: true, force: true }));

  const statusline = (stdin: string, args: string[] = []) =>
    runCli(['statusline', ...args], {
      stdin,
      env: { POLESAR_HOME: home, POLESAR_FAKE_NOW: NOW },
    });
  const reading = async () =>
    JSON.parse(
      await readFile(path.join(home, 'usage.json'), 'utf8')
    ) as unknown;

  it('shows exactly what the wrapped status line command shows, given the same payload', async () => {
    const stdin = payload(limits(40));

    const result = await statusline(stdin, [
      '--command',
      'printf "[%s] " "$0"; cat; echo oops >&2; exit 4',
    ]);

    expect(result).toEqual({
      exitCode: 4,
      stdout: `[/bin/sh] ${stdin}`,
      stderr: 'oops\n',
    });
  });

  it('saves the rate limits in the payload as the latest usage reading', async () => {
    await statusline(payload(limits(40)), ['--command', 'true']);

    expect(await reading()).toEqual({
      recordedAt: NOW,
      fiveHour: { usedPercentage: 12.5, resetsAt: '2026-10-15T14:00:00.000Z' },
      sevenDay: { usedPercentage: 40, resetsAt: '2026-10-18T00:00:00.000Z' },
    });
  });

  it('shows nothing without a command', async () => {
    const result = await statusline(payload(limits(40)));

    expect(result).toEqual({ exitCode: 0, stdout: '', stderr: '' });
    expect(await reading()).toMatchObject({ sevenDay: { usedPercentage: 40 } });
  });

  it('keeps the last reading when a payload has no rate limits', async () => {
    await statusline(payload(limits(40)));

    await statusline(payload());
    await statusline('not json', ['--command', 'cat']);

    expect(await reading()).toMatchObject({ sevenDay: { usedPercentage: 40 } });
  });

  it('still shows the status line when it cannot save the reading', async () => {
    const result = await runCli(['statusline', '--command', 'cat'], {
      stdin: payload(limits(40)),
      env: { POLESAR_HOME: '/dev/null/polesar' },
    });

    expect(result).toEqual({
      exitCode: 0,
      stdout: payload(limits(40)),
      stderr: '',
    });
  });

  it('feeds the loop its budget', async () => {
    await statusline(payload(limits(72)), ['--command', 'true']);

    const result = await runLoop(
      {
        tickets: [{ number: 1, title: 'Schema', labels: ['ready-for-agent'] }],
      },
      [],
      {},
      { POLESAR_HOME: home, POLESAR_USAGE_FAKE: '' }
    );

    expect(result.exitCode).toBe(3);
    expect(result.stdout).toBe(
      'loop stopped before the next ticket: weekly usage is at 72%, at or above the 70% floor for starting a ticket (0 merged)\n'
    );
  });
});
