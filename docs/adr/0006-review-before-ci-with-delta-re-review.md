# Review runs before CI, and every change made after review is reviewed too

Order per ticket: the implementer commits (cheap checks run at pre-commit), then the read-only reviewer runs, then a PR is opened and CI runs. Pre-commit already stops the reviewer from seeing code that cheap checks would reject, so reviewing first catches spec mismatches before any CI minutes or wall-clock time are spent. To keep "every merged line was reviewed" true, any commit made after the review (for example a CI fix) gets a review of just that change before merging. Blocking findings from those reviews count against the same review-retry budget, so the loop always ends.

## Considered Options

- **Review after CI is green**: the review sees final code, but Opus review is spent only after CI time, and reviewer findings still force another CI run.
