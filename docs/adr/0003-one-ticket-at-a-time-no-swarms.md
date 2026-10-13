# The loop runs one ticket at a time; no swarms

The unattended loop takes tickets one at a time from the frontier, with one implementer and one reviewer per ticket. We're optimising for trust and for a small Claude plan's usage limits, not for throughput. Every extra agent starts cold and rebuilds context, which is the most expensive way to spend tokens, and running agents in parallel makes failures harder to attribute while we're still calibrating the gate.

## Considered Options

- **`implement-spec`** (implementer subagents fanned out across worktrees onto an integration branch): rejected for now, because it's multi-agent and the model decides the orchestration rather than deterministic code.
- **Parallel Sandcastle runs**: possible later, once telemetry shows the gate can be trusted unattended.
