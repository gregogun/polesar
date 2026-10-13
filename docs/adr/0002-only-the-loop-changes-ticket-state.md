# Only the loop changes ticket state; the judge never wrote the code

Agents never write to the tracker. The implementer's job ends at "commits on a branch plus an evidence file". Only polesar, after its own checks, labels, comments on, closes or merges anything. The reviewer is read-only. It returns findings, and the implementer makes any fixes, so every merged line was written by one agent and judged by another. "Done" is therefore a condition polesar verifies, never something an agent claims, and the agent being judged can't influence the record of its own work.

## Considered Options

- **Let the reviewer apply fixes directly**: cheaper per ticket, but the reviewer's own lines would merge with no independent review.
