import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runLoop, writes } from './loop-script.ts';

const budgetConfig = (budget: Record<string, number>) => ({
  'polesar.json': JSON.stringify({ budget }),
});

describe('polesar loop budget', () => {
  describe('per-ticket cap', () => {
    const tickets = [
      { number: 1, title: 'Schema', labels: ['ready-for-agent'] },
      { number: 2, title: 'Docs', labels: ['ready-for-agent'] },
    ];

    it('gives each agent run only the turns the ticket has left', async () => {
      const result = await runLoop(
        {
          tickets: tickets.slice(0, 1),
          implement: { 1: { turns: 30 } },
          review: {
            1: [
              { turns: 5, findings: [{ blocking: true, summary: 'no index' }] },
              { turns: 5 },
            ],
          },
        },
        [],
        budgetConfig({ ticketTurns: 100 })
      );

      expect(result.exitCode).toBe(0);
      const maxTurns = writes(result.calls)
        .filter(({ port }) => port === 'executor')
        .map(
          ({ method, args }) =>
            `${method} ${(args[0] as { maxTurns: number }).maxTurns}`
        );
      expect(maxTurns).toEqual([
        'implement 100',
        'review 70',
        'implement 65',
        'review 35',
      ]);
    });

    it('escalates a ticket whose agent hits the cap, and moves on to the next ticket', async () => {
      const result = await runLoop(
        {
          tickets,
          implement: { 1: { turns: 100, capHit: true } },
        },
        [],
        budgetConfig({ ticketTurns: 100 })
      );

      expect(result.exitCode).toBe(1);
      expect(
        writes(result.calls)
          .filter(({ args }) => args[0] === 1 || isTicket(args[0], 1))
          .map(({ port, method }) => `${port}.${method}`)
      ).toEqual([
        'executor.implement',
        'tracker.addLabel',
        'tracker.removeLabel',
        'tracker.comment',
      ]);
      expect(result.stdout).toBe(
        [
          '#1 Schema: escalated to ready-for-human: per-ticket cap hit: 100 of 100 turns used',
          '#2 Docs: merged',
          'loop stopped: nothing left on the frontier (1 merged, 1 escalated)',
          '',
        ].join('\n')
      );
    });

    it('escalates a ticket whose reviewer hits the cap, without trusting its findings', async () => {
      const result = await runLoop(
        {
          tickets: tickets.slice(0, 1),
          implement: { 1: { turns: 60 } },
          review: { 1: { turns: 40, capHit: true } },
        },
        [],
        budgetConfig({ ticketTurns: 100 })
      );

      expect(result.exitCode).toBe(1);
      expect(result.calls.some(({ method }) => method === 'check')).toBe(false);
      expect(result.stdout).toContain(
        '#1 Schema: escalated to ready-for-human: per-ticket cap hit: 100 of 100 turns used\n'
      );
    });

    it('escalates instead of sending work back when the ticket has no turns left', async () => {
      const result = await runLoop(
        {
          tickets: tickets.slice(0, 1),
          implement: { 1: { turns: 90 } },
          review: {
            1: {
              turns: 10,
              findings: [{ blocking: true, summary: 'no index' }],
            },
          },
        },
        [],
        budgetConfig({ ticketTurns: 100 })
      );

      expect(result.exitCode).toBe(1);
      expect(
        result.calls.filter(({ method }) => method === 'implement')
      ).toHaveLength(1);
      expect(result.stdout).toContain(
        '#1 Schema: escalated to ready-for-human: per-ticket cap hit: 100 of 100 turns used; blocking review finding: no index\n'
      );
    });

    it('defaults to a generous cap of 200 turns', async () => {
      const result = await runLoop({ tickets: tickets.slice(0, 1) });

      const implement = result.calls.find(
        ({ method }) => method === 'implement'
      );
      expect(implement?.args[0]).toMatchObject({ maxTurns: 200 });
    });
  });

  describe('weekly usage', () => {
    const tickets = [
      { number: 1, title: 'Schema', labels: ['ready-for-agent'] },
      { number: 2, title: 'Docs', labels: ['ready-for-agent'] },
      { number: 3, title: 'Tests', labels: ['ready-for-agent'] },
    ];
    const weekly = (usedPercentage: number) => ({
      sevenDay: { usedPercentage },
    });
    const worked = (result: Awaited<ReturnType<typeof runLoop>>) =>
      result.calls
        .filter(({ method }) => method === 'implement')
        .map(
          ({ args }) =>
            (args[0] as { ticket: { number: number } }).ticket.number
        );

    it('starts no new ticket once weekly usage reaches the floor, and says why it stopped', async () => {
      const result = await runLoop({
        tickets,
        usage: [weekly(60), weekly(70)],
      });

      expect(result.exitCode).toBe(3);
      expect(worked(result)).toEqual([1]);
      expect(result.stdout).toBe(
        [
          '#1 Schema: merged',
          'loop stopped before the next ticket: weekly usage is at 70%, at or above the 70% floor for starting a ticket (1 merged)',
          '',
        ].join('\n')
      );
    });

    it('takes the floor from polesar.json', async () => {
      const result = await runLoop(
        { tickets, usage: weekly(75) },
        [],
        budgetConfig({ weeklyFloor: 80 })
      );

      expect(result.exitCode).toBe(0);
      expect(worked(result)).toEqual([1, 2, 3]);
    });

    it('stops once the run has used its cap of weekly usage', async () => {
      const result = await runLoop({
        tickets,
        usage: [weekly(20), weekly(26), weekly(31.04)],
      });

      expect(result.exitCode).toBe(3);
      expect(worked(result)).toEqual([1, 2]);
      expect(result.stdout).toContain(
        'loop stopped before the next ticket: this run has used 11% of weekly usage, at or above the 10% per-run cap (2 merged)\n'
      );
    });

    describe("the loop's share of the week", () => {
      let home: string;
      beforeEach(async () => {
        home = await mkdtemp(path.join(tmpdir(), 'polesar-home-'));
      });
      afterEach(() => rm(home, { recursive: true, force: true }));

      const resetsAt = '2026-10-18T00:00:00.000Z';
      const at = (usedPercentage: number, reset = resetsAt) => ({
        sevenDay: { usedPercentage, resetsAt: reset },
      });

      it('counts across runs in the same week, and stops a run once the loop has used its share', async () => {
        const first = await runLoop(
          { tickets: tickets.slice(0, 1), usage: [at(10), at(18)] },
          [],
          budgetConfig({ loopShare: 8 }),
          { POLESAR_HOME: home }
        );
        expect(first.exitCode).toBe(0);

        const second = await runLoop(
          { tickets: tickets.slice(1), usage: at(30) },
          [],
          budgetConfig({ loopShare: 8 }),
          { POLESAR_HOME: home }
        );

        expect(second.exitCode).toBe(3);
        expect(worked(second)).toEqual([]);
        expect(second.stdout).toBe(
          "loop stopped before the next ticket: the loop has used 8% of this week's usage, at or above its 8% share (0 merged)\n"
        );
      });

      it('starts the count afresh in a new week', async () => {
        await runLoop(
          { tickets: tickets.slice(0, 1), usage: [at(10), at(18)] },
          [],
          budgetConfig({ loopShare: 8 }),
          { POLESAR_HOME: home }
        );

        const nextWeek = await runLoop(
          {
            tickets: tickets.slice(1),
            usage: at(1, '2026-10-25T00:00:00.000Z'),
          },
          [],
          budgetConfig({ loopShare: 8 }),
          { POLESAR_HOME: home }
        );

        expect(nextWeek.exitCode).toBe(0);
        expect(worked(nextWeek)).toEqual([2, 3]);
      });

      it('says what to do when its record of the week is unreadable, rather than starting from zero', async () => {
        await writeFile(path.join(home, 'loop-usage.json'), 'not json');

        const result = await runLoop(
          { tickets, usage: at(10) },
          [],
          {},
          {
            POLESAR_HOME: home,
          }
        );

        expect(result.exitCode).toBe(2);
        expect(worked(result)).toEqual([]);
        expect(result.stderr).toContain(
          `${path.join(home, 'loop-usage.json')} can't be read as the loop's weekly usage. Fix it, or delete it`
        );
      });
    });
  });

  describe('missing or stale usage readings', () => {
    const tickets = [
      { number: 1, title: 'Schema', labels: ['ready-for-agent'] },
    ];

    it('starts no ticket without a reading, and says how to get one', async () => {
      const result = await runLoop({ tickets, usage: null });

      expect(result.exitCode).toBe(3);
      expect(result.calls.some(({ port }) => port === 'executor')).toBe(false);
      expect(result.stdout).toBe(
        "loop stopped before the next ticket: no usage reading, so the budget can't be checked: set `polesar statusline` as your Claude Code status line (see polesar --help) and use Claude Code to refresh it (0 merged)\n"
      );
    });

    it('starts no ticket on a reading without the 7-day window', async () => {
      const result = await runLoop({ tickets, usage: { sevenDay: null } });

      expect(result.exitCode).toBe(3);
      expect(result.stdout).toContain(
        "loop stopped before the next ticket: no 7-day usage reading, so the budget can't be checked"
      );
    });

    it('starts no ticket on a reading older than the budget allows', async () => {
      const result = await runLoop({
        tickets,
        usage: { recordedAt: '2026-10-15T11:15:00.000Z' },
      });

      expect(result.exitCode).toBe(3);
      expect(result.calls.some(({ port }) => port === 'executor')).toBe(false);
      expect(result.stdout).toContain(
        'loop stopped before the next ticket: the usage reading is stale (recorded 45 min ago, over the 30 min limit in budget.maxReadingAgeMinutes)'
      );
    });

    it('takes the age limit from polesar.json', async () => {
      const result = await runLoop(
        { tickets, usage: { recordedAt: '2026-10-15T11:15:00.000Z' } },
        [],
        budgetConfig({ maxReadingAgeMinutes: 60 })
      );

      expect(result.exitCode).toBe(0);
    });

    it('starts no ticket on a reading whose week has reset since', async () => {
      const result = await runLoop({
        tickets,
        usage: { sevenDay: { resetsAt: '2026-10-15T11:59:00.000Z' } },
      });

      expect(result.exitCode).toBe(3);
      expect(result.stdout).toContain(
        "loop stopped before the next ticket: the usage reading's 7-day window reset at 2026-10-15T11:59:00.000Z, after it was recorded"
      );
    });

    it('gives the stop as JSON with --json', async () => {
      const result = await runLoop({ tickets, usage: null }, ['--json']);

      expect(JSON.parse(result.stdout)).toMatchObject({
        outcomes: [],
        stopped: { reason: 'budget', rule: 'no-usage' },
      });
    });
  });

  it('rejects a budget setting it does not know, naming the settings', async () => {
    const result = await runLoop(
      { tickets: [] },
      [],
      budgetConfig({ weeklyFlor: 60 })
    );

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain(
      '"budget.weeklyFlor" is not a budget setting. The settings and their defaults are:'
    );
  });

  it('rejects a percentage above 100', async () => {
    const result = await runLoop(
      { tickets: [] },
      [],
      budgetConfig({ loopShare: 250 })
    );

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain(
      '"budget.loopShare" must be a number above 0 and at most 100 (a percent of weekly usage), got 250'
    );
  });
});

const isTicket = (arg: unknown, number: number) =>
  typeof arg === 'object' &&
  arg !== null &&
  'ticket' in arg &&
  (arg as { ticket: { number: number } }).ticket.number === number;
