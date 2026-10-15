/**
 * Evidence files as polesar posts them. GitHub rejects bodies over 65,536
 * characters, so a longer file is cut short in the PR body and comments, and
 * kept whole in polesar's home for a human to read.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { repoKey } from './paused-run.ts';

/** Leaves room under GitHub's limit for the rest of the body around the evidence. */
export const EVIDENCE_CAP = 60_000;

export class EvidenceFiles {
  readonly #dir: string;

  constructor(home: string, cwd: string) {
    this.#dir = path.join(home, 'evidence', repoKey(cwd));
  }

  /** `evidence` as it can be posted for `ticket`: whole, or cut at the cap with a note naming where the full file was saved. */
  async postable(ticket: number, evidence: string): Promise<string> {
    if (evidence.length <= EVIDENCE_CAP) return evidence;
    const file = path.join(this.#dir, `${ticket}.md`);
    await mkdir(this.#dir, { recursive: true });
    await writeFile(file, evidence);
    return [
      evidence.slice(0, EVIDENCE_CAP),
      '',
      `_Evidence truncated: ${EVIDENCE_CAP.toLocaleString('en')} of ${evidence.length.toLocaleString('en')} characters shown. The full file is at \`${file}\` on the machine polesar ran on._`,
    ].join('\n');
  }
}
