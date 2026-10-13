# polesar is the policy layer; Sandcastle is the execution layer

polesar decides what runs, when work is done and what happens next. Running an agent in a sandbox and worktree is delegated to Sandcastle, behind an Executor port. Trust comes from policy (the loop, the gate, ticket state), so that part is ours. Sandboxing is commodity infrastructure, so we use it rather than build it. Every other external system (tracker, gate, usage, journal) also sits behind a port, so backends can be swapped without touching policy, and policy can be tested with in-memory fakes.

## Considered Options

- **Build our own sandbox/runner**: more code to own, with no trust benefit.
- **Use Matt Pocock's `implement-spec` skill as the loop**: model-orchestrated, so not deterministic (see ADR-0003).
