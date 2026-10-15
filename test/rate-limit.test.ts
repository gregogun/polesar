import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loopSession, writes, type LoopSession } from './loop-script.ts';

const RESET = '2026-10-15T14:00:00.000Z';
const rateLimited = { rateLimited: { resetsAt: RESET } };
const missingIndex = { blocking: true, summary: 'no index' };
const tickets = [
  { number: 1, title: 'Schema', labels: ['ready-for-agent'] },
  { number: 2, title: 'Docs', labels: ['ready-for-agent'] },
];
const steps = (calls: Awaited<ReturnType<LoopSession['run']>>['calls']) =>
  writes(calls).map(({ port, method }) => `${port}.${method}`);

describe('polesar loop on a rate limit', () => {
  let session: LoopSession;
  beforeEach(async () => {
    session = await loopSession();
  });
  afterEach(() => session.close());

  it('pauses without using a retry or touching the ticket, and resumes in the same state after the reset', async () => {
    const script = {
      tickets,
      review: {
        1: [rateLimited, { findings: [missingIndex] }],
      },
    };

    const paused = await session.run(script, { now: '2026-10-15T12:00:00Z' });

    expect(paused.exitCode).toBe(3);
    expect(steps(paused.calls)).toEqual([
      'executor.implement',
      'executor.review',
    ]);
    expect(paused.stdout).toBe(
      'loop paused: rate limited until 2026-10-15T14:00:00.000Z. #1 keeps its place, with no retry used and its labels unchanged: run polesar loop again after then to resume it (0 merged)\n'
    );

    const early = await session.run(script, { now: '2026-10-15T13:00:00Z' });

    expect(early.exitCode).toBe(3);
    expect(steps(early.calls)).toEqual([]);
    expect(early.stdout).toBe(paused.stdout);

    const resumed = await session.run(script, {
      now: '2026-10-15T14:05:00Z',
    });

    expect(resumed.exitCode).toBe(1);
    expect(steps(resumed.calls)).toEqual([
      'executor.review',
      'executor.implement',
      'executor.review',
      'tracker.addLabel',
      'tracker.removeLabel',
      'tracker.comment',
      'executor.implement',
      'executor.review',
      'gate.check',
      'gate.merge',
      'tracker.comment',
      'tracker.close',
    ]);
    const [review] = writes(resumed.calls);
    expect(review?.args[0]).toMatchObject({
      diff: 'diff for #1',
      evidence: 'evidence for #1',
      addressing: [],
      maxTurns: 199,
    });
    const escalation = resumed.calls.find(
      ({ method, args }) => method === 'comment' && args[0] === 1
    );
    expect(escalation?.args[1]).toContain(
      [
        '- review retries used up (1 of 1)',
        '- blocking review finding: no index',
        '',
        'Branch: `polesar/1`',
        '',
        '## Trail',
        '',
        '1. Implement: committed c1',
        '2. Paused for a rate limit until 2026-10-15T14:00:00.000Z before reviewing',
        '3. Review of c1: blocking: no index',
        '4. Implement with review findings: committed c1.2',
        '5. Review of c1.2: blocking: no index',
      ].join('\n')
    );
    expect(resumed.stdout).toBe(
      [
        '#1 Schema: escalated to ready-for-human: review retries used up (1 of 1); blocking review finding: no index',
        '#2 Docs: merged',
        'loop stopped: nothing left on the frontier (1 merged, 1 escalated)',
        '',
      ].join('\n')
    );
  });

  it('reruns the implementer with the same feedback when the limit hit mid-implementation', async () => {
    const script = {
      tickets: tickets.slice(0, 1),
      review: { 1: [{ findings: [missingIndex] }, {}] },
      implement: { 1: [{}, rateLimited, {}] },
    };

    const paused = await session.run(script, { now: '2026-10-15T12:00:00Z' });
    expect(paused.exitCode).toBe(3);

    const resumed = await session.run(script, {
      now: '2026-10-15T14:00:00Z',
    });

    expect(resumed.exitCode).toBe(0);
    const [implement] = writes(resumed.calls);
    expect(implement?.args[0]).toMatchObject({
      feedback: { review: [missingIndex] },
    });
    expect(steps(resumed.calls)).toEqual([
      'executor.implement',
      'executor.review',
      'gate.check',
      'gate.merge',
      'tracker.comment',
      'tracker.close',
    ]);
  });

  it('drops the paused ticket if a human took it off the frontier meanwhile', async () => {
    await session.run(
      { tickets, implement: { 1: rateLimited } },
      { now: '2026-10-15T12:00:00Z' }
    );

    const resumed = await session.run(
      {
        tickets: [
          { number: 1, title: 'Schema', labels: ['ready-for-human'] },
          tickets[1]!,
        ],
      },
      { now: '2026-10-15T14:00:00Z' }
    );

    expect(resumed.exitCode).toBe(0);
    expect(
      resumed.calls
        .filter(({ port }) => port === 'executor')
        .map(
          ({ method, args }) =>
            `${method} #${(args[0] as { ticket: { number: number } }).ticket.number}`
        )
    ).toEqual(['implement #2', 'review #2']);
  });

  it('checks the budget before resuming, and keeps the ticket paused while it stops the run', async () => {
    const script = { tickets, implement: { 1: [rateLimited, {}] } };
    await session.run(script, { now: '2026-10-15T12:00:00Z' });

    const stale = await session.run(
      { ...script, usage: { recordedAt: '2026-10-15T12:00:00Z' } },
      { now: '2026-10-15T14:00:00Z' }
    );

    expect(stale.exitCode).toBe(3);
    expect(steps(stale.calls)).toEqual([]);
    expect(stale.stdout).toContain(
      'loop stopped before the next ticket: the usage reading is stale'
    );

    const resumed = await session.run(script, {
      now: '2026-10-15T14:30:00Z',
    });

    expect(resumed.exitCode).toBe(0);
    const [implement] = writes(resumed.calls);
    expect(implement?.args[0]).toMatchObject({ ticket: { number: 1 } });
  });

  it('gives the pause as JSON with --json', async () => {
    const result = await session.run(
      { tickets, implement: { 1: rateLimited } },
      { now: '2026-10-15T12:00:00Z', args: ['--json'] }
    );

    expect(JSON.parse(result.stdout)).toMatchObject({
      outcomes: [],
      stopped: { reason: 'paused', until: RESET, ticket: 1 },
    });
  });
});
