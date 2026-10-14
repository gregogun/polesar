import type { Ticket, Tracker } from './tracker.ts';

const READY_FOR_AGENT = 'ready-for-agent';
const READY_FOR_HUMAN = 'ready-for-human';

type FrontierTicket = { number: number; title: string };

type HumanBlocker = FrontierTicket & {
  /** How many open AFK tickets wait on it, directly or through other open tickets. */
  unblocks: number;
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

/** The open tickets each of the tracker's own open tickets blocks, by blocker number. */
const blockedTicketsByBlocker = (open: Ticket[]) => {
  const blocks = new Map<number, Ticket[]>();
  for (const ticket of open) {
    const local = ticket.blockedBy.filter(
      (blocker) => blocker.open && blocker.repo === undefined
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

export const findFrontier = async (tracker: Tracker): Promise<Frontier> => {
  const open = await tracker.openTickets();
  const tickets = open
    .filter(
      (ticket) =>
        isAfk(ticket) && ticket.blockedBy.every((blocker) => !blocker.open)
    )
    .map(({ number, title }) => ({ number, title }));
  const blocks = blockedTicketsByBlocker(open);
  const humanBlockers = open
    .filter((ticket) => ticket.labels.includes(READY_FOR_HUMAN))
    .map(({ number, title }) => ({
      number,
      title,
      unblocks: afkDownstream(number, blocks),
    }))
    .filter((ticket) => ticket.unblocks > 0);
  return { tickets, humanBlockers };
};

const plural = (count: number, noun: string) =>
  `${count} ${noun}${count === 1 ? '' : 's'}`;

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
      ...humanBlockers.map(
        (ticket) =>
          `  #${ticket.number} ${ticket.title} (unblocks ${ticket.unblocks})`
      )
    );
  }
  return `${lines.join('\n')}\n`;
};
