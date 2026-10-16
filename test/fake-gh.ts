/**
 * A scripted `gh` and `git`, run in place of the real ones (see `test/gh-script.ts`),
 * so the real GitHub gate can be driven through the CLI with no network.
 * Invoked as `fake-gh.ts <gh|git> <args...>`. It reads the script that
 * POLESAR_GH_FAKE names, keeps PRs and call counts in POLESAR_GH_STATE, logs
 * every call to POLESAR_FAKE_LOG and reads the branches the fake implementer
 * committed to from POLESAR_FAKE_STATE, so the PR holds what was committed.
 */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import type { GhScript } from './gh-script.ts';

const {
  POLESAR_GH_FAKE = '',
  POLESAR_GH_STATE = '',
  POLESAR_FAKE_LOG,
  POLESAR_FAKE_STATE = '',
} = process.env;

type GhState = {
  /** Open PRs by head branch. */
  prs: Record<string, number>;
  nextPr: number;
  /** `gh pr checks` calls so far, per branch. */
  checks: Record<string, number>;
  /** PRs `gh pr merge` was run on. */
  merged: number[];
};

const readJson = <T>(file: string, fallback: T): T => {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
};

const script = readJson<GhScript>(POLESAR_GH_FAKE, {});
const state = readJson<GhState>(POLESAR_GH_STATE, {
  prs: { ...script.openPrs },
  nextPr: 100,
  checks: {},
  merged: [],
});
const save = () => writeFileSync(POLESAR_GH_STATE, JSON.stringify(state));

const [program = '', ...args] = process.argv.slice(2);
if (POLESAR_FAKE_LOG) {
  appendFileSync(
    POLESAR_FAKE_LOG,
    `${JSON.stringify({ port: program, method: args.slice(0, 2).join(' '), args })}\n`
  );
}

const out = (text: string) => process.stdout.write(`${text}\n`);
const fail = (message: string, code = 1): never => {
  process.stderr.write(`${message}\n`);
  process.exit(code);
};
const flag = (name: string) => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};

const commitsOf = (branch: string) =>
  readJson<{ branches?: Record<string, string[]> }>(POLESAR_FAKE_STATE, {})
    .branches?.[branch] ?? [];
const branchOf = (pr: string | undefined) =>
  Object.entries(state.prs).find(([, number]) => String(number) === pr)?.[0] ??
  fail(`no pull requests found for ${pr}`);

const scriptedFailure = () =>
  script.fail?.[
    program === 'git' ? (args[0] ?? '') : args.slice(0, 2).join(' ')
  ];

const git = () => {
  const failure = scriptedFailure();
  if (failure !== undefined) fail(failure);
  if (args[0] === 'push') return;
  if (args[0] === 'rev-parse') {
    const ref = args.at(-1) ?? '';
    const branch = ref
      .replace(/^refs\/heads\//, '')
      .replace(/\^\{commit\}$/, '');
    const head = commitsOf(branch).at(-1);
    return head === undefined
      ? fail(`fatal: Needed a single revision`, 128)
      : out(head);
  }
  fail(`fake git: unscripted command: git ${args.join(' ')}`);
};

const gh = () => {
  const failure = scriptedFailure();
  if (failure !== undefined) fail(failure);
  const command = args.slice(0, 2).join(' ');
  if (command === 'pr list') {
    const branch = flag('--head') ?? '';
    const number = state.prs[branch];
    return out(JSON.stringify(number === undefined ? [] : [{ number }]));
  }
  if (command === 'pr create') {
    const branch = flag('--head') ?? '';
    const number = state.nextPr++;
    state.prs[branch] = number;
    save();
    return out(`https://github.com/owner/repo/pull/${number}`);
  }
  if (command === 'pr edit') return;
  if (command === 'pr view') {
    const commits = commitsOf(branchOf(args[2]));
    const merged = state.merged.includes(Number(args[2])) && !script.queued;
    return out(
      JSON.stringify({
        headRefOid: commits.at(-1) ?? '',
        commits: commits.map((oid) => ({ oid })),
        baseRefName: 'main',
        state: merged ? 'MERGED' : 'OPEN',
      })
    );
  }
  if (args[0] === 'api') {
    const endpoint = args[1] ?? '';
    if (endpoint === 'repos/{owner}/{repo}/rules/branches/main') {
      const contexts = script.required ?? ['check'];
      return out(
        JSON.stringify(
          contexts.length === 0
            ? []
            : [
                { type: 'pull_request', parameters: {} },
                {
                  type: 'required_status_checks',
                  parameters: {
                    required_status_checks: contexts.map((context) => ({
                      context,
                    })),
                  },
                },
              ]
        )
      );
    }
    if (endpoint === 'repos/{owner}/{repo}/branches/main') {
      return out(
        JSON.stringify({
          name: 'main',
          protection:
            script.classic === undefined
              ? { enabled: false }
              : {
                  enabled: true,
                  required_status_checks: {
                    contexts: script.classic,
                    checks: script.classic.map((context) => ({ context })),
                  },
                },
        })
      );
    }
  }
  if (command === 'pr checks') {
    const branch = branchOf(args[2]);
    const call = (state.checks[branch] ?? 0) + 1;
    state.checks[branch] = call;
    save();
    const polls = script.checks?.[branch] ?? [
      [{ name: 'check', bucket: 'pass' }],
    ];
    const poll = polls[Math.min(call, polls.length) - 1] ?? [];
    if (poll === 'none') {
      return fail(`no required checks reported on the '${branch}' branch`);
    }
    const checks = poll.map((check) => ({
      description: '',
      link: '',
      workflow: '',
      ...check,
    }));
    // With --json, gh exits 0 whatever the checks' state.
    return out(JSON.stringify(checks));
  }
  if (command === 'run view') {
    return out(JSON.stringify(script.runs?.[args[2] ?? ''] ?? { jobs: [] }));
  }
  if (command === 'pr merge') {
    state.merged.push(Number(args[2]));
    return save();
  }
  if (command === 'run rerun') return;
  fail(`fake gh: unscripted command: gh ${args.join(' ')}`);
};

if (program === 'git') git();
else gh();
