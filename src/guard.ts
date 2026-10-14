import { commandsIn, type Command } from './shell.ts';

/** Why a tool call is blocked, written for the agent: what to do instead. */
export type Verdict = { blocked: false } | { blocked: true; reason: string };

const allow: Verdict = { blocked: false };
const block = (reason: string): Verdict => ({ blocked: true, reason });

/** Git's options that come before the subcommand and take a separate value. */
const GIT_VALUE_OPTIONS = new Set([
  '-C',
  '-c',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--exec-path',
  '--config-env',
]);

/** The git subcommand and its args, skipping git's own options. */
const gitSubcommand = (args: string[]) => {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (GIT_VALUE_OPTIONS.has(arg)) i++;
    else if (!arg.startsWith('-')) {
      return { name: arg, args: args.slice(i + 1), globals: args.slice(0, i) };
    }
  }
  return undefined;
};

/** `git commit` short options whose value follows (attached or as the next arg). */
const COMMIT_VALUE_SHORTS = 'mFcCt';
/** `git commit` short options with an optional attached value. */
const COMMIT_OPTIONAL_SHORTS = 'uS';

/** Whether `git commit` args skip the pre-commit hooks: `--no-verify`, any unambiguous prefix, or `-n`. */
const skipsHooks = (args: string[]): boolean => {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--') return false;
    if (arg.startsWith('--')) {
      const name = arg.split('=')[0]!;
      // Git accepts unambiguous prefixes; `--no-ver` is the shortest.
      if (name.length >= '--no-ver'.length && '--no-verify'.startsWith(name)) {
        return true;
      }
    } else if (arg.startsWith('-') && arg.length > 1) {
      for (const [index, flag] of [...arg.slice(1)].entries()) {
        if (flag === 'n') return true;
        if (COMMIT_OPTIONAL_SHORTS.includes(flag)) break;
        if (COMMIT_VALUE_SHORTS.includes(flag)) {
          // `-m msg` takes the next arg; `-mmsg` has it attached.
          if (index === arg.length - 2) i++;
          break;
        }
      }
    }
  }
  return false;
};

const NO_VERIFY = block(
  'polesar: blocked: git commit must run the pre-commit hooks, so --no-verify (-n), changing core.hooksPath and LEFTHOOK=0 or HUSKY=0 are not allowed. ' +
    "Commit without it and fix whatever the hooks report; 'polesar verify' shows which checks fail."
);

/** Environment that makes a hook manager skip its hooks. */
const HOOKS_OFF_ENV = /^(LEFTHOOK=(0|false)|HUSKY=0)$/i;

/** `git config` options that write rather than read. */
const CONFIG_WRITE_OPTIONS =
  /^--(unset|unset-all|add|replace-all|rename-section|remove-section)$/;

/**
 * Whether `git config` args change core.hooksPath: setting a value, unsetting
 * it (which turns off hook managers like husky that set it), or the
 * `git config set`/`unset` subcommands.
 */
const movesHooksPath = (args: string[]): boolean => {
  const key = args.findIndex((arg) => arg.toLowerCase() === 'core.hookspath');
  if (key === -1) return false;
  const before = args.slice(0, key);
  const after = args.slice(key + 1).filter((arg) => !arg.startsWith('-'));
  return (
    after.length > 0 ||
    before.some((arg) => CONFIG_WRITE_OPTIONS.test(arg)) ||
    before.includes('set') ||
    before.includes('unset')
  );
};

const checkGit = (args: string[], env: string[]): Verdict => {
  const sub = gitSubcommand(args);
  if (sub?.name === 'config') {
    return movesHooksPath(sub.args) ? NO_VERIFY : allow;
  }
  if (sub?.name !== 'commit') return allow;
  // Pointing core.hooksPath elsewhere for one commit skips the hooks too.
  const movesHooks = sub.globals.some((arg) =>
    arg.toLowerCase().startsWith('core.hookspath=')
  );
  const hooksOff = env.some((assignment) => HOOKS_OFF_ENV.test(assignment));
  if (movesHooks || hooksOff || skipsHooks(sub.args)) return NO_VERIFY;
  return allow;
};

