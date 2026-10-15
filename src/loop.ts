import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  Executor,
  Feedback,
  Finding,
  StandardsDoc,
  TicketSpec,
} from './executor.ts';
import {
  frontierOf,
  READY_FOR_AGENT,
  READY_FOR_HUMAN,
  type HumanBlocker,
} from './frontier.ts';
import type { Gate, GateResult } from './gate.ts';
import {
  escalationComment,
  evidenceComment,
  prBody,
  type Outcome,
  type Plan,
  type Step,
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

/** An evidence file that's missing or blank proves nothing. */
const hasEvidence = (evidence: string | null): evidence is string =>
  evidence !== null && evidence.trim() !== '';

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
    ...(gate.commits.length === 0 ? ['gate reported no commits'] : []),
    ...blockingFindings(findings),
    ...(unreviewed.length > 0
      ? [`unreviewed commits: ${unreviewed.join(', ')}`]
      : []),
    ...(hasEvidence(evidence) ? [] : ['no evidence file']),
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

const sameCommits = (a: string[], b: string[]) =>
  a.length === b.length && a.every((commit, index) => commit === b[index]);

const branchFor = (ticket: number) => `polesar/${ticket}`;

/** How many times blocking findings may send work back to the implementer, counting reviews of fixes. */
const REVIEW_RETRIES = 1;

/** How many times a gate still red after its free rerun may send work back to the implementer. */
const CI_RETRIES = 2;

/**
 * Downgrades the ticket to ready-for-human with the full trail. ready-for-human
 * goes on first, so a run cut short leaves the ticket off the frontier. The
 * loop never applies ready-for-agent.
 */
const escalate = async (
  tracker: Tracker,
  ticket: number,
  comment: Parameters<typeof escalationComment>[0]
) => {
  await tracker.addLabel(ticket, READY_FOR_HUMAN);
  await tracker.removeLabel(ticket, READY_FOR_AGENT);
  await tracker.comment(ticket, escalationComment(comment));
};

/**
 * Takes one ticket through implement, review and gate, sending failures back
 * to the implementer while budget lasts. Merges only when the merge condition
 * holds; escalates otherwise.
 */
const workTicket = async (
  { tracker, executor, gate }: LoopPorts,
  standards: StandardsDoc[],
  { number, title, body }: Ticket
): Promise<Outcome> => {
  const ticket: TicketSpec = { number, title, body };
  const branch = branchFor(number);
  const trail: Step[] = [];
  const reviewed: string[] = [];
  /** Red gate summaries that turned green on a rerun with no code change: the gate's fault, not the agent's. */
  const flaky: string[] = [];
  /** Every review's non-blocking findings: posted and logged, never blocking. */
  const nonBlocking: string[] = [];
  /** The latest evidence file there was, for the trail even if a retry dropped it. */
  let lastEvidence: string | null = null;
  const stop = async (reasons: string[]): Promise<Outcome> => {
    await escalate(tracker, number, {
      branch,
      reasons,
      trail,
      evidence: lastEvidence,
    });
    return {
      number,
      title,
      merged: false,
      escalated: reasons,
      nonBlocking,
      flaky,
    };
  };
  let feedback: Feedback | undefined;
  let addressing: Finding[] = [];
  let reviewRetries = 0;
  let ciRetries = 0;
  for (;;) {
    const implementation = await executor.implement({
      ticket,
      branch,
      ...(feedback && { feedback }),
    });
    const { commits, diff, evidence } = implementation;
    if (hasEvidence(evidence)) lastEvidence = evidence;
    const committed = commits.filter((commit) => !reviewed.includes(commit));
    trail.push({
      step: 'implement',
      ...(feedback && { feedback: 'review' in feedback ? 'review' : 'gate' }),
      committed,
    });
    if (committed.length === 0) {
      return stop([feedback ? 'no new commits' : 'no commits']);
    }
    if (!hasEvidence(evidence)) return stop(['no evidence file']);
    const { findings } = await executor.review({
      ticket,
      diff,
      evidence,
      standards,
      addressing,
    });
    reviewed.push(...committed);
    trail.push({ step: 'review', of: committed, findings });
    const blocking = findings.filter((finding) => finding.blocking);
    nonBlocking.push(
      ...findings
        .filter((finding) => !finding.blocking)
        .map((finding) => finding.summary)
    );
    if (blocking.length > 0) {
      if (reviewRetries === REVIEW_RETRIES) {
        return stop([
          `review retries used up (${reviewRetries} of ${REVIEW_RETRIES})`,
          ...blockingFindings(findings),
        ]);
      }
      reviewRetries++;
      feedback = { review: blocking };
      addressing = blocking;
      continue;
    }
    let checked = await gate.check({
      ticket: { number, title },
      branch,
      prBody: prBody({ ticket: number, evidence, nonBlocking }),
    });
    trail.push({ step: 'gate', result: checked });
    if (!checked.green) {
      // A free rerun first: a flaky gate shouldn't cost tokens or a CI retry.
      const rerun = await gate.rerun({ ticket: number, branch });
      trail.push({ step: 'rerun', result: rerun });
      if (!sameCommits(rerun.commits, checked.commits)) {
        return stop([
          `gate rerun ran on ${rerun.commits.join(', ') || 'no commits'}, not ${checked.commits.join(', ')}`,
        ]);
      }
      if (rerun.green) flaky.push(checked.summary);
      checked = rerun;
      if (!checked.green) {
        if (ciRetries === CI_RETRIES) {
          return stop([
            `CI retries used up (${ciRetries} of ${CI_RETRIES})`,
            `gate red: ${checked.summary}`,
          ]);
        }
        ciRetries++;
        feedback = { gate: checked.summary };
        addressing = [];
        continue;
      }
    }
    // The whole condition again, on what the gate ran: merging is one checked condition, whatever led here.
    const blockers = mergeBlockers({
      gate: checked,
      findings,
      reviewed,
      evidence,
    });
    if (blockers.length > 0) return stop(blockers);
    await gate.merge({ ticket: number, branch });
    await tracker.comment(
      number,
      evidenceComment({
        branch,
        evidence,
        gateSummary: checked.summary,
        reviewed,
        nonBlocking,
        flaky,
      })
    );
    await tracker.close(number);
    return { number, title, merged: true, escalated: [], nonBlocking, flaky };
  }
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
    const outcome = await workTicket(ports, standards, ticket);
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
