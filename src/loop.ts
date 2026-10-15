import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  Executor,
  Finding,
  StandardsDoc,
  TicketSpec,
} from './executor.ts';
import { frontierOf, type HumanBlocker } from './frontier.ts';
import type { Gate, GateResult } from './gate.ts';
import {
  evidenceComment,
  prBody,
  type Outcome,
  type Plan,
} from './templates.ts';
import type { Ticket, Tracker } from './tracker.ts';

type LoopPorts = { tracker: Tracker; executor: Executor; gate: Gate };

export type LoopResult = {
  outcomes: Outcome[];
  /** ready-for-human tickets still holding up AFK work when the run stopped. */
  humanBlockers: HumanBlocker[];
};

/** The loop can't run; the message says what to do next. */
export class LoopError extends Error {
  override name = 'LoopError';
}

/** Stand-ins for ports with no real adapter yet, so `polesar loop` says so rather than running half a loop. */
export const unavailable = {
  executor: () =>
    Promise.reject<never>(
      new LoopError(
        'polesar loop has no executor yet: the Sandcastle adapter is not built (gregogun/polesar#13). Run `polesar loop --dry-run` to see what it would do.'
      )
    ),
  gate: () =>
    Promise.reject<never>(
      new LoopError(
        'polesar loop has no gate yet: the CI adapter is not built (gregogun/polesar#12). Run `polesar loop --dry-run` to see what it would do.'
      )
    ),
};

const blockingFindings = (findings: Finding[]) =>
  findings
    .filter((finding) => finding.blocking)
    .map((finding) => `blocking review finding: ${finding.summary}`);

/**
 * The merge condition (must-pass #1): why the branch can't merge, or nothing
 * when the gate is green, nothing blocks, every commit on it was reviewed and
 * the evidence file exists.
 */
const mergeBlockers = ({
  gate,
  findings,
  reviewed,
  evidence,
}: {
  gate: GateResult;
  findings: Finding[];
  reviewed: string[];
  evidence: string | null;
}): string[] => {
  const unreviewed = gate.commits.filter(
    (commit) => !reviewed.includes(commit)
  );
  return [
    ...(gate.green ? [] : [`gate red: ${gate.summary}`]),
    ...blockingFindings(findings),
    ...(unreviewed.length > 0
      ? [`unreviewed commits: ${unreviewed.join(', ')}`]
      : []),
    ...(evidence === null ? ['no evidence file'] : []),
  ];
};

const STANDARDS_FILES = ['AGENTS.md', 'CLAUDE.md', 'GLOSSARY.md'];
const ADR_DIR = 'docs/adr';

const readIfPresent = (file: string) =>
  readFile(file, 'utf8').catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  });

/**
 * The repo docs the reviewer judges against: agent instructions, the glossary
 * and the ADRs, read from `cwd` (the main checkout, so a branch can't rewrite
 * its own standards). Missing ones are skipped.
 */
const readStandards = async (cwd: string): Promise<StandardsDoc[]> => {
  const adrs = (
    await readdir(path.join(cwd, ADR_DIR)).catch(() => [] as string[])
  )
    .filter((name) => name.endsWith('.md'))
    .sort()
    .map((name) => `${ADR_DIR}/${name}`);
  const docs = await Promise.all(
    [...STANDARDS_FILES, ...adrs].map(async (file) => ({
      path: file,
      content: await readIfPresent(path.join(cwd, file)),
    }))
  );
  return docs.filter((doc): doc is StandardsDoc => doc.content !== undefined);
};

const branchFor = (ticket: number) => `polesar/${ticket}`;

/** Takes one ticket through implement, review and gate, merging only when the merge condition holds. */
const work = async (
  { tracker, executor, gate }: LoopPorts,
  standards: StandardsDoc[],
  { number, title, body }: Ticket
): Promise<Outcome> => {
  const ticket: TicketSpec = { number, title, body };
  const branch = branchFor(number);
  const hold = (held: string[]) => ({ number, title, merged: false, held });
  const implementation = await executor.implement({ ticket, branch });
  const { commits, diff, evidence } = implementation;
  if (commits.length === 0) return hold(['no commits']);
  if (evidence === null) return hold(['no evidence file']);
  const { findings } = await executor.review({
    ticket,
    diff,
    evidence,
    standards,
  });
  const blocking = blockingFindings(findings);
  if (blocking.length > 0) return hold(blocking);
  const checked = await gate.check({
    ticket: { number, title },
    branch,
    prBody: prBody({ ticket: number, evidence }),
  });
  // The whole condition again, on what the gate ran: merging is one checked condition, whatever led here.
  const held = mergeBlockers({
    gate: checked,
    findings,
    reviewed: commits,
    evidence,
  });
  if (held.length > 0) return hold(held);
  await gate.merge({ ticket: number, branch });
  await tracker.comment(
    number,
    evidenceComment({
      ticket: number,
      branch,
      evidence,
      gateSummary: checked.summary,
      reviewed: commits,
    })
  );
  await tracker.close(number);
  return { number, title, merged: true, held: [] };
};

/**
 * Works the frontier one ticket at a time until nothing is left on it, taking
 * each ticket at most once per run. Standards docs are read from `cwd`;
 * `onOutcome` hears about each ticket as it finishes.
 */
export const runLoop = async (
  ports: LoopPorts,
  { cwd, onOutcome }: { cwd: string; onOutcome: (outcome: Outcome) => void }
): Promise<LoopResult> => {
  const standards = await readStandards(cwd);
  const outcomes: Outcome[] = [];
  const tried = new Set<number>();
  for (;;) {
    const open = await ports.tracker.openTickets();
    const { tickets, humanBlockers } = frontierOf(open);
    const next = tickets.find(({ number }) => !tried.has(number));
    const ticket = open.find(({ number }) => number === next?.number);
    if (ticket === undefined) return { outcomes, humanBlockers };
    tried.add(ticket.number);
    const outcome = await work(ports, standards, ticket);
    outcomes.push(outcome);
    onOutcome(outcome);
  }
};

const STEPS = ['implement', 'review', 'gate', 'merge', 'close'];

/** What a run would do with today's frontier, read without changing anything. */
export const planLoop = async (tracker: Tracker): Promise<Plan> => {
  const { tickets, humanBlockers } = frontierOf(await tracker.openTickets());
  return {
    planned: tickets.map(({ number, title }) => ({
      number,
      title,
      branch: branchFor(number),
      steps: STEPS,
    })),
    humanBlockers,
  };
};
