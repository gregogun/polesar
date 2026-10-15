import { describe, expect, it } from 'vitest';
import { runLoop, writes } from './loop-script.ts';
import { runCli } from './run-cli.ts';
import { trackerGraph } from './tracker-graph.ts';

describe('polesar loop', () => {
  it('takes a frontier ticket through implement, review and gate, merges it and closes it with an evidence comment', async () => {
    const result = await runLoop({
      tickets: [
        {
          number: 7,
          title: 'Docs',
          body: 'Write the docs.',
          labels: ['ready-for-agent'],
        },
      ],
    });

    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
    expect(
      writes(result.calls).map(({ port, method }) => `${port}.${method}`)
    ).toEqual([
      'executor.implement',
      'executor.review',
      'gate.check',
      'gate.merge',
      'tracker.comment',
      'tracker.close',
    ]);
    const [implement, , check, merge, comment, close] = writes(result.calls);
    expect(implement?.args).toEqual([
      {
        ticket: { number: 7, title: 'Docs', body: 'Write the docs.' },
        branch: 'polesar/7',
      },
    ]);
    expect(check?.args).toEqual([
      {
        ticket: { number: 7, title: 'Docs' },
        branch: 'polesar/7',
        prBody: 'Closes #7\n\n## Evidence\n\nevidence for #7\n',
      },
    ]);
    expect(merge?.args).toEqual([{ ticket: 7, branch: 'polesar/7' }]);
    expect(comment?.args).toEqual([
      7,
      [
        'Merged by polesar from `polesar/7`.',
        '',
        '- Review: no blocking findings',
        '- Gate: all checks passed',
        '- Reviewed commits: c7',
        '',
        '## Evidence',
        '',
        'evidence for #7',
        '',
      ].join('\n'),
    ]);
    expect(close?.args).toEqual([7]);
    expect(result.stdout).toBe(
      '#7 Docs: merged\nloop stopped: nothing left on the frontier (1 merged)\n'
    );
  });

  it('works the frontier one ticket at a time, picking up tickets as their blockers merge, until nothing is left', async () => {
    const result = await runLoop({
      tickets: [
        { number: 1, title: 'Schema', labels: ['ready-for-agent'] },
        {
          number: 2,
          title: 'Migrations',
          labels: ['ready-for-agent'],
          blockedBy: [1],
        },
        { number: 3, title: 'Docs', labels: ['ready-for-agent'] },
        { number: 4, title: 'Untriaged', labels: ['needs-triage'] },
      ],
    });

    expect(result.exitCode).toBe(0);
    const steps = writes(result.calls).map(
      ({ port, method, args }) =>
        `${port}.${method} ${JSON.stringify(args[0]).match(/\d+/)?.[0]}`
    );
    const ticketSteps = (ticket: number) =>
      [
        'executor.implement',
        'executor.review',
        'gate.check',
        'gate.merge',
        'tracker.comment',
        'tracker.close',
      ].map((step) => `${step} ${ticket}`);
    expect(steps).toEqual([
      ...ticketSteps(1),
      ...ticketSteps(2),
      ...ticketSteps(3),
    ]);
    expect(result.stdout).toBe(
      [
        '#1 Schema: merged',
        '#2 Migrations: merged',
        '#3 Docs: merged',
        'loop stopped: nothing left on the frontier (3 merged)',
        '',
      ].join('\n')
    );
  });

  it('reports the ready-for-human tickets still blocking AFK work when it stops', async () => {
    const result = await runLoop({
      tickets: [
        { number: 1, title: 'Pick a database', labels: ['ready-for-human'] },
        {
          number: 2,
          title: 'Schema',
          labels: ['ready-for-agent'],
          blockedBy: [1],
        },
        { number: 3, title: 'Docs', labels: ['ready-for-agent'] },
      ],
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      [
        '#3 Docs: merged',
        'loop stopped: nothing left on the frontier (1 merged)',
        '',
        'ready-for-human tickets blocking AFK work:',
        '  #1 Pick a database (unblocks 1)',
        '',
      ].join('\n')
    );
    const implemented = result.calls
      .filter(({ method }) => method === 'implement')
      .map(({ args }) => (args[0] as { branch: string }).branch);
    expect(implemented).toEqual(['polesar/3']);
  });

  describe('merges only when the gate is green, nothing blocks, every commit was reviewed and the evidence file exists', () => {
    const tickets = [
      { number: 1, title: 'Schema', labels: ['ready-for-agent'] },
      { number: 2, title: 'Docs', labels: ['ready-for-agent'] },
    ];

    /** Ticket 1 is held: never merged or closed. Ticket 2 still merges. */
    const expectHeld = (result: Awaited<ReturnType<typeof runLoop>>) => {
      expect(result.exitCode).toBe(1);
      const merged = result.calls
        .filter(({ method }) => method === 'merge' || method === 'close')
        .map(({ method, args }) => `${method} ${JSON.stringify(args[0])}`);
      expect(merged).toEqual([
        'merge {"ticket":2,"branch":"polesar/2"}',
        'close 2',
      ]);
      expect(
        result.calls.some(
          ({ port, method, args }) =>
            port === 'tracker' && method !== 'openTickets' && args[0] === 1
        )
      ).toBe(false);
    };

    it('holds a ticket whose gate is red', async () => {
      const result = await runLoop({
        tickets,
        gate: { 1: { green: false, summary: 'test failed: schema.test.ts' } },
      });

      expectHeld(result);
      expect(result.stdout).toBe(
        [
          '#1 Schema: held, not merged: gate red: test failed: schema.test.ts',
          '#2 Docs: merged',
          'loop stopped: nothing left to try; held tickets stay on the frontier (1 merged, 1 held)',
          '',
        ].join('\n')
      );
    });

    it('holds a ticket with blocking review findings, without spending a gate run on it', async () => {
      const result = await runLoop({
        tickets,
        review: {
          1: {
            findings: [
              { blocking: true, summary: 'drops the index the spec asks for' },
              { blocking: false, summary: 'rename tmp' },
            ],
          },
        },
      });

      expectHeld(result);
      expect(result.stdout).toContain(
        '#1 Schema: held, not merged: blocking review finding: drops the index the spec asks for\n'
      );
      const checked = result.calls
        .filter(({ method }) => method === 'check')
        .map(({ args }) => (args[0] as { branch: string }).branch);
      expect(checked).toEqual(['polesar/2']);
    });

    it('holds a ticket whose gate ran on a commit the reviewer never saw', async () => {
      const result = await runLoop({
        tickets,
        gate: { 1: { commits: ['c1', 'late'] } },
      });

      expectHeld(result);
      expect(result.stdout).toContain(
        '#1 Schema: held, not merged: unreviewed commits: late\n'
      );
    });

    it('holds a ticket whose gate reports no commits, so an unreviewed branch cannot pass by saying nothing', async () => {
      const result = await runLoop({ tickets, gate: { 1: { commits: [] } } });

      expectHeld(result);
      expect(result.stdout).toContain(
        '#1 Schema: held, not merged: gate reported no commits\n'
      );
    });

    it('treats an empty evidence file as no evidence file', async () => {
      const result = await runLoop({
        tickets,
        implement: { 1: { evidence: ' \n' } },
      });

      expectHeld(result);
      expect(result.stdout).toContain(
        '#1 Schema: held, not merged: no evidence file\n'
      );
    });

    it('holds a ticket with no evidence file, without spending a review or gate run on it', async () => {
      const result = await runLoop({
        tickets,
        implement: { 1: { evidence: null } },
      });

      expectHeld(result);
      expect(result.stdout).toContain(
        '#1 Schema: held, not merged: no evidence file\n'
      );
      const judged = result.calls
        .filter(({ method }) => method === 'review' || method === 'check')
        .map(
          ({ args }) =>
            (args[0] as { ticket: { number: number } }).ticket.number
        );
      expect(judged).toEqual([2, 2]);
    });

    it('holds a ticket the implementer made no commits for', async () => {
      const result = await runLoop({
        tickets,
        implement: { 1: { commits: [] } },
      });

      expectHeld(result);
      expect(result.stdout).toContain(
        '#1 Schema: held, not merged: no commits\n'
      );
    });
  });

  it("gives the reviewer only the ticket, diff, evidence file and the repo's standards docs, never the implementer's transcript", async () => {
    const result = await runLoop(
      {
        tickets: [
          {
            number: 7,
            title: 'Docs',
            body: 'Write the docs.',
            labels: ['ready-for-agent'],
          },
        ],
        implement: {
          7: {
            diff: '+# Docs',
            evidence: 'measured: pnpm test passed',
            transcript: 'I skipped the flaky test, nobody will notice',
          },
        },
      },
      [],
      {
        'AGENTS.md': 'Use the glossary.',
        'CLAUDE.md': '@AGENTS.md',
        'GLOSSARY.md': 'Ticket: a GitHub issue.',
        'docs/adr/0002-b.md': '# B',
        'docs/adr/0001-a.md': '# A',
        'README.md': 'Not a standards doc.',
      }
    );

    expect(result.exitCode).toBe(0);
    const review = result.calls.find(({ method }) => method === 'review');
    expect(review?.args).toEqual([
      {
        ticket: { number: 7, title: 'Docs', body: 'Write the docs.' },
        diff: '+# Docs',
        evidence: 'measured: pnpm test passed',
        standards: [
          { path: 'AGENTS.md', content: 'Use the glossary.' },
          { path: 'CLAUDE.md', content: '@AGENTS.md' },
          { path: 'GLOSSARY.md', content: 'Ticket: a GitHub issue.' },
          { path: 'docs/adr/0001-a.md', content: '# A' },
          { path: 'docs/adr/0002-b.md', content: '# B' },
        ],
      },
    ]);
  });

  describe('--dry-run', () => {
    const tickets = [
      { number: 1, title: 'Pick a database', labels: ['ready-for-human'] },
      {
        number: 2,
        title: 'Schema',
        labels: ['ready-for-agent'],
        blockedBy: [1],
      },
      { number: 3, title: 'Docs', labels: ['ready-for-agent'] },
      { number: 4, title: 'Tests', labels: ['ready-for-agent'] },
    ];

    it('shows the planned transitions for the frontier without running an agent or changing anything', async () => {
      const result = await runLoop({ tickets }, ['--dry-run']);

      expect(result.stderr).toBe('');
      expect(result.exitCode).toBe(0);
      expect(writes(result.calls)).toEqual([]);
      expect(result.stdout).toBe(
        [
          'dry run: 2 tickets on the frontier, worked one at a time:',
          '  #3 Docs: implement on polesar/3 → review → gate → merge → close',
          '  #4 Tests: implement on polesar/4 → review → gate → merge → close',
          'Tickets they unblock are worked as they merge. Nothing was changed.',
          '',
          'ready-for-human tickets blocking AFK work:',
          '  #1 Pick a database (unblocks 1)',
          '',
        ].join('\n')
      );
    });

    it('needs no executor or gate, and gives the plan as JSON with --json', async () => {
      const result = await runCli(
        ['loop', '--dry-run', '--json'],
        trackerGraph(tickets)
      );

      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        planned: [
          {
            number: 3,
            title: 'Docs',
            branch: 'polesar/3',
            steps: ['implement', 'review', 'gate', 'merge', 'close'],
          },
          {
            number: 4,
            title: 'Tests',
            branch: 'polesar/4',
            steps: ['implement', 'review', 'gate', 'merge', 'close'],
          },
        ],
        humanBlockers: [
          {
            number: 1,
            title: 'Pick a database',
            unblocks: 1,
            waiting: 1,
            blockedBy: [],
          },
        ],
      });
    });
  });

  it('gives each outcome and the human blockers as JSON with --json', async () => {
    const result = await runLoop(
      {
        tickets: [
          { number: 1, title: 'Schema', labels: ['ready-for-agent'] },
          { number: 2, title: 'Docs', labels: ['ready-for-agent'] },
        ],
        gate: { 1: { green: false, summary: 'lint failed' } },
      },
      ['--json']
    );

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual({
      outcomes: [
        {
          number: 1,
          title: 'Schema',
          merged: false,
          held: ['gate red: lint failed'],
        },
        { number: 2, title: 'Docs', merged: true, held: [] },
      ],
      humanBlockers: [],
    });
  });

  it('says what to do when there is no executor yet, before touching any ticket', async () => {
    const result = await runCli(
      ['loop'],
      trackerGraph([{ number: 1, title: 'Docs', labels: ['ready-for-agent'] }])
    );

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe(
      'polesar: polesar loop has no executor yet: the Sandcastle adapter is not built (gregogun/polesar#13). Run `polesar loop --dry-run` to see what it would do.\n'
    );
  });
});
