import path from 'node:path';
import {
  ConfigError,
  findConfig,
  isRecord,
  MissingConfigError,
  readConfig,
} from './config.ts';
import {
  readJsonIfPresent,
  writeJsonAtomically,
  type UsageReading,
  type UsageWindow,
} from './usage.ts';

/**
 * How much the unattended loop may spend. Deliberately conservative defaults,
 * to be tuned from telemetry; `budget` in polesar.json overrides any of them.
 */
export type Budget = {
  /** Agent turns one ticket may take across all its implementer and reviewer runs. */
  ticketTurns: number;
  /** Percent of weekly usage one run may spend before it stops. */
  runCap: number;
  /** Percent of weekly usage the loop may spend per week, across runs. */
  loopShare: number;
  /** No new ticket starts once weekly usage is at or above this percent. */
  weeklyFloor: number;
  /** A usage reading older than this many minutes is too stale to start a ticket on. */
  maxReadingAgeMinutes: number;
};

const DEFAULT_BUDGET: Budget = {
  ticketTurns: 200,
  runCap: 10,
  loopShare: 25,
  weeklyFloor: 70,
  maxReadingAgeMinutes: 30,
};

const PERCENTAGES = new Set<keyof Budget>([
  'runCap',
  'loopShare',
  'weeklyFloor',
]);

const BUDGET_EXAMPLE = `"budget": ${JSON.stringify(DEFAULT_BUDGET)}`;

const isBudgetKey = (key: string): key is keyof Budget =>
  Object.hasOwn(DEFAULT_BUDGET, key);

/**
 * The repo's budget: the defaults, with any set under `budget` in the nearest
 * polesar.json from `cwd`. Without a polesar.json, or without that key, the
 * defaults stand.
 */
export const loadBudget = async (cwd: string): Promise<Budget> => {
  let file: string;
  try {
    file = await findConfig(cwd);
  } catch (error) {
    if (error instanceof MissingConfigError) return DEFAULT_BUDGET;
    throw error;
  }
  const config = await readConfig(file);
  const override = isRecord(config) ? config.budget : undefined;
  if (override === undefined) return DEFAULT_BUDGET;
  if (!isRecord(override)) {
    throw new ConfigError(
      `${file}: "budget" must be an object, e.g.:\n${BUDGET_EXAMPLE}`
    );
  }
  const budget = { ...DEFAULT_BUDGET };
  for (const [key, value] of Object.entries(override)) {
    if (!isBudgetKey(key)) {
      throw new ConfigError(
        `${file}: "budget.${key}" is not a budget setting. The settings and their defaults are:\n${BUDGET_EXAMPLE}`
      );
    }
    const max = PERCENTAGES.has(key) ? 100 : Infinity;
    if (typeof value !== 'number' || !(value > 0 && value <= max)) {
      throw new ConfigError(
        `${file}: "budget.${key}" must be a number above 0${max === 100 ? ' and at most 100 (a percent of weekly usage)' : ''}, got ${JSON.stringify(value)}`
      );
    }
    budget[key] = value;
  }
  return budget;
};

/** Percentages as the loop reports them: to one decimal place at most. */
const percent = (value: number) => `${Math.round(value * 10) / 10}%`;

/** Which budget rule stopped a run before its next ticket. */
export type BudgetRule =
  'no-usage' | 'stale-usage' | 'weekly-floor' | 'loop-share' | 'run-cap';

export type BudgetStop = { rule: BudgetRule; detail: string };

/** Weekly usage spent by this run, as of the last fresh reading it took. */
export type RunSpend = { used: number; last?: UsageWindow };

/** Weekly usage the loop has spent across runs in one 7-day window. */
type LoopLedger = { window: string; used: number };

const LEDGER_FILE = 'loop-usage.json';

const isLedger = (value: unknown): value is LoopLedger =>
  isRecord(value) &&
  typeof value.window === 'string' &&
  typeof value.used === 'number';

/** Readings a little apart can disagree on a reset time; within this, it's the same window. */
const SAME_WINDOW_MS = 60 * 60 * 1000;

const sameWindow = (a: UsageWindow, b: UsageWindow) =>
  Math.abs(Date.parse(a.resetsAt) - Date.parse(b.resetsAt)) < SAME_WINDOW_MS;

/**
 * Why `reading` can't be trusted to start a ticket on, if it can't: there is
 * none, it has no 7-day window, it's older than the budget allows, or its
 * window has reset since.
 */