const UPGRADE = block(
  'polesar: blocked: only a human may add the ready-for-agent label (docs/adr/0004). ' +
    'Leave it off (use needs-triage or ready-for-human if the ticket needs a label), ' +
    'and ask the user to add ready-for-agent themselves if they think the ticket is ready.'
);

const READY_FOR_AGENT = 'ready-for-agent';

/** GitHub label names are case-insensitive. */
const namesReadyForAgent = (labels: string) =>
  labels
    .split(',')
    .some((label) => label.trim().toLowerCase() === READY_FOR_AGENT);

/** The values given to any of `flags`, as `--flag value`, `--flag=value` or `-fvalue`. */
const flagValues = (args: string[], flags: string[]): string[] => {
  const values: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    for (const flag of flags) {
      if (arg === flag) values.push(args[++i] ?? '');
      else if (flag.startsWith('--') && arg.startsWith(`${flag}=`)) {
        values.push(arg.slice(flag.length + 1));
      } else if (!flag.startsWith('--') && arg.startsWith(flag)) {
        values.push(arg.slice(flag.length));
      }
    }
  }
  return values;
};

/** `gh` positionals (e.g. `issue edit 5`), skipping `-R`/`--repo` values. */
const ghPositionals = (args: string[]) =>
  args.filter(
    (arg, i) =>
      !arg.startsWith('-') && args[i - 1] !== '-R' && args[i - 1] !== '--repo'
  );

const UNREADABLE_LABELS = block(
  "polesar: blocked: this gh api call may add labels the guard can't read (a file, stdin or label IDs), " +
    'and only a human may add the ready-for-agent label (docs/adr/0004). ' +
    'Add labels with gh issue edit --add-label <label> instead.'
);

/** `gh api` options that take a value. */
const GH_API_VALUE_OPTIONS = new Set([
  '-X',
  '--method',
  '-f',
  '--raw-field',
  '-F',
  '--field',
  '-H',
  '--header',
  '--input',
  '-q',
  '--jq',
  '-t',
  '--template',
  '--hostname',
  '--cache',
  '-p',
  '--preview',
]);

/** A GitHub API request, however it is sent: `gh api`, curl or similar. */
type ApiRequest = {
  /** The endpoint path without its query string or leading slash; `graphql` for GraphQL. */
  path: string;
  method: string;
  /** Label names the request sets. */
  labels: string[];
  /** The GraphQL query text, if any. */
  graphql: string;
  /** The request body (or part of it) comes from a file or stdin. */
  opaque: boolean;
};

