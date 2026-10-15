import type { Blocker, Ticket, Tracker } from './tracker.ts';

const READY_FOR_AGENT = 'ready-for-agent';
const READY_FOR_HUMAN = 'ready-for-human';

type FrontierTicket = { number: number; title: string };

type HumanBlocker = FrontierTicket & {
  /** How many more AFK tickets the loop could finish on its own once this one closes. */
  unblocks: number;
  /** How many open AFK tickets wait on it, directly or through other open tickets. */
  waiting: number;
  /** Its own open blockers: it can't be started until they close. */
  blockedBy: Omit<Blocker, 'open'>[];
};

type Frontier = {
  /** Open ready-for-agent tickets with every blocker closed: what the loop may work. */
  tickets: FrontierTicket[];
  /** Open ready-for-human tickets that AFK work is waiting on. */
  humanBlockers: HumanBlocker[];
};

/** AFK work: the loop may pick it once unblocked. ready-for-human always wins over ready-for-agent. */
const isAfk = (ticket: Ticket) =>
  ticket.labels.includes(READY_FOR_AGENT) &&
  !ticket.labels.includes(READY_FOR_HUMAN);

const openBlockers = (ticket: Ticket) =>
  ticket.blockedBy.filter((blocker) => blocker.open);

/** The open tickets each of the tracker's own open tickets blocks, by blocker number. */
const blockedTicketsByBlocker = (open: Ticket[]) => {
  const blocks = new Map<number, Ticket[]>();
  for (const ticket of open) {
    const local = openBlockers(ticket).filter(
      (blocker) => blocker.repo === undefined
    );
    for (const blocker of local) {
      blocks.set(blocker.number, [
        ...(blocks.get(blocker.number) ?? []),
        ticket,
      ]);
    }
  }
  return blocks;
};

/** AFK tickets downstream of `start` along open blocking edges. */
const afkDownstream = (start: number, blocks: Map<number, Ticket[]>) => {
  const seen = new Set<number>([start]);
  const queue = [start];
  let afk = 0;
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    for (const ticket of blocks.get(next) ?? []) {
      if (seen.has(ticket.number)) continue;
      seen.add(ticket.number);
      queue.push(ticket.number);
      if (isAfk(ticket)) afk++;
    }
  }
  return afk;
};

/**
 * How many AFK tickets the loop could finish on its own, given `closed` also
 * closes: those whose open blockers are all AFK tickets it can finish.
 */
const loopReach = (open: Ticket[], closed?: number) => {
  const reached = new Set<number>();
  const clears = (blocker: Blocker) =>
    blocker.repo === undefined &&
    (blocker.number === closed || reached.has(blocker.number));
  const pending = open.filter(isAfk);
  for (let grew = true; grew;) {
    grew = false;
    for (const ticket of pending) {
      if (reached.has(ticket.number)) continue;
      if (openBlockers(ticket).every(clears)) {
        reached.add(ticket.number);
        grew = true;
      }
    }
  }
  return reached.size;
};

export const findFrontier = async (tracker: Tracker): Promise<Frontier> => {
  const open = await tracker.openTickets();
  const tickets = open
    .filter((ticket) => isAfk(ticket) && openBlockers(ticket).length === 0)
    .map(({ number, title }) => ({ number, title }));
  const blocks = blockedTicketsByBlocker(open);
  const reach = loopReach(open);
  const humanBlockers = open
    .filter((ticket) => ticket.labels.includes(READY_FOR_HUMAN))
    .map((ticket) => ({
      number: ticket.number,
      title: ticket.title,
      unblocks: loopReach(open, ticket.number) - reach,
      waiting: afkDownstream(ticket.number, blocks),
      blockedBy: openBlockers(ticket).map(({ number, repo }) =>
        repo === undefined ? { number } : { number, repo }
      ),
    }))
    .filter((ticket) => ticket.waiting > 0);
  return { tickets, humanBlockers };
};

const plural = (count: number, noun: string) =>
  `${count} ${noun}${count === 1 ? '' : 's'}`;

const describeHumanBlocker = ({
  number,
  title,
  unblocks,
  waiting,
  blockedBy,
}: HumanBlocker) => {
  const notes = [`unblocks ${unblocks}`];
  if (waiting !== unblocks) {
    notes.push(`${waiting} ${waiting === 1 ? 'waits' : 'wait'} on it`);
  }
  if (blockedBy.length > 0) {
    const refs = blockedBy.map(
      (blocker) => `${blocker.repo ?? ''}#${blocker.number}`
    );
    notes.push(`blocked by ${refs.join(', ')}`);
  }
  return `  #${number} ${title} (${notes.join('; ')})`;
};

/** Short, agent-facing summary of the frontier and the human work holding AFK work up. */
export const describeFrontier = ({
  tickets,
  humanBlockers,
}: Frontier): string => {
  const lines = [
    `frontier: ${plural(tickets.length, 'ticket')}`,
    ...tickets.map((ticket) => `  #${ticket.number} ${ticket.title}`),
  ];
  if (humanBlockers.length > 0) {
    lines.push(
      '',
      'ready-for-human tickets blocking AFK work:',
      ...humanBlockers.map(describeHumanBlocker)
    );
  }
  return `${lines.join('\n')}\n`;
};