const unusable = (
  reading: UsageReading | null,
  now: number,
  { maxReadingAgeMinutes }: Budget
): BudgetStop | undefined => {
  const refresh =
    'set `polesar statusline` as your Claude Code status line (see polesar --help) and use Claude Code to refresh it';
  if (reading?.sevenDay === undefined) {
    return {
      rule: 'no-usage',
      detail: `no ${reading ? '7-day ' : ''}usage reading, so the budget can't be checked: ${refresh}`,
    };
  }
  const age = (now - Date.parse(reading.recordedAt)) / 60_000;
  if (!(age <= maxReadingAgeMinutes)) {
    return {
      rule: 'stale-usage',
      detail: `the usage reading is stale (recorded ${Number.isNaN(age) ? 'at an unknown time' : `${Math.floor(age)} min ago`}, over the ${maxReadingAgeMinutes} min limit in budget.maxReadingAgeMinutes): ${refresh}`,
    };
  }
  if (Date.parse(reading.sevenDay.resetsAt) <= now) {
    return {
      rule: 'stale-usage',
      detail: `the usage reading's 7-day window reset at ${reading.sevenDay.resetsAt}, after it was recorded: ${refresh}`,
    };
  }
  return undefined;
};

/**
 * Keeps the books on weekly usage the loop spends. Usage can't be split by
 * who spent it, so everything spent while the loop runs counts as the loop's:
 * the budget errs towards stopping early.
 */
export class Books {
  readonly #ledgerFile: string;
  readonly #budget: Budget;
  spend: RunSpend;

  constructor(home: string, budget: Budget, spend: RunSpend = { used: 0 }) {
    this.#ledgerFile = path.join(home, LEDGER_FILE);
    this.#budget = budget;
    this.spend = spend;
  }

  /**
   * Books what was spent since the last fresh reading, then says why no new
   * ticket may start, if one may not.
   */
  async check(
    reading: UsageReading | null,
    now: number
  ): Promise<BudgetStop | undefined> {
    const problem = unusable(reading, now, this.#budget);
    if (problem !== undefined || reading?.sevenDay === undefined) {
      return problem;
    }
    const week = reading.sevenDay;
    const ledger = await this.#book(week);
    const { weeklyFloor, loopShare, runCap } = this.#budget;
    if (week.usedPercentage >= weeklyFloor) {
      return {
        rule: 'weekly-floor',
        detail: `weekly usage is at ${percent(week.usedPercentage)}, at or above the ${percent(weeklyFloor)} floor for starting a ticket`,
      };
    }
    if (ledger.used >= loopShare) {
      return {
        rule: 'loop-share',
        detail: `the loop has used ${percent(ledger.used)} of this week's usage, at or above its ${percent(loopShare)} share`,
      };
    }
    if (this.spend.used >= runCap) {
      return {
        rule: 'run-cap',
        detail: `this run has used ${percent(this.spend.used)} of weekly usage, at or above the ${percent(runCap)} per-run cap`,
      };
    }
    return undefined;
  }

  /** Books what was spent up to a final reading, when it's fresh enough to trust. */
  async close(reading: UsageReading | null, now: number): Promise<void> {
    if (
      unusable(reading, now, this.#budget) === undefined &&
      reading?.sevenDay
    ) {
      await this.#book(reading.sevenDay);
    }
  }

  async #book(week: UsageWindow): Promise<LoopLedger> {
    const { last } = this.spend;
    // A new window's whole usage so far is booked to the loop: it can't tell how much was its own.
    const spent =
      last === undefined
        ? 0
        : sameWindow(last, week)
          ? Math.max(0, week.usedPercentage - last.usedPercentage)
          : week.usedPercentage;
    this.spend = { used: this.spend.used + spent, last: week };
    const stored = await readJsonIfPresent(this.#ledgerFile);
    if (stored !== undefined && !isLedger(stored)) {
      // Starting the books afresh would quietly hand the loop a whole new share.
      throw new ConfigError(
        `${this.#ledgerFile} can't be read as the loop's weekly usage. Fix it, or delete it to count the loop's usage this week from zero.`
      );
    }
    const ledger: LoopLedger =
      isLedger(stored) &&
      sameWindow({ usedPercentage: 0, resetsAt: stored.window }, week)
        ? stored
        : { window: week.resetsAt, used: 0 };
    const booked = { ...ledger, used: ledger.used + spent };
    if (spent > 0 || ledger !== stored) {
      await writeJsonAtomically(this.#ledgerFile, booked);
    }
    return booked;
  }
}
