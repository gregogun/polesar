---
status: accepted
---

# Agents work in a throwaway clone, and only a bundle comes back

Sandcastle mounts the repo's `.git` into the sandbox read-write. An agent could then plant a hook, a `core.fsmonitor` command or other config there, and the next `git` command polesar ran on the host would run it, with the host's GitHub token in reach. So each ticket's sandbox works in a clone under polesar's home, made with `--no-local` and no remote. The repo's own `.git` never enters the sandbox. polesar runs git in the clone only before any agent has been in it. Afterwards it checks refs, the checked-out branch and the working tree with git inside the sandbox. It brings the branch's new commits back as a `git bundle`, which the repo fetches with `transfer.fsckObjects`. On the host, git reads that one file and nothing else of the clone's. It reads the bundle and the evidence file only if they're plain files inside the worktree, so a symlink can't point polesar at the host's files.

A run that leaves the ticket branch, moves another ref, or (for the reviewer) changes anything at all has its sandbox and clone discarded, so none of it reaches the repo. Every agent run ends by killing whatever is left running in the sandbox, because aborting a run only stops polesar waiting on it.

We accept the costs: a full clone per ticket, losing a discarded sandbox's uncommitted work, and checks inside the sandbox that an agent can mislead about the clone, though never about the repo. One host git call is left: Sandcastle reads the clone's HEAD on the host at the start of each run. polesar mounts the clone's `.git/config` and `.git/hooks` read-only in the sandbox so that call can't be rigged.
