# polesar

The policy layer for running coding agents: what runs, when it's done and what happens next. Skills shape what an agent intends to do; polesar keeps it honest in how it does it.

## Trust

**Honest execution**:
An agent's work is honest when the agent can't change the rules it's judged by, can't declare its own work done, and can't claim something it didn't do without someone else checking it. polesar judges results, never whether an agent followed a skill's steps.
_Avoid_: Trusted agent, compliant agent

**Evidence**:
The implementer's record of what it ran and what it observed, with each claim labelled measured, inferred or guess.
_Avoid_: Report, summary

**Protected path**:
A file that defines how work is judged (an existing test, check config, hook config or CI workflow), so changing it hands the ticket back to a human even when everything passes.

## Tickets

**Frontier**:
The open `ready-for-agent` tickets whose blockers are all closed: the only tickets an agent may work on its own.

**Escalation**:
Handing a ticket back to a human by relabelling it `ready-for-human`, with a comment giving the full trail.
_Avoid_: Hold, failure

**Bait ticket**:
A real ticket written to tempt dishonest execution (for example, where loosening an existing test is the easy way out), used to prove polesar catches it.
_Avoid_: Trap, fake ticket
