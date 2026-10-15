import { describe, expect, it } from 'vitest';
import { trackerGraph, type ScriptedTicket } from './tracker-graph.ts';
import { runCli } from './run-cli.ts';

const frontier = (tickets: ScriptedTicket[], args: string[] = []) =>
  runCli(['frontier', ...args], trackerGraph(tickets));

describe('polesar frontier', () => {
  it('lists open ready-for-agent tickets whose blockers are all closed', async () => {
    const result = await frontier([
      { number: 1, title: 'Done blocker', state: 'closed' },
      {
        number: 2,
        title: 'Unblocked',
        labels: ['ready-for-agent'],
        blockedBy: [1],
      },
      { number: 3, title: 'Open blocker', labels: ['needs-triage'] },
      {
        number: 4,
        title: 'Still blocked',
        labels: ['ready-for-agent'],
        blockedBy: [1, 3],
      },
      { number: 5, title: 'No blockers', labels: ['ready-for-agent'] },
      {
        number: 6,
        title: 'Closed work',
        state: 'closed',
        labels: ['ready-for-agent'],
      },
      { number: 7, title: 'Untriaged', labels: ['needs-triage'] },
    ]);

    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      'frontier: 2 tickets\n  #2 Unblocked\n  #5 No blockers\n'
    );
  });

  it('never includes ready-for-human tickets, and reports those blocking AFK work with how many tickets they unblock', async () => {
    const result = await frontier([
      { number: 1, title: 'Pick a database', labels: ['ready-for-human'] },
      {
        number: 2,
        title: 'Schema',
        labels: ['ready-for-agent'],
        blockedBy: [1],
      },
      {
        number: 3,
        title: 'Migrations',
        labels: ['ready-for-agent'],
        blockedBy: [2],
      },
      { number: 4, title: 'Name the product', labels: ['ready-for-human'] },
      { number: 5, title: 'Logo', labels: ['needs-triage'], blockedBy: [4] },
      {
        number: 6,
        title: 'Both labels',
        labels: ['ready-for-agent', 'ready-for-human'],
      },
      { number: 7, title: 'Docs', labels: ['ready-for-agent'] },
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      [
        'frontier: 1 ticket',
        '  #7 Docs',
        '',
        'ready-for-human tickets blocking AFK work:',
        '  #1 Pick a database (unblocks 2)',
        '',
      ].join('\n')
    );
  });

  it('counts as unblocked only the AFK work the loop could then finish on its own, and how much more waits on it', async () => {
    const result = await frontier([
      { number: 1, title: 'Pick a database', labels: ['ready-for-human'] },
      { number: 2, title: 'Pick a host', labels: ['ready-for-human'] },
      { number: 3, title: 'Docs', labels: ['ready-for-agent'] },
      {
        number: 4,
        title: 'Schema',
        labels: ['ready-for-agent'],
        // The loop clears #3 itself, so only #1 stands in the way.
        blockedBy: [1, 3],
      },
      {
        number: 5,
        title: 'Deploy',
        labels: ['ready-for-agent'],
        // Needs both decisions: neither frees it alone.
        blockedBy: [1, 2],
      },
      { number: 6, title: 'Spike', labels: ['needs-triage'], blockedBy: [1] },
      {
        number: 7,
        title: 'Follow-up',
        labels: ['ready-for-agent'],
        // Waits on #1 only through a ticket the loop can't do.
        blockedBy: [6],
      },
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      [
        'frontier: 1 ticket',
        '  #3 Docs',
        '',
        'ready-for-human tickets blocking AFK work:',
        '  #1 Pick a database (unblocks 1; 3 wait on it)',
        '  #2 Pick a host (unblocks 0; 1 waits on it)',
        '',
      ].join('\n')
    );
  });

  it('says when a ready-for-human ticket blocking AFK work is itself blocked', async () => {
    const result = await frontier([
      { number: 1, title: 'Prototype', labels: ['ready-for-agent'] },
      {
        number: 2,
        title: 'Choose the API',
        labels: ['ready-for-human'],
        blockedBy: [1, { repo: 'acme/lib', number: 9, state: 'open' }],
      },
      {
        number: 3,
        title: 'Build the API',
        labels: ['ready-for-agent'],
        blockedBy: [2],
      },
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      '  #2 Choose the API (unblocks 1; blocked by #1, acme/lib#9)\n'
    );
  });

  it('treats a blocker in another repo as its own ticket, not the local ticket with its number', async () => {
    const result = await frontier([
      { number: 1, title: 'Local decision', labels: ['ready-for-human'] },
      {
        number: 2,
        title: 'Waits on a dependency',
        labels: ['ready-for-agent'],
        blockedBy: [{ repo: 'acme/lib', number: 1, state: 'open' }],
      },
      {
        number: 3,
        title: 'Dependency shipped',
        labels: ['ready-for-agent'],
        blockedBy: [{ repo: 'acme/lib', number: 5, state: 'closed' }],
      },
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('frontier: 1 ticket\n  #3 Dependency shipped\n');
  });

  it('gives the frontier and human blockers as JSON with --json', async () => {
    const result = await frontier(
      [
        { number: 1, title: 'Decide', labels: ['ready-for-human'] },
        {
          number: 2,
          title: 'Build',
          labels: ['ready-for-agent'],
          blockedBy: [1],
        },
        { number: 3, title: 'Docs', labels: ['ready-for-agent'] },
      ],
      ['--json']
    );

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      tickets: [{ number: 3, title: 'Docs' }],
      humanBlockers: [
        { number: 1, title: 'Decide', unblocks: 1, waiting: 1, blockedBy: [] },
      ],
    });
  });

  it('says so when nothing is on the frontier', async () => {
    const result = await frontier([
      { number: 1, title: 'Untriaged', labels: ['needs-triage'] },
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('frontier: 0 tickets\n');
  });

  it('reads GitHub by default, and exits 1 saying what to do when gh is missing', async () => {
    const result = await runCli(['frontier'], { env: { PATH: '' } });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe(
      'polesar: gh is not installed. Install the GitHub CLI (https://cli.github.com) and run `gh auth login`.\n'
    );
  });
});
