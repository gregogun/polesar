import { verdictComment } from './templates.ts';
import type { Tracker } from './tracker.ts';

const VERDICTS = ['approved', 'rejected'] as const;

/** Your call on an escalation: was the change it held back fine to merge? */
export type EscalationVerdict = (typeof VERDICTS)[number];

export const isVerdict = (value: string): value is EscalationVerdict =>
  (VERDICTS as readonly string[]).includes(value);

export type VerdictResult = {
  ticket: number;
  verdict: EscalationVerdict;
  /** False on a dry run. */
  recorded: boolean;
};

/**
 * Records your verdict on a ticket's latest escalation as a templated comment
 * on the ticket, where telemetry can read it back, so protected-path rules can
 * be relaxed on evidence (ADR 0005).
 */
export const recordVerdict = async (
  tracker: Tracker,
  ticket: number,
  verdict: EscalationVerdict,
  { dryRun = false } = {}
): Promise<VerdictResult> => {
  if (!dryRun) await tracker.comment(ticket, verdictComment(verdict));
  return { ticket, verdict, recorded: !dryRun };
};
