import { describe, expect, it } from 'vitest';
import { runCli } from './run-cli.ts';

/** A Claude Code PreToolUse hook payload for a tool call. */
const toolCall = (toolName: string, toolInput: Record<string, unknown>) =>
  JSON.stringify({
    session_id: 'abc123',
    transcript_path: '/tmp/transcript.jsonl',
    cwd: '/tmp/project',
    hook_event_name: 'PreToolUse',
    tool_name: toolName,
    tool_input: toolInput,
  });

const bash = (command: string) => toolCall('Bash', { command });

const guard = (stdin: string) => runCli(['hook', 'pre-tool-use'], { stdin });

/** Exit 2 blocks the tool call; stderr is fed back to the agent. */
const expectBlocked = async (stdin: string, why: RegExp) => {
  const result = await guard(stdin);
  expect(result.exitCode).toBe(2);
  expect(result.stdout).toBe('');
  expect(result.stderr).toMatch(why);
  return result;
};

const expectAllowed = async (stdin: string) => {
  const result = await guard(stdin);
  expect(result).toEqual({ exitCode: 0, stdout: '', stderr: '' });
};

describe('polesar hook pre-tool-use: skipping pre-commit checks', () => {
  it('blocks git commit --no-verify and says to fix what the hooks report', async () => {
    const result = await expectBlocked(
      bash('git commit --no-verify -m "wip"'),
      /^polesar: blocked/
    );
    expect(result.stderr).toContain('--no-verify');
    expect(result.stderr).toContain('polesar verify');
  });

  it.each([
    'git commit -n -m wip',
    'git commit -anm wip',
    'git commit --no-ver -m wip',
    'git -C repo commit -m wip --no-verify',
    'git add . && git commit -m "$(cat <<\'EOF\'\nwip\nEOF\n)" -n',
    'cd repo; /usr/bin/git commit -qn',
    'sudo -u me env FOO=1 git commit -n',
    "bash -c 'git commit -n -m wip'",
    'echo $(git commit -n)',
    'git -c core.hooksPath=/dev/null commit -m wip',
    'git -c core.hookspath=x commit -m wip',
    'LEFTHOOK=0 git commit -m wip',
    'HUSKY=0 git commit -m wip',
    'env LEFTHOOK=false git commit -m wip',
    'git config core.hooksPath /dev/null',
    'git config --local core.hooksPath .nohooks',
    'git config set core.hookspath x',
    'git config --unset core.hooksPath',
  ])('blocks the equivalent form: %s', async (command) => {
    await expectBlocked(bash(command), /--no-verify/);
  });

  it.each([
    'git commit -m "skip --no-verify in docs"',
    'git commit -m -n',
    'git commit -F msg -- -n',
    'git status -n',
    'git commit -m "$(cat <<\'EOF\'\nDocs: never git commit -n\nEOF\n)"',
    "cat <<'EOF' > notes.md\ngit commit --no-verify\nEOF\ngit commit -m notes",
    'git config core.hooksPath',
    'git config --get core.hooksPath',
    'git config user.name me',
  ])('allows commits that only mention it: %s', async (command) => {
    await expectAllowed(bash(command));
  });
});

describe('polesar hook pre-tool-use: adding the ready-for-agent label', () => {
  it('blocks gh issue edit --add-label ready-for-agent and says to leave it to the user', async () => {
    const result = await expectBlocked(
      bash('gh issue edit 5 --add-label ready-for-agent'),
      /^polesar: blocked/
    );
    expect(result.stderr).toContain('ready-for-agent');
    expect(result.stderr).toMatch(/ask the user/i);
  });

  it.each([
    'gh issue edit 5 --add-label=bug,Ready-For-Agent',
    'gh pr edit 7 --add-label "ready-for-agent"',
    'gh issue create --title Fix --label ready-for-agent',
    'gh issue create -t Fix -l bug -l ready-for-agent',
    'gh -R o/r issue edit 5 --add-label ready-for-agent',
  ])('blocks the equivalent form: %s', async (command) => {
    await expectBlocked(bash(command), /ready-for-agent/);
  });

  it.each([
    'gh issue edit 5 --add-label ready-for-human',
    'gh issue edit 5 --remove-label ready-for-agent',
    'gh issue list --label ready-for-agent',
    'gh issue comment 5 --body "is this ready-for-agent?"',
    'gh issue create --title "Make it ready-for-agent" --label needs-triage',
  ])('allows label changes that are not upgrades: %s', async (command) => {
    await expectAllowed(bash(command));
  });
});

