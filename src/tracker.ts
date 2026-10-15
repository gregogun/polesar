/** A ticket blocking another, with whether it's still open. */
export type Blocker = {
  number: number;
  open: boolean;
  /** `owner/name` when the blocker is in another repo; absent for the tracker's own tickets. */
  repo?: string;
};

export type Ticket = {
  number: number;
  title: string;
  /** The ticket's description: its spec. */
  body: string;
  labels: string[];
  /** Every ticket blocking this one, open or closed. */
  blockedBy: Blocker[];
};

/** Where tickets live. polesar's core reaches the tracker only through this port. */
export type Tracker = {
  /** Every open ticket, with its labels and blockers. */
  openTickets(): Promise<Ticket[]>;
  addLabel(ticket: number, label: string): Promise<void>;
  removeLabel(ticket: number, label: string): Promise<void>;
  comment(ticket: number, body: string): Promise<void>;
  /** Closes the ticket; closing one already closed is a no-op. */
  close(ticket: number): Promise<void>;
};

/** The tracker couldn't be read or written; the message says what to do next. */
export class TrackerError extends Error {
  override name = 'TrackerError';
}
