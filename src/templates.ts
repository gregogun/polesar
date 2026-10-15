/**
 * Everything polesar writes to the tracker, the PR or the terminal about a
 * run, rendered from these templates rather than by a model, so it costs no
 * tokens and stays short and consistent.
 */
import {
  describeHumanBlockers,
  plural,
  type HumanBlocker,
} from './frontier.ts';
import type { Finding } from './executor.ts';
import type { GateResult } from './gate.ts';
import type { LoopResult, Stopped } from './loop.ts';
import type { ProtectedChange } from './protected-paths.ts';
import type { EscalationVerdict, VerdictResult } from './verdict.ts';

type Merged = {
  branch: string;
  evidence: string;
  gateSummary: string;
  reviewed: string[];
  nonBlocking: string[];
  /** Red gate summaries that turned green on a rerun with no code change. */
  flaky: string[];
};

export const prBody = ({
  ticket,
  evidence,
  nonBlocking,
}: {
  ticket: number;
  evidence: string;
  nonBlocking: string[];
}) =>
  [
    `Closes #${ticket}`,
    '',
    '## Evidence',
    '',
    evidence,
    '',
    ...(nonBlocking.length > 0
      ? [
          '## Non-blocking review findings',
          '',
          ...nonBlocking.map((finding) => `- ${finding}`),
          '',
        ]
      : []),
  ].join('\n');

export const evidenceComment = ({
  branch,
  evidence,
  gateSummary,
  reviewed,
  nonBlocking,
  flaky,
}: Merged) =>
  [
    `Merged by polesar from \`${branch}\`.`,
    '',
    '- Review: no blocking findings',
    ...(nonBlocking.length > 0
      ? [`- Non-blocking findings: ${nonBlocking.join('; ')}`]
      : []),
    `- Gate: ${gateSummary}`,
    ...flaky.map(
      (summary) =>
        `- Flaky gate: ${summary} (green on rerun with no code change)`
    ),
    `- Reviewed commits: ${reviewed.join(', ')}`,
    '',
    '## Evidence',
    '',
    evidence,
    '',
  ].join('\n');

/** One step the loop took on a ticket, as the escalation trail shows it. */
export type Step =
  | {
      step: 'implement';
      feedback?: 'review' | 'gate';
      /** The commits this run added. */
      committed: string[];
    }
  | { step: 'review'; of: string[]; findings: Finding[] }
  | { step: 'gate' | 'rerun'; result: GateResult }
  /** A rate limit cut the agent run before `before` short; it was redone after `until`. */
  | { step: 'paused'; until: string; before: 'implement' | 'review' }
  /** An agent run failed in a way polesar couldn't explain, and the run stopped. */
  | { step: 'failed'; detail: string; before: 'implement' | 'review' };

const IMPLEMENT_WITH = { review: 'review findings', gate: 'gate failure' };

const describeFindings = (findings: Finding[]) => {
  const of = (blocking: boolean) =>
    findings
      .filter((finding) => finding.blocking === blocking)
      .map((finding) => finding.summary)
      .join('; ');
  const parts = [
    ...(of(true) ? [`blocking: ${of(true)}`] : []),
    ...(of(false) ? [`non-blocking: ${of(false)}`] : []),
  ];
  return parts.length > 0 ? parts.join('; ') : 'no findings';
};

const describeStep = (step: Step) => {
  if (step.step === 'implement') {
    const label = step.feedback
      ? `Implement with ${IMPLEMENT_WITH[step.feedback]}`
      : 'Implement';
    const committed =
      step.committed.length > 0
        ? `committed ${step.committed.join(', ')}`
        : 'no commits';
    return `${label}: ${committed}`;
  }
  if (step.step === 'paused') {
    return `Paused for a rate limit until ${step.until} before ${step.before === 'implement' ? 'implementing' : 'reviewing'}`;
  }
  if (step.step === 'failed') {
    return `Stopped: the ${step.before === 'implement' ? 'implementer' : 'reviewer'} run failed: ${step.detail}`;
  }
  if (step.step === 'review') {
    return `Review of ${step.of.join(', ')}: ${describeFindings(step.findings)}`;
  }
  const { green, summary, commits } = step.result;
  const label = step.step === 'gate' ? 'Gate' : 'Gate rerun';
  return `${label} on ${commits.join(', ') || 'no commits'}: ${green ? 'green' : 'red'}: ${summary}`;
};

