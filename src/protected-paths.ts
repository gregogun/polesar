import {
  ConfigError,
  findConfig,
  isRecord,
  MissingConfigError,
  readConfig,
} from './config.ts';
import type { FileChange } from './executor.ts';

/**
 * Paths an agent could weaken a check through (ADR 0005): existing tests,
 * verify, lint, format and typecheck config, hook config and CI workflows.
 * Globs over repo-relative paths: `*` and `?` stay within a path segment,
 * `**` spans segments.
 */
const DEFAULT_PROTECTED_PATHS = [
  // Tests
  '**/*.test.*',
  '**/*.spec.*',
  '**/test/**',
  '**/tests/**',
  '**/__tests__/**',
  '**/vitest.config.*',
  '**/vitest.workspace.*',
  '**/jest.config.*',
  // Verify, lint, format and typecheck config
  '**/polesar.json',
  '**/eslint.config.*',
  '**/.eslintrc*',
  '**/.oxlintrc*',
  '**/biome.json*',
  '**/.prettierrc*',
  '**/prettier.config.*',
  '**/.prettierignore',
  '**/knip.json',
  '**/knip.config.*',
  '**/tsconfig*.json',
  // Hook config
  '**/lefthook.y*ml',
  '**/.lefthook.y*ml',
  '**/lefthook-local.y*ml',
  '.husky/**',
  '.pre-commit-config.yaml',
  '.claude/settings*.json',
  '.gitleaks.toml',
  // CI workflows and the actions they run
  '.github/workflows/**',
  '.github/actions/**',
];

const OVERRIDE_EXAMPLE = `"protectedPaths": { "add": ["src/policy/**"], "remove": ["**/tsconfig*.json"] }`;

const patternsAt = (
  file: string,
  override: Record<string, unknown>,
  key: 'add' | 'remove'
): string[] => {
  const patterns = override[key] ?? [];
  if (
    !Array.isArray(patterns) ||
    !patterns.every((pattern) => typeof pattern === 'string')
  ) {
    throw new ConfigError(
      `${file}: "protectedPaths.${key}" must be a list of glob strings, e.g.:\n${OVERRIDE_EXAMPLE}`
    );
  }
  // Changed paths are repo-relative, so these would quietly protect nothing.
  const unmatchable = patterns.find(
    (pattern) =>
      pattern === '' || pattern.startsWith('/') || pattern.startsWith('./')
  );
  if (unmatchable !== undefined) {
    throw new ConfigError(
      `${file}: "${unmatchable}" can never match: patterns are relative to the repo root, e.g. "src/policy/**"`
    );
  }
  return patterns;
};

/**
 * The repo's protected paths: the defaults, adjusted by `protectedPaths.add`
 * and `protectedPaths.remove` in the nearest polesar.json from `cwd`. Without
 * a polesar.json, or without that key, the defaults stand.
 */
export const loadProtectedPaths = async (cwd: string): Promise<string[]> => {
  let file: string;
  try {
    file = await findConfig(cwd);
  } catch (error) {
    if (error instanceof MissingConfigError) return DEFAULT_PROTECTED_PATHS;
    throw error;
  }
  const config = await readConfig(file);
  const override = isRecord(config) ? config.protectedPaths : undefined;
  if (override === undefined) return DEFAULT_PROTECTED_PATHS;
  if (
    !isRecord(override) ||
    Object.keys(override).some((key) => key !== 'add' && key !== 'remove')
  ) {
    throw new ConfigError(
      `${file}: "protectedPaths" takes only "add" and "remove" lists of globs, e.g.:\n${OVERRIDE_EXAMPLE}`
    );
  }
  const remove = patternsAt(file, override, 'remove');
  // A typo here would quietly keep the path protected while you think it's free; say so instead.
  const unknown = remove.find(
    (pattern) => !DEFAULT_PROTECTED_PATHS.includes(pattern)
  );
  if (unknown !== undefined) {
    throw new ConfigError(
      `${file}: "${unknown}" is not a default protected path, so "protectedPaths.remove" can't remove it. The defaults are:\n${DEFAULT_PROTECTED_PATHS.join('\n')}`
    );
  }
  return [
    ...DEFAULT_PROTECTED_PATHS.filter((pattern) => !remove.includes(pattern)),
    ...patternsAt(file, override, 'add'),
  ];
};

const globToRegExp = (glob: string) => {
  let source = '';
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i] ?? '';
    if (glob.startsWith('**/', i)) {
      source += '(?:.*/)?';
      i += 2;
    } else if (glob.startsWith('**', i)) {
      source += '.*';
      i += 1;
    } else if (char === '*') {
      source += '[^/]*';
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${source}$`);
};

/** A protected file the branch modifies or deletes, with the first pattern it matches. */
export type ProtectedChange = FileChange & { pattern: string };

/**
 * The changes that touch an existing protected file. Adding a file never
 * counts: new tests are welcome, and nothing existing is weakened.
 */
export const protectedChanges = (
  changes: FileChange[],
  patterns: string[]
): ProtectedChange[] => {
  const matchers = patterns.map((pattern) => ({
    pattern,
    regExp: globToRegExp(pattern),
  }));
  return changes.flatMap((change) => {
    if (change.change === 'added') return [];
    const match = matchers.find(({ regExp }) => regExp.test(change.path));
    return match ? [{ ...change, pattern: match.pattern }] : [];
  });
};