describe('polesar hook pre-tool-use: adding ready-for-agent through gh api', () => {
  it.each([
    "gh api repos/o/r/issues/5/labels -f 'labels[]=ready-for-agent'",
    'gh api -X PUT /repos/o/r/issues/5/labels -f labels[]=bug -f labels[]=ready-for-agent',
    'gh api --method PATCH repos/{owner}/{repo}/issues/5 -F labels[]=ready-for-agent',
    'gh api repos/o/r/issues -f title=Fix -f labels[]=ready-for-agent',
  ])('blocks %s', async (command) => {
    await expectBlocked(bash(command), /ready-for-agent/);
  });

  it.each([
    'gh api -X POST repos/o/r/issues/5/labels --input labels.json',
    "gh api repos/o/r/issues/5/labels -F 'labels[]=@labels.txt'",
    `gh api graphql -f query='mutation { addLabelsToLabelable(input: {labelableId: "I_1", labelIds: ["LA_1"]}) { clientMutationId } }'`,
  ])(
    'blocks label writes it cannot read, saying how to make them readable: %s',
    async (command) => {
      const result = await expectBlocked(bash(command), /ready-for-agent/);
      expect(result.stderr).toMatch(/gh issue edit --add-label/);
    }
  );

  it.each([
    "gh api 'repos/o/r/issues?labels=ready-for-agent'",
    'gh api repos/o/r/issues/5/labels',
    "gh api repos/o/r/issues/5/labels -f 'labels[]=bug'",
    'gh api repos/o/r/issues/5/comments -f body="mark it ready-for-agent?"',
    `gh api graphql -f query='query { repository(owner: "o", name: "r") { label(name: "ready-for-agent") { id } } }'`,
  ])('allows %s', async (command) => {
    await expectAllowed(bash(command));
  });
});

describe('polesar hook pre-tool-use: calling the GitHub API with curl', () => {
  it.each([
    [
      `curl -X POST -H "Authorization: Bearer $GH_TOKEN" https://api.github.com/repos/o/r/issues/5/labels -d '{"labels":["ready-for-agent"]}'`,
      /ready-for-agent/,
    ],
    [
      `curl https://api.github.com/repos/o/r/issues/5/labels --json '["Ready-For-Agent"]'`,
      /ready-for-agent/,
    ],
    [
      'curl -XPOST https://api.github.com/repos/o/r/issues/5/labels -d @labels.json',
      /gh issue edit --add-label/,
    ],
    [
      `curl -s https://api.github.com/repos/o/r/statuses/abc -d '{"state":"success"}'`,
      /commit status/,
    ],
    [
      `curl https://ghe.example.com/api/v3/repos/o/r/check-runs --data '{"name":"ci"}'`,
      /commit status/,
    ],
    [
      `curl https://api.github.com/graphql -d '{"query":"mutation { createCheckRun(input: {}) { clientMutationId } }"}'`,
      /commit status/,
    ],
  ])('blocks %s', async (command, why) => {
    await expectBlocked(bash(command), why);
  });

  it.each([
    'curl https://api.github.com/repos/o/r/issues/5/labels',
    `curl https://api.github.com/repos/o/r/issues/5/labels -d '{"labels":["bug"]}'`,
    `curl -X POST https://api.github.com/repos/o/r/issues/5/comments -d '{"body":"ready-for-agent?"}'`,
    `curl -X POST https://example.com/statuses/abc -d '{"state":"success"}'`,
  ])('allows %s', async (command) => {
    await expectAllowed(bash(command));
  });
});

describe('polesar hook pre-tool-use: MCP tools', () => {
  it.each([
    [
      'mcp__github__issue_write',
      { method: 'update', issue_number: 5, labels: ['bug', 'ready-for-agent'] },
      /ready-for-agent/,
    ],
    [
      'mcp__claude_ai_GitHub__add_labels',
      { issue: 5, labels: 'Ready-For-Agent' },
      /ready-for-agent/,
    ],
    [
      'mcp__github__create_commit_status',
      { sha: 'abc', state: 'success' },
      /commit status/,
    ],
  ])('blocks %s', async (tool, input, why) => {
    await expectBlocked(toolCall(tool, input), why);
  });

  it.each([
    ['mcp__github__list_issues', { labels: ['ready-for-agent'] }],
    ['mcp__github__search_issues', { query: 'label:ready-for-agent' }],
    ['mcp__github__issue_write', { method: 'update', labels: ['bug'] }],
    ['mcp__linear__update_issue_status', { status: 'done' }],
    ['mcp__github__get_me', undefined],
  ])('allows %s', async (tool, input) => {
    await expectAllowed(toolCall(tool, input as Record<string, unknown>));
  });
});

