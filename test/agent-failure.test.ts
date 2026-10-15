import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loopSession, writes, type LoopSession } from './loop-script.ts';

const tickets = [
  { number: 1, title: 'Schema', labels: ['ready-for-agent'] },
  { number: 2, title: 'Docs', labels: ['ready-for-agent'] },
];
const steps = (calls: Awaited<ReturnType<LoopSession['run']>>['calls']) =>
  writes(calls).map(({ port, method }) => `${port}.${method}`);

describe('polesar loop when an agent run fails', () => {
  let session: LoopSession;
  beforeEach(async () => {
    session = await loopSession();
  });
  afterEach(() => session.close());

  it('stops the run without touching the ticket, and the next run resumes it where it stopped', async () => {
    const script = {
      tickets,
      review: { 1: [{ failed: 'the sandbox exited 137' }, {}] },
    };

    const failed = await session.run(script, { now: '2026-10-15T12:00:00Z' });

    expect(failed.exitCode).toBe(1);
    expect(steps(failed.calls)).toEqual([
      'executor.implement',
      'executor.review',
    ]);
    expect(failed.stdout).toBe(
      'loop stopped: an agent run failed on #1: the sandbox exited 137. #1 keeps its place, with no retry used and its labels unchanged: run polesar loop again to resume it (0 merged)\n'
    );

    const resumed = await session.run(script, {
      now: '2026-10-15T12:05:00Z',
    });

    expect(resumed.exitCode).toBe(0);
    expect(steps(resumed.calls)).toEqual([
      'executor.review',
      'gate.check',
      'gate.merge',
      'tracker.comment',
      'tracker.close',
      'executor.implement',
      'executor.review',
      'gate.check',
      'gate.merge',
      'tracker.comment',
      'tracker.close',
    ]);
    const [review] = writes(resumed.calls);
    expect(review?.args[0]).toMatchObject({
      ticket: { number: 1 },
      diff: 'diff for #1',
      maxTurns: 199,
    });
  });

  it('gives the failure as JSON with --json', async () => {
    const result = await session.run(
      { tickets, implement: { 1: { failed: 'docker is not running' } } },
      { now: '2026-10-15T12:00:00Z', args: ['--json'] }
    );

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      outcomes: [],
      stopped: {
        reason: 'failed',
        ticket: 1,
        detail: 'docker is not running',
      },
    });
  });
});
