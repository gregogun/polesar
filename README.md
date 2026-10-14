# polesar

A trust-first policy layer for running coding agents.

polesar works through a project's GitHub issues. It picks the tickets an agent may do on its own, runs an implementer in a sandbox, has an independent read-only reviewer check the result, opens a PR, waits for CI, then merges or hands the ticket back to a human with the full trail.

Trust comes from checks the agent can't bypass, not from what the agent says:

- **Only polesar changes ticket state.** Agents never label, comment on, close or merge anything.
- **Every merged line is written by one agent and judged by another.**
- **"Done" is a condition polesar checks**: green CI, no blocking findings, every commit reviewed, evidence attached.
- **The system may involve you more on its own, but never less.**

polesar is the policy layer. Execution (sandbox, worktree, agent run) is delegated to [Sandcastle](https://github.com/mattpocock/sandcastle). See [`docs/adr/`](docs/adr/) for the decisions behind this.

## Status

Early. The CLI currently supports only `--help` and `--version`. The full design is in [#1](https://github.com/gregogun/polesar/issues/1).

## Development

Requires Node 24 (see `.nvmrc`) and pnpm.

```sh
pnpm install          # also builds dist/ and installs git hooks
pnpm link --global    # puts `polesar` on your PATH
polesar --help
```

Run `pnpm test` for the tests. CI runs the full check suite (`.github/workflows/ci.yml`).