describe('polesar hook pre-tool-use: posting commit statuses', () => {
  it('blocks posting a commit status and says to report check results instead', async () => {
    const result = await expectBlocked(
      bash('gh api repos/o/r/statuses/abc123 -f state=success -f context=ci'),
      /^polesar: blocked/
    );
    expect(result.stderr).toMatch(/commit status/);
    expect(result.stderr).toContain('polesar verify');
  });

  it.each([
    'gh api --method POST /repos/{owner}/{repo}/statuses/$(git rev-parse HEAD) --input status.json',
    'gh api repos/o/r/check-runs -f name=ci -f head_sha=abc -f conclusion=success',
    'gh api -X PATCH repos/o/r/check-runs/42 -f conclusion=success',
    `gh api graphql -f query='mutation { createCheckRun(input: {}) { clientMutationId } }'`,
  ])('blocks the equivalent form: %s', async (command) => {
    await expectBlocked(bash(command), /commit status/);
  });

  it.each([
    'gh api repos/o/r/commits/main/statuses',
    'gh api repos/o/r/commits/main/check-runs',
    'gh pr checks 7',
  ])('allows reading statuses: %s', async (command) => {
    await expectAllowed(bash(command));
  });
});

describe('polesar hook pre-tool-use: accepting decisions', () => {
  it('blocks polesar decide accept and says to leave it to the user', async () => {
    const result = await expectBlocked(
      bash('polesar decide accept 2026-10-14-use-sqlite'),
      /^polesar: blocked/
    );
    expect(result.stderr).toContain('decide accept');
    expect(result.stderr).toMatch(/ask the user/i);
  });

  it.each([
    'node src/cli.ts decide accept 12',
    'pnpm exec polesar decide --json accept 12',
    'npx polesar decide accept 12',
  ])('blocks the equivalent form: %s', async (command) => {
    await expectBlocked(bash(command), /decide accept/);
  });

  it.each([
    'polesar decide propose --from docs/adr/0007.md',
    'polesar decide review',
    'echo "run polesar decide accept when ready"',
    'echo decide accept',
    'grep -r decide accept',
  ])('allows other decision commands: %s', async (command) => {
    await expectAllowed(bash(command));
  });
});

describe('polesar hook pre-tool-use: failing closed', () => {
  it.each([
    ['empty stdin', ''],
    ['non-JSON stdin', 'not json'],
    ['a payload with no tool name', JSON.stringify({ tool_input: {} })],
    ['a JSON array', '[]'],
    ['a Bash call with no command', toolCall('Bash', {})],
    [
      'a Bash call with a non-string command',
      toolCall('Bash', { command: 42 }),
    ],
  ])('blocks on %s', async (_, stdin) => {
    await expectBlocked(
      stdin,
      /^polesar: blocked because the guard hook could not check/
    );
  });

  it('blocks when checking the command fails', async () => {
    const tooDeep = `${'echo $('.repeat(40)}true${')'.repeat(40)}`;
    await expectBlocked(bash(tooDeep), /could not check.*deeper than/);
  });
});

describe('polesar hook pre-tool-use: unrelated tool calls', () => {
  it.each([
    ['a Bash command', bash('pnpm test && git commit -m "feat: add guard"')],
    ['a Read', toolCall('Read', { file_path: '/tmp/project/README.md' })],
    [
      'a Write mentioning blocked actions',
      toolCall('Write', {
        file_path: '/tmp/project/notes.md',
        content: 'gh issue edit 5 --add-label ready-for-agent\ngit commit -n',
      }),
    ],
    ['a tool with no input', JSON.stringify({ tool_name: 'TodoWrite' })],
  ])('allows %s without output', async (_, stdin) => {
    await expectAllowed(stdin);
  });
});
