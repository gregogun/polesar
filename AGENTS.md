# polesar

A trust-first policy layer for running coding agents. Spec: issue #1. Decisions: `docs/adr/`.

TypeScript CLI, pnpm. Node 24 (`.nvmrc`); TS runs natively in dev, `dist/` is built on install.

## Layout

- `src/cli.ts`: CLI entry point (the `polesar` bin, built to `dist/cli.js`)
- `test/`: tests at the CLI boundary. Use `runCli` from `test/run-cli.ts`; don't test internals.

## Running

- `pnpm install` (also builds `dist/` and installs git hooks), then `pnpm link --global` to put `polesar` on PATH
- Without linking: `node src/cli.ts --help`

## Checks

CI runs `pnpm format:check`, `pnpm lint`, `pnpm types:check`, `pnpm knip`, `pnpm build` and `pnpm test`. Run them before calling work done.

Pre-commit (lefthook) runs only the cheap checks: format, lint on staged files, secret scan. Don't bypass it with `--no-verify`.

## Commits

[Conventional Commits](https://www.conventionalcommits.org/), one logical change per commit.

## Agent skills

### Issue tracker

GitHub Issues on gregogun/polesar, via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-role vocabulary (needs-triage, needs-info, ready-for-agent, ready-for-human, wontfix). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