const parseGhApi = (args: string[]): ApiRequest => {
  const endpoint =
    args.find(
      (arg, i) =>
        !arg.startsWith('-') && !GH_API_VALUE_OPTIONS.has(args[i - 1]!)
    ) ?? '';
  const fields = flagValues(args, ['-f', '--raw-field', '-F', '--field']).map(
    (field) => {
      const at = field.indexOf('=');
      return at === -1
        ? { key: field, value: '' }
        : { key: field.slice(0, at), value: field.slice(at + 1) };
    }
  );
  const typedFields = flagValues(args, ['-F', '--field']);
  const opaque =
    flagValues(args, ['--input']).length > 0 ||
    typedFields.some((field) => field.includes('=@'));
  const [method] = flagValues(args, ['-X', '--method']);
  const valuesOf = (key: (name: string) => boolean) =>
    fields.filter((field) => key(field.key)).map((field) => field.value);
  return {
    path: endpoint.split('?')[0]!.replace(/^\//, ''),
    method:
      method?.toUpperCase() ?? (fields.length > 0 || opaque ? 'POST' : 'GET'),
    labels: valuesOf((name) => name.startsWith('labels')),
    graphql: valuesOf((name) => name === 'query').join('\n'),
    opaque,
  };
};

/** The REST path of a GitHub API URL (github.com or GitHub Enterprise), or undefined for other hosts. */
const githubApiPath = (url: string): string | undefined => {
  const match =
    /^https?:\/\/(?:api\.github\.com\/|[^/]+\/api\/v3\/|[^/]+\/api\/(?=graphql))([^?#]*)/i.exec(
      url
    );
  return match?.[1]?.replace(/\/$/, '');
};

/** curl options that send a request body. */
const CURL_DATA_OPTIONS = [
  '-d',
  '--data',
  '--data-ascii',
  '--data-binary',
  '--data-raw',
  '--data-urlencode',
  '--json',
  '-F',
  '--form',
];

/** Label names in a JSON request body: `{"labels": [...]}` or a bare array. */
const labelsInBody = (body: unknown): string[] => {
  const labels = Array.isArray(body)
    ? body
    : (body as { labels?: unknown } | null)?.labels;
  if (typeof labels === 'string') return [labels];
  if (!Array.isArray(labels)) return [];
  return labels.map((label: unknown) =>
    typeof label === 'string'
      ? label
      : String((label as { name?: unknown } | null)?.name ?? '')
  );
};

/** The GitHub API requests a curl command makes; none if it calls another host. */
const parseCurl = (args: string[]): ApiRequest[] => {
  const urls = [
    ...args.filter((arg) => /^https?:\/\//i.test(arg)),
    ...flagValues(args, ['--url']),
  ];
  const data = flagValues(args, CURL_DATA_OPTIONS);
  const [method] = flagValues(args, ['-X', '--request']);
  // curl reads `@file` bodies from disk, and joins several -d values with `&`.
  let body: unknown;
  let opaque = data.some((value) => value.startsWith('@'));
  if (data.length > 0 && !opaque) {
    try {
      body = JSON.parse(data.join('&'));
    } catch {
      opaque = true;
    }
  }
  const query = (body as { query?: unknown } | null)?.query;
  return urls.flatMap((url) => {
    const path = githubApiPath(url);
    if (path === undefined) return [];
    return [
      {
        path,
        method: method?.toUpperCase() ?? (data.length > 0 ? 'POST' : 'GET'),
        labels: labelsInBody(body),
        graphql: typeof query === 'string' ? query : '',
        opaque,
      },
    ];
  });
};

/** Endpoints that create an issue or set an issue's labels. */
const ISSUE_LABELS_PATH = /(^|\/)issues(\/[^/]+(\/labels)?)?$/;

const checkLabelWrite = (request: ApiRequest): Verdict => {
  if (request.method === 'GET') return allow;
  if (request.path === 'graphql') {
    if (
      request.opaque ||
      /addLabelsToLabelable|labelIds/.test(request.graphql)
    ) {
      return UNREADABLE_LABELS;
    }
    return allow;
  }
  if (!ISSUE_LABELS_PATH.test(request.path)) return allow;
  if (request.opaque) return UNREADABLE_LABELS;
  return request.labels.some(namesReadyForAgent) ? UPGRADE : allow;
};

const FAKE_STATUS = block(
  "polesar: blocked: only polesar's gate may post commit statuses or check runs, so an agent can't report its own work green. " +
    "Run the checks ('polesar verify') and tell the user the results instead."
);

/** Endpoints that create or update a commit status or check run. */
const STATUS_PATH =
  /(^|\/)(statuses\/[^/]+|check-runs(\/[^/]+)?|check-suites)$/;

const checkStatusWrite = (request: ApiRequest): Verdict => {
  if (request.method === 'GET') return allow;
  if (request.path === 'graphql') {
    return /(create|update)Check(Run|Suite)/.test(request.graphql)
      ? FAKE_STATUS
      : allow;
  }
  return STATUS_PATH.test(request.path) ? FAKE_STATUS : allow;
};

const checkApiRequest = (request: ApiRequest): Verdict => {
  const verdict = checkStatusWrite(request);
  return verdict.blocked ? verdict : checkLabelWrite(request);
};

const checkGh = (args: string[]): Verdict => {
  const [noun, verb] = ghPositionals(args);
  if (noun === 'api') {
    return checkApiRequest(parseGhApi(args.slice(args.indexOf('api') + 1)));
  }
  const editsLabels =
    (noun === 'issue' || noun === 'pr') &&
    (verb === 'edit' || verb === 'create');
  if (
    editsLabels &&
    flagValues(args, ['--add-label', '--label', '-l']).some(namesReadyForAgent)
  ) {
    return UPGRADE;
  }
  return allow;
};

const checkCurl = (args: string[]): Verdict => {
  for (const request of parseCurl(args)) {
    const verdict = checkApiRequest(request);
    if (verdict.blocked) return verdict;
  }
  return allow;
};

const ACCEPT = block(
  'polesar: blocked: only the user may accept decision-journal entries, so the journal holds only decisions they made. ' +
    "Leave the proposal pending and ask the user to run 'polesar decide accept' themselves."
);

/** The polesar bin, or its entry point run through node. */
const POLESAR = /(^|\/)(polesar|cli\.[cm]?[jt]s)$/;

/**
 * Whether an argv runs `polesar decide accept`. polesar may be launched
 * through node, pnpm, npx and the like, so this looks for polesar anywhere
 * before `decide`.
 */
const acceptsDecision = (argv: string[]) =>
  argv.some(
    (arg, i) =>
      arg === 'decide' &&
      argv.slice(0, i).some((before) => POLESAR.test(before)) &&
      argv.slice(i + 1).find((next) => !next.startsWith('-')) === 'accept'
  );

const checkCommand = ({ argv, env }: Command): Verdict => {
  const [program, ...args] = argv;
  if (acceptsDecision(argv)) return ACCEPT;
  if (program === 'git') return checkGit(args, env);
  if (program === 'gh') return checkGh(args);
  if (program === 'curl') return checkCurl(args);
  return allow;
};

/** An MCP tool that only reads, judging by its name (`list_issues`, `issue_read`). */
const READ_TOOL = /(^|_)(get|list|search|read)(_|$)/i;

/** An MCP tool that posts a commit status or check run. */
const STATUS_TOOL = /commit_?status|create_?status|check_?(run|suite)/i;

/** Label names under any `label` or `labels` key in an MCP tool's input. */
const labelsIn = (input: unknown): string[] => {
  if (Array.isArray(input)) return input.flatMap(labelsIn);
  if (typeof input !== 'object' || input === null) return [];
  return Object.entries(input).flatMap(([key, value]) =>
    /^labels?$/i.test(key)
      ? [value]
          .flat()
          .filter((label): label is string => typeof label === 'string')
      : labelsIn(value)
  );
};

/**
 * Checks an MCP tool call (`mcp__<server>__<tool>`) against the trust
 * boundary. MCP tools don't share a schema, so this goes by the tool's name
 * and any label fields in its input.
 */
export const checkMcpTool = (toolName: string, input: unknown): Verdict => {
  const tool = toolName.slice(toolName.lastIndexOf('__') + 2);
  if (READ_TOOL.test(tool)) return allow;
  if (STATUS_TOOL.test(tool)) return FAKE_STATUS;
  return labelsIn(input).some(namesReadyForAgent) ? UPGRADE : allow;
};

/** Checks a Bash tool call's command against the trust boundary. */
export const checkBash = (script: string): Verdict => {
  for (const command of commandsIn(script)) {
    const verdict = checkCommand(command);
    if (verdict.blocked) return verdict;
  }
  return allow;
};
