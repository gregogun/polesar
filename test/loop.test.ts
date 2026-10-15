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

  describe('merges only when the gate is green, nothing blocks, every commit was reviewed and the evidence file exists, escalating otherwise', () => {
    const tickets = [
      { number: 1, title: 'Schema', labels: ['ready-for-agent'] },
      { number: 2, title: 'Docs', labels: ['ready-for-agent'] },
    ];

    /** Ticket 1 is escalated, never merged or closed. Ticket 2 still merges. */
    const expectEscalated = (result: Awaited<ReturnType<typeof runLoop>>) => {
      expect(result.exitCode).toBe(1);
      const merged = result.calls
        .filter(({ method }) => method === 'merge' || method === 'close')
        .map(({ method, args }) => `${method} ${JSON.stringify(args[0])}`);
      expect(merged).toEqual([
        'merge {"ticket":2,"branch":"polesar/2"}',
        'close 2',
      ]);
      const labels = result.calls
        .filter(({ method }) => method.endsWith('Label'))
        .map(({ method, args }) => `${method} ${args.join(' ')}`);
      expect(labels).toEqual([
        'addLabel 1 ready-for-human',
        'removeLabel 1 ready-for-agent',
      ]);
    };

    it('escalates a ticket whose gate ran on a commit the reviewer never saw', async () => {
      const result = await runLoop({
        tickets,
        gate: { 1: { commits: ['c1', 'late'] } },
      });

      expectEscalated(result);
      expect(result.stdout).toContain(
        '#1 Schema: escalated to ready-for-human: unreviewed commits: late\n'
      );
    });

    it('escalates a ticket whose gate reports no commits, so an unreviewed branch cannot pass by saying nothing', async () => {
      const result = await runLoop({ tickets, gate: { 1: { commits: [] } } });

      expectEscalated(result);
      expect(result.stdout).toContain(
        '#1 Schema: escalated to ready-for-human: gate reported no commits\n'
      );
    });

    it('treats an empty evidence file as no evidence file', async () => {
      const result = await runLoop({
        tickets,
        implement: { 1: { evidence: ' \n' } },
      });

      expectEscalated(result);
      expect(result.stdout).toContain(
        '#1 Schema: escalated to ready-for-human: no evidence file\n'
      );
    });

    it('escalates a ticket with no evidence file, without spending a review or gate run on it', async () => {
      const result = await runLoop({
        tickets,
        implement: { 1: { evidence: null } },
      });

      expectEscalated(result);
      expect(result.stdout).toContain(
        '#1 Schema: escalated to ready-for-human: no evidence file\n'
      );
      const judged = result.calls
        .filter(({ method }) => method === 'review' || method === 'check')
        .map(
          ({ args }) =>
            (args[0] as { ticket: { number: number } }).ticket.number
        );
      expect(judged).toEqual([2, 2]);
    });

    it('escalates a ticket the implementer made no commits for', async () => {
      const result = await runLoop({
        tickets,
        implement: { 1: { commits: [] } },
      });

      expectEscalated(result);
      expect(result.stdout).toContain(
        '#1 Schema: escalated to ready-for-human: no commits\n'
      );
    });
  });

  describe('failure paths', () => {
    const ticket = { number: 1, title: 'Schema', labels: ['ready-for-agent'] };
    const missingIndex = {
      blocking: true,
      summary: 'drops the index the spec asks for',
    };

    it('sends blocking findings back to the implementer once, reviews just the fix, and merges it', async () => {
      const result = await runLoop({
        tickets: [ticket],
        review: { 1: [{ findings: [missingIndex] }, { findings: [] }] },
      });

      expect(result.stderr).toBe('');
      expect(result.exitCode).toBe(0);
      expect(
        writes(result.calls).map(({ port, method }) => `${port}.${method}`)
      ).toEqual([
        'executor.implement',
        'executor.review',
        'executor.implement',
        'executor.review',
        'gate.check',
        'gate.merge',
        'tracker.comment',
        'tracker.close',
      ]);
      const [, , fix, reReview] = writes(result.calls);
      expect(fix?.args).toEqual([
        {
          ticket: { number: 1, title: 'Schema', body: '' },
          branch: 'polesar/1',
          feedback: { review: [missingIndex] },
        },
      ]);
      expect(reReview?.args[0]).toMatchObject({
        diff: 'diff for #1.2',
        addressing: [missingIndex],
      });
      expect(result.stdout).toBe(
        '#1 Schema: merged\nloop stopped: nothing left on the frontier (1 merged)\n'
      );
    });

    it('escalates when the review of the fix still blocks, so work cannot bounce between implementer and reviewer forever', async () => {
      const result = await runLoop({
        tickets: [ticket],
        review: { 1: { findings: [missingIndex] } },
      });

      expect(result.exitCode).toBe(1);
      expect(
        writes(result.calls).map(({ port, method }) => `${port}.${method}`)
      ).toEqual([
        'executor.implement',
        'executor.review',
        'executor.implement',
        'executor.review',
        'tracker.addLabel',
        'tracker.removeLabel',
        'tracker.comment',
      ]);
      const labels = result.calls
        .filter(({ method }) => method.endsWith('Label'))
        .map(({ method, args }) => `${method} ${args.join(' ')}`);
      expect(labels).toEqual([
        'addLabel 1 ready-for-human',
        'removeLabel 1 ready-for-agent',
      ]);
      const comment = result.calls.find(({ method }) => method === 'comment');
      expect(comment?.args).toEqual([
        1,
        [
          'Escalated to ready-for-human by polesar.',
          '',
          '- review retries used up (1 of 1)',
          '- blocking review finding: drops the index the spec asks for',
          '',
          'Branch: `polesar/1`',
          '',
          '## Trail',
          '',
          '1. Implement: committed c1',
          '2. Review of c1: blocking: drops the index the spec asks for',
          '3. Implement with review findings: committed c1.2',
          '4. Review of c1.2: blocking: drops the index the spec asks for',
          '',
          '## Evidence',
          '',
          'evidence for #1',
          '',
        ].join('\n'),
      ]);
      expect(result.stdout).toBe(
        [
          '#1 Schema: escalated to ready-for-human: review retries used up (1 of 1); blocking review finding: drops the index the spec asks for',
          'loop stopped: nothing left on the frontier (0 merged, 1 escalated)',
          '',
        ].join('\n')
      );
    });

    it('reruns a red gate once with no agent; green with no code change merges and records a flaky gate without using a CI retry', async () => {
      const result = await runLoop(
        {
          tickets: [ticket],
          gate: {
            1: [{ green: false, summary: 'test failed: clock.test.ts' }, {}],
          },
        },
        ['--json']
      );

      expect(result.exitCode).toBe(0);
      expect(
        writes(result.calls).map(({ port, method }) => `${port}.${method}`)
      ).toEqual([
        'executor.implement',
        'executor.review',
        'gate.check',
        'gate.rerun',
        'gate.merge',
        'tracker.comment',
        'tracker.close',
      ]);
      const rerun = result.calls.find(({ method }) => method === 'rerun');
      expect(rerun?.args).toEqual([{ ticket: 1, branch: 'polesar/1' }]);
      const comment = result.calls.find(({ method }) => method === 'comment');
      expect(comment?.args[1]).toContain(
        '- Flaky gate: test failed: clock.test.ts (green on rerun with no code change)\n'
      );
      expect(JSON.parse(result.stdout)).toMatchObject({
        outcomes: [
          { number: 1, merged: true, flaky: ['test failed: clock.test.ts'] },
        ],
      });
    });

    it('sends a gate still red after its rerun back to the implementer with the failure summary, reviews just the fix, and merges once green', async () => {
      const red = { green: false, summary: 'test failed: schema.test.ts' };
      const result = await runLoop({
        tickets: [ticket],
        gate: { 1: [red, red, {}] },
      });

      expect(result.stderr).toBe('');
      expect(result.exitCode).toBe(0);
      expect(
        writes(result.calls).map(({ port, method }) => `${port}.${method}`)
      ).toEqual([
        'executor.implement',
        'executor.review',
        'gate.check',
        'gate.rerun',
        'executor.implement',
        'executor.review',
        'gate.check',
        'gate.merge',
        'tracker.comment',
        'tracker.close',
      ]);
      const [, , , , fix, reReview] = writes(result.calls);
      expect(fix?.args[0]).toMatchObject({
        feedback: { gate: 'test failed: schema.test.ts' },
      });
      expect(reReview?.args[0]).toMatchObject({
        diff: 'diff for #1.2',
        addressing: [],
      });
      const comment = result.calls.find(({ method }) => method === 'comment');
      expect(comment?.args[1]).toContain('- Reviewed commits: c1, c1.2\n');
    });

    it('escalates with every CI summary in the trail once the gate is still red after two CI retries', async () => {
      const result = await runLoop({
        tickets: [ticket],
        gate: { 1: { green: false, summary: 'lint failed' } },
      });

      expect(result.exitCode).toBe(1);
      const steps = writes(result.calls).map(
        ({ port, method }) => `${port}.${method}`
      );
      const attempt = [
        'executor.implement',
        'executor.review',
        'gate.check',
        'gate.rerun',
      ];
      expect(steps).toEqual([
        ...attempt,
        ...attempt,
        ...attempt,
        'tracker.addLabel',
        'tracker.removeLabel',
        'tracker.comment',
      ]);
      const comment = result.calls.find(({ method }) => method === 'comment');
      expect(comment?.args[1]).toBe(
        [
          'Escalated to ready-for-human by polesar.',
          '',
          '- CI retries used up (2 of 2)',
          '- gate red: lint failed',
          '',
          'Branch: `polesar/1`',
          '',
          '## Trail',
          '',
          '1. Implement: committed c1',
          '2. Review of c1: no findings',
          '3. Gate on c1: red: lint failed',
          '4. Gate rerun on c1: red: lint failed',
          '5. Implement with gate failure: committed c1.2',
          '6. Review of c1.2: no findings',
          '7. Gate on c1, c1.2: red: lint failed',
          '8. Gate rerun on c1, c1.2: red: lint failed',
          '9. Implement with gate failure: committed c1.3',
          '10. Review of c1.3: no findings',
          '11. Gate on c1, c1.2, c1.3: red: lint failed',
          '12. Gate rerun on c1, c1.2, c1.3: red: lint failed',
          '',
          '## Evidence',
          '',
          'evidence for #1',
          '',
        ].join('\n')
      );
    });

    it('counts blocking findings from the review of a CI fix against the same review budget', async () => {
      const red = { green: false, summary: 'test failed: schema.test.ts' };
      const result = await runLoop({
        tickets: [ticket],
        review: {
          1: [{ findings: [missingIndex] }, {}, { findings: [missingIndex] }],
        },
        gate: { 1: [red, red] },
      });

      expect(result.exitCode).toBe(1);
      expect(
        writes(result.calls).map(({ port, method }) => `${port}.${method}`)
      ).toEqual([
        'executor.implement',
        'executor.review',
        'executor.implement',
        'executor.review',
        'gate.check',
        'gate.rerun',
        'executor.implement',
        'executor.review',
        'tracker.addLabel',
        'tracker.removeLabel',
        'tracker.comment',
      ]);
      expect(result.stdout).toContain(
        '#1 Schema: escalated to ready-for-human: review retries used up (1 of 1); blocking review finding: drops the index the spec asks for\n'
      );
    });

    it('posts non-blocking findings on the PR and logs them without blocking the merge', async () => {
      const result = await runLoop({
        tickets: [ticket],
        review: {
          1: { findings: [{ blocking: false, summary: 'rename tmp' }] },
        },
      });

      expect(result.exitCode).toBe(0);
      const check = result.calls.find(({ method }) => method === 'check');
      expect(check?.args[0]).toMatchObject({
        prBody: [
          'Closes #1',
          '',
          '## Evidence',
          '',
          'evidence for #1',
          '',
          '## Non-blocking review findings',
          '',
          '- rename tmp',
          '',
        ].join('\n'),
      });
      const comment = result.calls.find(({ method }) => method === 'comment');
      expect(comment?.args[1]).toContain(
        '- Non-blocking findings: rename tmp\n'
      );
      expect(result.stdout).toBe(
        [
          '#1 Schema: merged',
          '  non-blocking finding: rename tmp',
          'loop stopped: nothing left on the frontier (1 merged)',
          '',
        ].join('\n')
      );
    });

    it('escalates when the implementer sent back with findings makes no new commits, without reviewing again', async () => {
      const result = await runLoop({
        tickets: [ticket],
        implement: { 1: [{}, { commits: ['c1'] }] },
        review: { 1: { findings: [missingIndex] } },
      });

      expect(result.exitCode).toBe(1);
      expect(
        writes(result.calls).map(({ port, method }) => `${port}.${method}`)
      ).toEqual([
        'executor.implement',
        'executor.review',
        'executor.implement',
        'tracker.addLabel',
        'tracker.removeLabel',
        'tracker.comment',
      ]);
      expect(result.stdout).toContain(
        '#1 Schema: escalated to ready-for-human: no new commits\n'
      );
    });

    it('escalates when a rerun turns green on different commits, since a rerun with no agent cannot change the code', async () => {
      const result = await runLoop({
        tickets: [ticket],
        gate: {
          1: [{ green: false, summary: 'lint failed' }, { commits: ['other'] }],
        },
      });

      expect(result.exitCode).toBe(1);
      expect(result.calls.some(({ method }) => method === 'merge')).toBe(false);
      expect(result.stdout).toContain(
        '#1 Schema: escalated to ready-for-human: gate rerun ran on other, not c1\n'
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
        addressing: [],
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
          escalated: ['CI retries used up (2 of 2)', 'gate red: lint failed'],
          nonBlocking: [],
          flaky: [],
        },
        {
          number: 2,
          title: 'Docs',
          merged: true,
          escalated: [],
          nonBlocking: [],
          flaky: [],
        },
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
