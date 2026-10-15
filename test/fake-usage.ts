import { readFile } from 'node:fs/promises';
import type { Usage, UsageReading, UsageWindow } from '../src/usage.ts';

/**
 * A scripted usage reading: null for none, or a reading whose unscripted
 * parts are fresh and low (recorded now, 0% used, resetting later). A null
 * window leaves that window out.
 */
export type ScriptedReading = {
  recordedAt?: string;
  fiveHour?: Partial<UsageWindow> | null;
  sevenDay?: Partial<UsageWindow> | null;
} | null;

const HOUR = 60 * 60 * 1000;

const window = (
  scripted: Partial<UsageWindow> | null | undefined,
  resetsAt: number
): UsageWindow | undefined =>
  scripted === null
    ? undefined
    : {
        usedPercentage: 0,
        resetsAt: new Date(resetsAt).toISOString(),
        ...scripted,
      };

/** Readings in order, one per call, the last repeating; a single reading for every call. */
class FakeUsage implements Usage {
  readonly #script: ScriptedReading | ScriptedReading[] | undefined;
  readonly #now: number;
  #calls = 0;

  constructor(
    script: ScriptedReading | ScriptedReading[] | undefined,
    now: number
  ) {
    this.#script = script;
    this.#now = now;
  }

  latest(): Promise<UsageReading | null> {
    this.#calls++;
    const scripted = Array.isArray(this.#script)
      ? this.#script[Math.min(this.#calls, this.#script.length) - 1]
      : this.#script;
    if (scripted === null) return Promise.resolve(null);
    const fiveHour = window(scripted?.fiveHour, this.#now + 2 * HOUR);
    const sevenDay = window(scripted?.sevenDay, this.#now + 72 * HOUR);
    return Promise.resolve({
      recordedAt: scripted?.recordedAt ?? new Date(this.#now).toISOString(),
      ...(fiveHour && { fiveHour }),
      ...(sevenDay && { sevenDay }),
    });
  }
}

/** A fake usage source scripted by the `usage` key of a JSON loop script. */
export const loadFakeUsage = async (file: string, now: number) => {
  const { usage } = JSON.parse(await readFile(file, 'utf8')) as {
    usage?: ScriptedReading | ScriptedReading[];
  };
  return new FakeUsage(usage, now);
};
