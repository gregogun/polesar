export type ScriptedTicket = {
  number: number;
  title: string;
  /** Defaults to empty. */
  body?: string;
  /** Defaults to open. */
  state?: 'open' | 'closed';
  labels?: string[];
  /** The tickets blocking this one: numbers in this graph, or tickets in another repo. */
  blockedBy?: (number | ExternalBlocker)[];
};

/** A ticket in another repo, outside the scripted graph. */
export type ExternalBlocker = {
  repo: string;
  number: number;
  state: 'open' | 'closed';
};

const GRAPH_FILE = 'tracker.json';

/** `runCli` options that run polesar against a fake tracker scripted with these tickets. */
export const trackerGraph = (tickets: ScriptedTicket[]) => ({
  files: { [GRAPH_FILE]: JSON.stringify({ tickets }) },
  env: { POLESAR_TRACKER_FAKE: GRAPH_FILE },
});
