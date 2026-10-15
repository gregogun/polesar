/**
 * How much of the plan's rate limits is used, as Claude Code's status line last
 * saw it. Headless runs report no percentage, so `polesar statusline` saves
 * each reading the status line receives, and the loop reads the latest.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isRecord } from './config.ts';

/** One rate-limit window: how much of it is used and when it resets. */
export type UsageWindow = {
  /** 0 to 100. */
  usedPercentage: number;
  /** ISO time. */
  resetsAt: string;
};

export type UsageReading = {
  /** ISO time the status line saw it. */
  recordedAt: string;
  /** Absent when the status line didn't report the window. */
  fiveHour?: UsageWindow;
  sevenDay?: UsageWindow;
};

/** Where usage readings come from. polesar's core reads usage only through this port. */
export type Usage = {
  /** The latest reading, or null when there is none. */
  latest(): Promise<UsageReading | null>;
};

const READING_FILE = 'usage.json';

const isWindow = (value: unknown): value is UsageWindow =>
  isRecord(value) &&
  typeof value.usedPercentage === 'number' &&
  typeof value.resetsAt === 'string';

const isReading = (value: unknown): value is UsageReading =>
  isRecord(value) &&
  typeof value.recordedAt === 'string' &&
  (value.fiveHour === undefined || isWindow(value.fiveHour)) &&
  (value.sevenDay === undefined || isWindow(value.sevenDay));

/** Writes `value` as JSON so a reader never sees half a file. */
export const writeJsonAtomically = async (file: string, value: unknown) => {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporary, file);
};

/** Reads `file` as JSON; undefined when it doesn't exist. */
export const readJsonIfPresent = async (file: string): Promise<unknown> => {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

/** The readings `polesar statusline` saves in polesar's home directory. */
export class FileUsage implements Usage {
  readonly #file: string;

  constructor(home: string) {
    this.#file = path.join(home, READING_FILE);
  }

  /** A reading that can't be read counts as none: the loop then stops rather than guess. */
  async latest(): Promise<UsageReading | null> {
    const reading = await readJsonIfPresent(this.#file).catch(() => null);
    return isReading(reading) ? reading : null;
  }
}

const windowOf = (value: unknown): UsageWindow | undefined => {
  if (
    !isRecord(value) ||
    typeof value.used_percentage !== 'number' ||
    typeof value.resets_at !== 'number'
  ) {
    return undefined;
  }
  return {
    usedPercentage: value.used_percentage,
    resetsAt: new Date(value.resets_at * 1000).toISOString(),
  };
};

/**
 * Saves the rate limits in a Claude Code status line payload as the latest
 * reading. A payload without rate limits (before a session's first response,
 * or on a plan without them) leaves the last reading alone, to age.
 */
export const recordReading = async (
  home: string,
  payload: string,
  now: number
): Promise<void> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return;
  }
  const limits = isRecord(parsed) ? parsed.rate_limits : undefined;
  if (!isRecord(limits)) return;
  const fiveHour = windowOf(limits.five_hour);
  const sevenDay = windowOf(limits.seven_day);
  if (fiveHour === undefined && sevenDay === undefined) return;
  const reading: UsageReading = {
    recordedAt: new Date(now).toISOString(),
    ...(fiveHour && { fiveHour }),
    ...(sevenDay && { sevenDay }),
  };
  await writeJsonAtomically(path.join(home, READING_FILE), reading);
};
