import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  Executor,
  Finding,
  RateLimited,
  StandardsDoc,
  TicketSpec,
} from './executor.ts';
import {
  frontierOf,
  READY_FOR_AGENT,
  READY_FOR_HUMAN,
  type HumanBlocker,
} from './frontier.ts';
import { Books, loadBudget, type Budget, type BudgetStop } from './budget.ts';
import type { Gate, GateResult } from './gate.ts';
import { PausedRuns, type PausedRun, type TicketState } from './paused-run.ts';
import {
  loadProtectedPaths,
  protectedChanges,
  type ProtectedChange,
} from './protected-paths.ts';
import {
  escalationComment,
  evidenceComment,
  prBody,
  type Outcome,
  type Plan,
} from './templates.ts';
import type { Ticket, Tracker } from './tracker.ts';
import type { Usage } from './usage.ts';

type LoopPorts = {
  tracker: Tracker;
  executor: Executor;
  gate: Gate;
  usage: Usage;
};

/** Why a run stopped. */
export type Stopped =
  /** Nothing left on the frontier. */
  | { reason: 'done' }
  /** A budget rule, or usage readings it can't trust, kept the next ticket from starting. */
  | ({ reason: 'budget' } & BudgetStop)
  /** A rate limit cut an agent run short; the ticket picks up from there in a run after `until`. */
  | { reason: 'paused'; until: string; ticket: number };

