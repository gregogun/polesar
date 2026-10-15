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

type Merged = {
  ticket: number;
  branch: string;
  evidence: string;
  gateSummary: string;
  reviewed: string[];
};

export const prBody = ({
  ticket,
  evidence,
}: {
  ticket: number;
  evidence: string;
}) => `Closes #${ticket}\n\n## Evidence\n\n${evidence}\n`;

export const evidenceComment = ({
  branch,
  evidence,
  gateSummary,
  reviewed,
}: Merged) =>
  [
    `Merged by polesar from \`${branch}\`.`,
    '',
    '- Review: no blocking findings',
    `- Gate: ${gateSummary}`,
    `- Reviewed commits: ${reviewed.join(', ')}`,
    '',
    '## Evidence',
    '',
    evidence,
    '',
  ].join('\n');

/** What happened to one ticket in a run. */
export type Outcome = {
  number: number;
  title: string;
  merged: boolean;
  /** Why it wasn't merged; empty when it was. */
  held: string[];
};

export const describeOutcome = ({ number, title, merged, held }: Outcome) =>
  `#${number} ${title}: ${merged ? 'merged' : `held, not merged: ${held.join('; ')}`}\n`;

export const runSummary = ({
  outcomes,
  humanBlockers,
}: {
  outcomes: Outcome[];
  humanBlockers: HumanBlocker[];
}) => {
  const merged = outcomes.filter((outcome) => outcome.merged).length;
  const held = outcomes.length - merged;
  const counts = [`${merged} merged`, ...(held > 0 ? [`${held} held`] : [])];
  return `${[
    `loop stopped: nothing left on the frontier (${counts.join(', ')})`,
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
