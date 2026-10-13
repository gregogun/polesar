---
status: accepted (provisional, revisit with telemetry)
---

# Changes to protected paths escalate even when everything is green

If a ticket's diff modifies or deletes an existing test, verify/lint/typecheck config, hook config or CI workflow, the ticket escalates to `ready-for-human`, even when the gate and review both pass. Otherwise an agent could weaken a check and then "pass" it. Because CI runs workflow files from the PR's own branch, this rule is what protects the gate itself. Adding new tests doesn't escalate. We accept that some useful changes will be blocked. Your verdict on each escalation is recorded, so specific rules can be relaxed based on evidence rather than intuition.