/** The protected files an escalation names, and how to record a verdict on it for telemetry. */
const describeTouched = (ticket: number, touched: ProtectedChange[]) =>
  touched.length === 0
    ? []
    : [
        '## Protected paths changed',
        '',
        ...touched.map(
          ({ path, change, pattern }) =>
            `- \`${path}\` (${change}; matches \`${pattern}\`)`
        ),
        '',
        `Record your verdict on this escalation with \`polesar verdict ${ticket} approved\` or \`polesar verdict ${ticket} rejected\`.`,
        '',
      ];

export const escalationComment = ({
  ticket,
  branch,
  reasons,
  touched,
  trail,
  evidence,
}: {
  ticket: number;
  branch: string;
  reasons: string[];
  /** Protected files the branch modified or deleted; empty unless that's why it escalated. */
  touched: ProtectedChange[];
  trail: Step[];
  evidence: string | null;
}) =>
  [
    'Escalated to ready-for-human by polesar.',
    '',
    ...reasons.map((reason) => `- ${reason}`),
    '',
    `Branch: \`${branch}\``,
    '',
    ...describeTouched(ticket, touched),
    '## Trail',
    '',
    ...trail.map((step, index) => `${index + 1}. ${describeStep(step)}`),
    '',
    '## Evidence',
    '',
    evidence ?? '_No evidence file._',
    '',
  ].join('\n');

/** Your verdict on an escalation; the first line is what telemetry reads. */
export const verdictComment = (verdict: EscalationVerdict) =>
  `polesar verdict: ${verdict}\n\nRecorded against polesar's latest escalation of this ticket, for telemetry.\n`;

export const describeVerdict = ({
  ticket,
  verdict,
  recorded,
}: VerdictResult) =>
  recorded
    ? `#${ticket}: recorded verdict ${verdict}\n`
    : `#${ticket}: would record verdict ${verdict}. Nothing was changed.\n`;

/** What happened to one ticket in a run. */
export type Outcome = {
  number: number;
  title: string;
  merged: boolean;
  /** Why it was escalated to ready-for-human instead; empty when it merged. */
  escalated: string[];
  /** Non-blocking review findings, posted on the PR without blocking the merge. */
  nonBlocking: string[];
  /** Flaky-gate events: red gate summaries that turned green on a rerun with no code change. */
  flaky: string[];
};

export const describeOutcome = ({
  number,
  title,
  merged,
  escalated,
  nonBlocking,
  flaky,
}: Outcome) =>
  `${[
    `#${number} ${title}: ${merged ? 'merged' : `escalated to ready-for-human: ${escalated.join('; ')}`}`,
    ...nonBlocking.map((finding) => `  non-blocking finding: ${finding}`),
    ...flaky.map(
      (summary) =>
        `  flaky gate: ${summary} (green on rerun with no code change)`
    ),
  ].join('\n')}\n`;

const describeStopped = (stopped: Stopped) =>
  stopped.reason === 'done'
    ? 'loop stopped: nothing left on the frontier'
    : stopped.reason === 'paused'
      ? `loop paused: rate limited until ${stopped.until}. #${stopped.ticket} keeps its place, with no retry used and its labels unchanged: run polesar loop again after then to resume it`
      : stopped.reason === 'failed'
        ? `loop stopped: an agent run failed on #${stopped.ticket}: ${stopped.detail}. #${stopped.ticket} keeps its place, with no retry used and its labels unchanged: run polesar loop again to resume it`
        : `loop stopped before the next ticket: ${stopped.detail}`;

export const runSummary = ({
  outcomes,
  humanBlockers,
  stopped,
}: LoopResult) => {
  const merged = outcomes.filter((outcome) => outcome.merged).length;
  const escalated = outcomes.length - merged;
  const counts = [
    `${merged} merged`,
    ...(escalated > 0 ? [`${escalated} escalated`] : []),
  ];
  return `${[
    `${describeStopped(stopped)} (${counts.join(', ')})`,
    ...describeHumanBlockers(humanBlockers),
  ].join('\n')}\n`;
};

/** A dry run: the transitions each frontier ticket would go through. */
export type Plan = {
  planned: { number: number; title: string; branch: string; steps: string[] }[];
  humanBlockers: HumanBlocker[];
};

export const describePlan = ({ planned, humanBlockers }: Plan) =>
  `${[
    `dry run: ${plural(planned.length, 'ticket')} on the frontier, worked one at a time:`,
    ...planned.map(
      ({ number, title, branch, steps }) =>
        `  #${number} ${title}: ${steps[0]} on ${branch} → ${steps.slice(1).join(' → ')}`
    ),
    'Tickets they unblock are worked as they merge. Nothing was changed.',
    ...describeHumanBlockers(humanBlockers),
  ].join('\n')}\n`;
