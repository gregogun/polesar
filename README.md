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

Early. The full design is in [#1](https://github.com/gregogun/polesar/issues/1).

## Usage

### `polesar verify`

Runs a repo's cheap checks, configured in `polesar.json` at the repo root. It can be run from anywhere in the repo, and the checks run from the root:

```json
{
  "verify": {
    "checks": {
      "typecheck": "pnpm tsc --noEmit",
      "lint": "pnpm eslint ."
    }
  }
}
```

Output lists only the checks that failed, with the tail of their output and a path to the full log. `--json` gives structured results for every check. Exit codes: `0` all passed, `1` a check failed, `2` bad usage or config.

### `polesar frontier`

Lists the frontier: the open `ready-for-agent` tickets whose blockers are all closed. These are the tickets an agent may work on its own. Tickets come from the repo's GitHub Issues via `gh`, and blockers from GitHub's native "blocked by" relationships. A `ready-for-human` ticket is never on the frontier. When one holds up AFK work, it's listed separately with how many `ready-for-agent` tickets the loop could finish on its own once it closes (`unblocks`), how many wait on it in all (`waiting`, which also counts work held up by other tickets), and its own open blockers, if any. `--json` gives `{tickets, humanBlockers}`. Exit codes: `0` listed (even if empty), `1` GitHub couldn't be read, `2` bad usage.

The Tracker contract tests check the GitHub adapter against the fake tracker used in tests. They're opt-in and need a throwaway repo you can create and delete issues in: `POLESAR_CONTRACT_REPO=you/scratch-repo pnpm vitest run test/tracker-contract.test.ts`.

### The gate

After review, `polesar loop` pushes `polesar/<n>` to `origin` and opens a pull request for it (or refreshes the body of the one already open). The PR body is rendered from a template: a closing reference to the ticket, the evidence and any non-blocking findings. polesar then waits for the PR's required checks on the commit it pushed, so the base branch's branch protection must require status checks; without them the gate times out red. The wait is capped by `gate.timeoutMinutes` (default 30) in `polesar.json`:

```json
{ "gate": { "timeoutMinutes": 30 } }
```

A red gate is summarized briefly: each failed check, its workflow and the step that failed, with a link. The one free rerun re-triggers only the failed GitHub Actions jobs (`gh run rerun --failed`); checks that aren't Actions jobs aren't rerun. polesar merges through GitHub (`gh pr merge --merge --match-head-commit`), so branch protection applies to it too, and GitHub closes the ticket from the PR's closing reference. If the push, the PR or the merge fails, the loop stops with exit 1 and the ticket keeps its label.

The gate contract test checks the adapter against real GitHub, with real Actions runs, so it takes minutes. It's opt-in and needs a throwaway repo whose `main` branch protection requires a status check named `contract` and no reviews; the test brings its own workflow: `POLESAR_GATE_CONTRACT_REPO=you/scratch-repo pnpm vitest run test/gate-contract.test.ts`.

### Protected paths

`polesar loop` escalates a ticket to `ready-for-human`, even with a green gate and a clean review, when its branch modifies or deletes a protected file: an existing test, verify, lint, format or typecheck config, hook config or a CI workflow ([ADR 0005](docs/adr/0005-protected-paths-escalate-even-when-green.md)). Adding files, new tests included, never escalates. The escalation comment names each protected file touched and the pattern it matched. The default patterns are in [`src/protected-paths.ts`](src/protected-paths.ts). A repo can add patterns, or remove defaults, in `polesar.json`:

```json
{
  "protectedPaths": {
    "add": ["src/policy/**"],
    "remove": ["**/tsconfig*.json"]
  }
}
```

`*` and `?` match within one path segment and `**` matches across segments. Removing a pattern that isn't a default is a config error, so a typo can't fail silently.

Once you've looked at an escalation, record your verdict with `polesar verdict <ticket> approved|rejected`: approved if the held-back change was fine to merge. It's posted as a comment on the ticket for telemetry, so rules can be relaxed on evidence. `--dry-run` and `--json` work as for the other commands.

### Budget and rate limits

`polesar loop` stops before starting a ticket when the budget won't cover it, and exits `3`. The defaults are deliberately conservative. A repo can override any of them in `polesar.json`:

```json
{
  "budget": {
    "ticketTurns": 200,
    "weeklyFloor": 70,
    "loopShare": 25,
    "runCap": 10,
    "maxReadingAgeMinutes": 30
  }
}
```

- `ticketTurns`: agent turns one ticket may take across all its implementer and reviewer runs. Running out escalates the ticket.
- `weeklyFloor`: no new ticket starts once weekly usage is at or above this percent.
- `loopShare`: the percent of weekly usage the loop may spend in a week, across runs.
- `runCap`: the percent of weekly usage one run may spend.

The usage rules are checked before each ticket starts, so the ticket in progress can take a run past them. Usage can't be split by who spent it, so all usage while the loop runs counts as the loop's. Headless runs don't report usage, so polesar reads it from your Claude Code status line (Pro and Max plans). Wrap your status line with `polesar statusline` in `~/.claude/settings.json`:

```json
{
  "statusLine": {
    "type": "command",
    "command": "polesar statusline --command 'bash ~/.claude/statusline.sh'"
  }
}
```

It saves each reading to `~/.polesar/usage.json` (or under `POLESAR_HOME`), then runs your command on the same input, so the status line looks exactly as before. If there's no reading, it has no 7-day window, or it's older than `maxReadingAgeMinutes`, the loop starts no ticket and says how to refresh it.

If an agent hits a rate limit, the run pauses (exit `3`). It uses no retry and changes no labels. Run `polesar loop` again after the reset and it carries on with that ticket from the same step, with its retries and turns as they were. If a human took the ticket off the frontier in the meantime, the paused work is dropped.

### Hooks

`polesar install-hooks` adds polesar's Claude Code hooks to `.claude/settings.json` at the repo root, keeping any settings already there. A polesar hook installed with a different command is replaced rather than duplicated, so rerunning it changes nothing. `--dry-run` shows what it would change, `--json` reports each hook's status (`added`, `updated` or `present`), and `--command` changes how the hooks run polesar (default: `polesar`, which must be on `PATH`).

**Guard (`polesar hook pre-tool-use`).** Blocks an attended agent's tool calls that would break the trust boundary, and tells it what to do instead:

- adding the `ready-for-agent` label (`gh issue edit --add-label`, `gh issue create --label`, `gh api` or `curl` label writes, MCP tools with a `labels` input)
- skipping pre-commit hooks (`git commit --no-verify` / `-n`, `LEFTHOOK=0` / `HUSKY=0`, or changing `core.hooksPath`)
- posting commit statuses or check runs (`gh api`, `curl`, MCP tools)
- `polesar decide accept` and `polesar verdict`

It checks Bash commands and MCP tool calls. It fails closed. A payload it can't read, an error, or polesar missing from `PATH` all block the call. It reads commands the way a shell would, through quoting, chaining, `$(...)`, `sh -c` and wrappers like `sudo`. It is a guard against shortcuts, not a sandbox: a command hidden in a variable or a script file, another HTTP client, or edits to `.git/` or `.claude/settings.json` get past it.

**Stop (`polesar hook stop`).** Sends the agent back with the failure summary when it tries to stop while `verify` fails. It does this once: if the agent stops again with checks still failing, the stop goes through and you get a warning, so a stuck agent can't loop. Repos without `polesar.json` are left alone.

## Development

Requires Node 24 (see `.nvmrc`) and pnpm.

```sh
pnpm install          # also builds dist/ and installs git hooks
pnpm link --global    # puts `polesar` on your PATH
polesar --help
```

Run `pnpm test` for the tests. CI runs the full check suite (`.github/workflows/ci.yml`).
