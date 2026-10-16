/**
 * What polesar tells its agents. The implementer's prompt stays thin: the
 * ticket, where to commit and the evidence contract. The reviewer's is
 * polesar's own two-axis review (standards and spec), answered as JSON so the
 * loop can act on it without a model reading it.
 */
import type {
  Finding,
  ImplementInput,
  ReviewInput,
  TicketSpec,
} from './executor.ts';

/** Where the implementer writes its evidence, relative to the worktree. Git ignores it: it is never committed. */
export const EVIDENCE_PATH = '.polesar/evidence.md';

/** The tag the reviewer wraps its JSON verdict in. */
export const REVIEW_TAG = 'review';

const describeTicket = ({ number, title, body }: TicketSpec) => [
  `# Ticket #${number}: ${title}`,
  '',
  body.trim() || '_No description._',
];

const describeFindings = (findings: Finding[]) =>
  findings.map((finding) => `- ${finding.summary}`);

export const implementerPrompt = ({
  ticket,
  branch,
  feedback,
}: ImplementInput) =>
  [
    ...describeTicket(ticket),
    '',
    ...(feedback === undefined
      ? []
      : 'review' in feedback
        ? [
            '## Sent back by review',
            '',
            'You already worked on this ticket. The reviewer found these blocking problems; fix them:',
            '',
            ...describeFindings(feedback.review),
            '',
          ]
        : [
            '## Sent back by CI',
            '',
            'You already worked on this ticket. CI is still red after a rerun; fix it:',
            '',
            feedback.gate,
            '',
          ]),
    '## Rules',
    '',
    `- Commit your work on \`${branch}\`, the branch checked out here, and nowhere else: don't switch, create or delete branches, merge, rebase onto other work, or push.`,
    '- Leave the work committed when you finish: uncommitted changes are lost.',
    `- Write your evidence to \`${EVIDENCE_PATH}\` and never commit it (git ignores it). Say what you ran and what you observed, covering the branch as it stands when you finish. Label every claim **measured** (you ran it and saw the result), **inferred** (follows from what you measured) or **guess** (not checked). With no evidence file, nothing you did can merge.`,
  ].join('\n');

/** The reviewer's verdict as it is asked to give it. */
export type ReviewVerdict = { findings: Finding[] };

export const reviewerPrompt = ({
  ticket,
  branch,
  diff,
  evidence,
  standards,
  addressing,
}: ReviewInput) =>
  [
    `You are reviewing \`${branch}\`, checked out here, for polesar. You are read-only: don't edit, create or delete files, commit, or change branches. Reading files and running read-only commands (tests, type checks, git log/show/diff) is fine. Anything you change is discarded and voids your review.`,
    '',
    'Review the diff below along two axes, separately:',
    '',
    '- **Spec**: does it do what the ticket asks? Requirements missing or partial, behaviour nobody asked for, and requirements that look implemented but wrong. Quote the ticket line each finding rests on.',
    '- **Standards**: does it follow the standards docs below? Cite the doc and rule each finding rests on. Skip what tooling already enforces.',
    '',
    'The evidence is what the implementer claims to have run and observed, labelled measured, inferred or guess. Check measured claims you can check cheaply; treat the rest as unproven.',
    '',
    '**Blocking** findings are spec mismatches and correctness bugs only. Style, smells and suggestions are non-blocking.',
    '',
    ...(addressing.length > 0
      ? [
          'This diff was meant to fix these blocking findings from the last review. Raise each again, as blocking, if it is not fixed:',
          '',
          ...describeFindings(addressing),
          '',
        ]
      : []),
    ...describeTicket(ticket),
    '',
    '# Diff',
    '',
    '```diff',
    diff,
    '```',
    '',
    '# Evidence',
    '',
    evidence,
    '',
    '# Standards docs',
    '',
    ...(standards.length === 0
      ? ['_None._', '']
      : standards.flatMap((doc) => [`## ${doc.path}`, '', doc.content, ''])),
    '# Your answer',
    '',
    `End with your findings as JSON inside <${REVIEW_TAG}></${REVIEW_TAG}> tags, and nothing after them:`,
    '',
    `<${REVIEW_TAG}>{"findings": [{"blocking": true, "summary": "Spec: ..."}]}</${REVIEW_TAG}>`,
    '',
    'Give an empty findings list if you found nothing. Start each summary with its axis, "Spec:" or "Standards:".',
  ].join('\n');

/** The reviewer's last <review> verdict in `output`, or why there isn't a usable one. */
export const parseVerdict = (
  output: string
): ReviewVerdict | { error: string } => {
  const open = `<${REVIEW_TAG}>`;
  const start = output.lastIndexOf(open);
  const end = output.indexOf(`</${REVIEW_TAG}>`, start);
  if (start === -1 || end === -1) {
    return { error: `no <${REVIEW_TAG}> verdict found` };
  }
  const raw = output
    .slice(start + open.length, end)
    .trim()
    .replace(/^```(?:json)?\s*/, '')
    .replace(/\s*```$/, '');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { error: `the <${REVIEW_TAG}> verdict isn't valid JSON` };
  }
  const findings = (parsed as { findings?: unknown } | null)?.findings;
  if (
    !Array.isArray(findings) ||
    !findings.every(
      (finding: unknown) =>
        typeof (finding as Finding | null)?.blocking === 'boolean' &&
        typeof (finding as Finding).summary === 'string'
    )
  ) {
    return {
      error: `the <${REVIEW_TAG}> verdict needs {"findings": [{"blocking": boolean, "summary": string}]}`,
    };
  }
  return {
    findings: (findings as Finding[]).map(({ blocking, summary }) => ({
      blocking,
      summary,
    })),
  };
};
