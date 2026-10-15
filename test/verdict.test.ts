import { describe, expect, it } from 'vitest';
import { runWithFakes, writes } from './loop-script.ts';

const escalated = {
  number: 7,
  title: 'Schema',
  labels: ['ready-for-human'],
};

const verdict = (args: string[]) =>
  runWithFakes(['verdict', ...args], { tickets: [escalated] });

describe('polesar verdict', () => {
  it.each(['approved', 'rejected'])(
    'records the verdict (%s) against the escalation as a comment on the ticket, for telemetry',
    async (given) => {
      const result = await verdict(['7', given]);

      expect(result.stderr).toBe('');
      expect(result.exitCode).toBe(0);
      expect(writes(result.calls)).toEqual([
        {
          port: 'tracker',
          method: 'comment',
          args: [
            7,
            `polesar verdict: ${given}\n\nRecorded against polesar's latest escalation of this ticket, for telemetry.\n`,
          ],
        },
      ]);
      expect(result.stdout).toBe(`#7: recorded verdict ${given}\n`);
    }
  );

  it('gives the result as JSON with --json', async () => {
    const result = await verdict(['7', 'approved', '--json']);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      ticket: 7,
      verdict: 'approved',
      recorded: true,
    });
  });

  it('shows what it would record without changing anything with --dry-run', async () => {
    const result = await verdict(['7', 'rejected', '--dry-run']);

    expect(result.exitCode).toBe(0);
    expect(writes(result.calls)).toEqual([]);
    expect(result.stdout).toBe(
      '#7: would record verdict rejected. Nothing was changed.\n'
    );
  });

  it.each([
    [[], /expected a ticket number and a verdict/],
    [['7'], /expected a ticket number and a verdict/],
    [['7', 'maybe'], /verdict must be approved or rejected, got 'maybe'/],
    [['seven', 'approved'], /ticket must be a number, got 'seven'/],
    [['7', 'approved', 'extra'], /expected a ticket number and a verdict/],
  ])('exits 2 with usage help on bad arguments: %j', async (args, message) => {
    const result = await verdict(args);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toMatch(message);
    expect(result.stderr).toContain('polesar --help');
    expect(writes(result.calls)).toEqual([]);
  });

  it('exits 1 saying what went wrong when the tracker cannot record it', async () => {
    const result = await verdict(['99', 'approved']);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/^polesar: .*#99/);
  });
});
