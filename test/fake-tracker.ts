import { readFile } from 'node:fs/promises';
import {
  TrackerError,
  type Blocker,
  type Ticket,
  type Tracker,
} from '../src/tracker.ts';
import { isRecord } from '../src/verify.ts';
import type { ExternalBlocker, ScriptedTicket } from './tracker-graph.ts';

/** An in-memory tracker holding a scripted issue graph: tickets, labels and blocking edges. */
export class FakeTracker implements Tracker {
  readonly #tickets = new Map<number, Required<ScriptedTicket>>();

  constructor(tickets: ScriptedTicket[]) {
    for (const ticket of tickets) {
      this.#tickets.set(ticket.number, {
        state: 'open',
        body: '',
        ...ticket,
        labels: [...(ticket.labels ?? [])],
        blockedBy: [...(ticket.blockedBy ?? [])],
      });
    }
  }

  openTickets(): Promise<Ticket[]> {
    const open = [...this.#tickets.values()]
      .filter((ticket) => ticket.state === 'open')
      .sort((a, b) => a.number - b.number)
      .map(({ number, title, body, labels, blockedBy }) => ({
        number,
        title,
        body,
        labels: [...labels],
        blockedBy: blockedBy.map((blocker) => this.#blocker(blocker)),
      }));
    return Promise.resolve(open);
  }

  addLabel(ticket: number, label: string): Promise<void> {
    const { labels } = this.#ticket(ticket);
    if (!labels.includes(label)) labels.push(label);
    return Promise.resolve();
  }

  removeLabel(ticket: number, label: string): Promise<void> {
    const found = this.#ticket(ticket);
    found.labels = found.labels.filter((existing) => existing !== label);
    return Promise.resolve();
  }

  comment(ticket: number, _body: string): Promise<void> {
    this.#ticket(ticket);
    return Promise.resolve();
  }

  close(ticket: number): Promise<void> {
    this.#ticket(ticket).state = 'closed';
    return Promise.resolve();
  }

  #blocker(blocker: number | ExternalBlocker): Blocker {
    return typeof blocker === 'number'
      ? { number: blocker, open: this.#ticket(blocker).state === 'open' }
      : {
          number: blocker.number,
          open: blocker.state === 'open',
          repo: blocker.repo,
        };
  }

  #ticket(number: number) {
    const ticket = this.#tickets.get(number);
    if (!ticket) throw new TrackerError(`no ticket #${number}`);
    return ticket;
  }
}

const isState = (value: unknown) => value === 'open' || value === 'closed';

const isBlocker = (value: unknown) =>
  typeof value === 'number' ||
  (isRecord(value) &&
    typeof value.repo === 'string' &&
    typeof value.number === 'number' &&
    isState(value.state));

const isScriptedTicket = (value: unknown): value is ScriptedTicket =>
  isRecord(value) &&
  typeof value.number === 'number' &&
  typeof value.title === 'string' &&
  (value.body === undefined || typeof value.body === 'string') &&
  (value.state === undefined || isState(value.state)) &&
  (value.labels === undefined ||
    (Array.isArray(value.labels) &&
      value.labels.every((label) => typeof label === 'string'))) &&
  (value.blockedBy === undefined ||
    (Array.isArray(value.blockedBy) && value.blockedBy.every(isBlocker)));

/** A fake tracker scripted by a JSON file of `{"tickets": [...]}`, for running the CLI end to end. */
export const loadFakeTracker = async (file: string): Promise<FakeTracker> => {
  let graph: unknown;
  try {
    graph = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new TrackerError(`can't read fake tracker ${file}: ${reason}`);
  }
  if (!isRecord(graph) || !Array.isArray(graph.tickets)) {
    throw new TrackerError(`fake tracker ${file} must hold {"tickets": [...]}`);
  }
  const invalid = graph.tickets.find((ticket) => !isScriptedTicket(ticket));
  if (invalid !== undefined) {
    throw new TrackerError(
      `fake tracker ticket must be {number, title, body?, state?, labels?, blockedBy?}, got ${JSON.stringify(invalid)}`
    );
  }
  return new FakeTracker(graph.tickets as ScriptedTicket[]);
};
