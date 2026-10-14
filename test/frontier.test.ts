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
      humanBlockers: [{ number: 1, title: 'Decide', unblocks: 1 }],
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