export type LoopResult = {
  outcomes: Outcome[];
  /** ready-for-human tickets still holding up AFK work when the run stopped. */
  humanBlockers: HumanBlocker[];
  stopped: Stopped;
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
 * The merge condition (must-pass #1 and #2): why the branch can't merge, or
 * nothing when the gate is green, nothing blocks, every commit on it was
 * reviewed, the evidence file exists and no protected file was modified or
 * deleted.
 */
const mergeBlockers = ({
  gate,
  findings,
  reviewed,
  evidence,
  touched,
}: {
  gate: GateResult;
  findings: Finding[];
  reviewed: string[];
  evidence: string | null;
  touched: ProtectedChange[];
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
    ...(touched.length > 0
      ? [
          `protected paths changed: ${touched.map((change) => change.path).join(', ')}`,
        ]
      : []),
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

/** What the loop holds every ticket to, read once per run from the main checkout. */
type Policy = {
  standards: StandardsDoc[];
  protectedPaths: string[];
  budget: Budget;
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

/** A ticket's work, cut short by a rate limit, and where it stood. */
type Paused = { until: string; state: TicketState };

const freshState = (): TicketState => ({
  trail: [],
  reviewed: [],
  flaky: [],
  nonBlocking: [],
  lastEvidence: null,
  touched: [],
  addressing: [],
  reviewRetries: 0,
  ciRetries: 0,
  turns: 0,
  next: { step: 'implement' },
});

/**
 * Takes one ticket through implement, review and gate, sending failures back
 * to the implementer while budget lasts. Merges only when the merge condition
 * holds; escalates otherwise. A rate limit pauses it instead, with where it
 * stood, to carry on from `state` once the limit resets.
 */
const workTicket = async (
  { tracker, executor, gate }: LoopPorts,
  { standards, protectedPaths, budget }: Policy,
  { number, title, body }: Ticket,
  state: TicketState = freshState()
): Promise<Outcome | Paused> => {
  const ticket: TicketSpec = { number, title, body };
  const branch = branchFor(number);
  const stop = async (reasons: string[]): Promise<Outcome> => {
    await escalate(tracker, number, {
      ticket: number,
      branch,
      reasons,
      touched: state.touched,
      trail: state.trail,
      evidence: state.lastEvidence,
    });
    return {
      number,
      title,
      merged: false,
      escalated: reasons,
      nonBlocking: state.nonBlocking,
      flaky: state.flaky,
    };
  };
  // No retry, label or turn is spent: the run is redone from the same step after the reset.
  const pause = ({ rateLimited }: RateLimited): Paused => {
    state.trail.push({
      step: 'paused',
      until: rateLimited.resetsAt,
      before: state.next.step,
    });
    return { until: rateLimited.resetsAt, state };
  };
  const capHit = () =>
    `per-ticket cap hit: ${state.turns} of ${budget.ticketTurns} turns used`;
  for (;;) {
    if (state.next.step === 'implement') {
      const { feedback } = state;
      if (state.turns >= budget.ticketTurns) {
        // Out of turns before going back to the implementer: escalate with what it was going back for.
        return stop([
          capHit(),
          ...(feedback && 'review' in feedback
            ? blockingFindings(feedback.review)
            : []),
          ...(feedback && 'gate' in feedback
            ? [`gate red: ${feedback.gate}`]
            : []),
        ]);
      }
      const implementation = await executor.implement({
        ticket,
        branch,
        ...(feedback && { feedback }),
        maxTurns: budget.ticketTurns - state.turns,
      });
      if ('rateLimited' in implementation) return pause(implementation);
      state.turns += implementation.turns;
      const { commits, diff, changes, evidence } = implementation;
      if (hasEvidence(evidence)) state.lastEvidence = evidence;
      state.touched = protectedChanges(changes, protectedPaths);
      const committed = commits.filter(
        (commit) => !state.reviewed.includes(commit)
      );
      state.trail.push({
        step: 'implement',
        ...(feedback && {
          feedback: 'review' in feedback ? 'review' : 'gate',
        }),
        committed,
      });
      if (implementation.capHit) return stop([capHit()]);
      if (committed.length === 0) {
        return stop([feedback ? 'no new commits' : 'no commits']);
      }
      if (!hasEvidence(evidence)) return stop(['no evidence file']);
      if (state.turns >= budget.ticketTurns) return stop([capHit()]);
      state.next = { step: 'review', committed, diff, evidence };
    }
    const { committed, diff, evidence } = state.next;
    const review = await executor.review({
      ticket,
      diff,
      evidence,
      standards,
      addressing: state.addressing,
      maxTurns: budget.ticketTurns - state.turns,
    });
    if ('rateLimited' in review) return pause(review);
    state.turns += review.turns;
    const { findings } = review;
    // A review cut short may have missed what blocks: its findings can't clear the branch.
    if (review.capHit) return stop([capHit()]);
    state.reviewed.push(...committed);
    state.trail.push({ step: 'review', of: committed, findings });
    const blocking = findings.filter((finding) => finding.blocking);
    state.nonBlocking.push(
      ...findings
        .filter((finding) => !finding.blocking)
        .map((finding) => finding.summary)
    );
    state.next = { step: 'implement' };
    if (blocking.length > 0) {
      if (state.reviewRetries === REVIEW_RETRIES) {
        return stop([
          `review retries used up (${state.reviewRetries} of ${REVIEW_RETRIES})`,
          ...blockingFindings(findings),
        ]);
      }
      state.reviewRetries++;
      state.feedback = { review: blocking };
      state.addressing = blocking;
      continue;
    }
    let checked = await gate.check({
      ticket: { number, title },
      branch,
      prBody: prBody({
        ticket: number,
        evidence,
        nonBlocking: state.nonBlocking,
      }),
    });
    state.trail.push({ step: 'gate', result: checked });
    if (!checked.green) {
      // A free rerun first: a flaky gate shouldn't cost tokens or a CI retry.
      const rerun = await gate.rerun({ ticket: number, branch });
      state.trail.push({ step: 'rerun', result: rerun });
      if (!sameCommits(rerun.commits, checked.commits)) {
        return stop([
          `gate rerun ran on ${rerun.commits.join(', ') || 'no commits'}, not ${checked.commits.join(', ')}`,
        ]);
      }
      if (rerun.green) state.flaky.push(checked.summary);
      checked = rerun;
      if (!checked.green) {
        if (state.ciRetries === CI_RETRIES) {
          return stop([
            `CI retries used up (${state.ciRetries} of ${CI_RETRIES})`,
            `gate red: ${checked.summary}`,
          ]);
        }
        state.ciRetries++;
        state.feedback = { gate: checked.summary };
        state.addressing = [];
        continue;
      }
    }
    // The whole condition again, on what the gate ran: merging is one checked condition, whatever led here.
    const blockers = mergeBlockers({
      gate: checked,
      findings,
      reviewed: state.reviewed,
      evidence,
      touched: state.touched,
    });
    if (blockers.length > 0) return stop(blockers);
    await gate.merge({ ticket: number, branch });
    await tracker.comment(
      number,
      evidenceComment({
        branch,
        evidence,
        gateSummary: checked.summary,
        reviewed: state.reviewed,
        nonBlocking: state.nonBlocking,
        flaky: state.flaky,
      })
    );
    await tracker.close(number);
    return {
      number,
      title,
      merged: true,
      escalated: [],
      nonBlocking: state.nonBlocking,
      flaky: state.flaky,
    };
  }
};

/**
 * Works the frontier one ticket at a time until nothing is left on it, taking
 * each ticket at most once per run, or until the budget stops it before a
 * ticket, or a rate limit pauses it. A paused run is resumed by the first run
 * after the limit resets, if its ticket is still on the frontier. Standards
 * docs, protected paths and the budget are read from `cwd`; the loop's weekly
 * usage and paused runs are kept in `home`. `onOutcome` hears about each
 * ticket as it finishes.
 */
export const runLoop = async (
  ports: LoopPorts,
  {
    cwd,
    home,
    now,
    onOutcome,
  }: {
    cwd: string;
    home: string;
    now: () => number;
    onOutcome: (outcome: Outcome) => void;
  }
): Promise<LoopResult> => {
  const policy: Policy = {
    standards: await readStandards(cwd),
    protectedPaths: await loadProtectedPaths(cwd),
    budget: await loadBudget(cwd),
  };
  const pausedRuns = new PausedRuns(home, cwd);
  const paused = await pausedRuns.load();
  const books = new Books(home, policy.budget, paused?.spend);
  const outcomes: Outcome[] = [];
  const tried = new Set<number>();
  /** The ticket a later run carries on with, if this one stops with it paused. */
  let toResume: Omit<PausedRun, 'spend'> | undefined;
  const end = async (
    humanBlockers: HumanBlocker[],
    stopped: Stopped
  ): Promise<LoopResult> => {
    await books.close(await ports.usage.latest(), now());
    // Saved after the books close, so resuming books only what's spent from here.
    if (toResume !== undefined) {
      await pausedRuns.save({ ...toResume, spend: books.spend });
    }
    return { outcomes, humanBlockers, stopped };
  };
  /** Works `ticket` from `state`; says how the run stopped if a rate limit paused it. */
  const work = async (
    ticket: Ticket,
    state?: TicketState
  ): Promise<Stopped | undefined> => {
    tried.add(ticket.number);
    const result = await workTicket(ports, policy, ticket, state);
    if ('until' in result) {
      toResume = { ticket: ticket.number, ...result };
      return { reason: 'paused', until: result.until, ticket: ticket.number };
    }
    if (state !== undefined) await pausedRuns.clear();
    outcomes.push(result);
    onOutcome(result);
    return undefined;
  };
  /** The paused ticket to carry on with first, while it's still on the frontier. */
  let resume = paused;
  for (;;) {
    const open = await ports.tracker.openTickets();
    const { tickets, humanBlockers } = frontierOf(open);
    if (resume !== undefined) {
      const { until, ticket } = resume;
      if (now() < Date.parse(until)) {
        // Nothing ran, so nothing is booked: the paused run's spend stays as it was saved.
        return {
          outcomes,
          humanBlockers,
          stopped: { reason: 'paused', until, ticket },
        };
      }
      // Off the frontier now (a human took it, or it closed): what it was doing is theirs to judge.
      if (!tickets.some(({ number }) => number === ticket)) {
        await pausedRuns.clear();
        resume = undefined;
      }
    }
    const next =
      resume?.ticket ??
      tickets.find(({ number }) => !tried.has(number))?.number;
    const ticket = open.find(({ number }) => number === next);
    if (ticket === undefined) return end(humanBlockers, { reason: 'done' });
    const overBudget = await books.check(await ports.usage.latest(), now());
    if (overBudget !== undefined) {
      toResume = resume;
      return end(humanBlockers, { reason: 'budget', ...overBudget });
    }
    const stopped = await work(ticket, resume?.state);
    resume = undefined;
    if (stopped !== undefined) return end(humanBlockers, stopped);
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
