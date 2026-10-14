import {
  ConfigError,
  MissingConfigError,
  summarise,
  verify,
} from './verify.ts';

/** What a Claude Code hook command writes and exits with. */
type HookResponse = { exitCode: number; stdout: string; stderr: string };

const allow: HookResponse = { exitCode: 0, stdout: '', stderr: '' };

/** Exit 1 is a non-blocking hook error: shown to the user, the agent isn't sent back. */
const hookError = (message: string): HookResponse => ({
  exitCode: 1,
  stdout: '',
  stderr: `polesar: ${message}\n`,
});

const readCwd = (payload: string): string | undefined => {
  try {
    const { cwd } = JSON.parse(payload) as { cwd?: unknown };
    return typeof cwd === 'string' ? cwd : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Claude Code Stop hook: an agent claiming it's done is sent back with the
 * failure summary while the cheap checks are red.
 */
export const stopHook = async (payload: string): Promise<HookResponse> => {
  const cwd = readCwd(payload);
  if (cwd === undefined) {
    return hookError(
      'expected a Claude Code Stop hook payload on stdin: a JSON object with a "cwd" string'
    );
  }
  try {
    const checks = await verify(cwd);
    if (checks.every((check) => check.passed)) return allow;
    return {
      ...allow,
      stdout: `${JSON.stringify({ decision: 'block', reason: summarise(checks) })}\n`,
    };
  } catch (error) {
    // A repo that hasn't opted in to verify has nothing to hold the agent to.
    if (error instanceof MissingConfigError) return allow;
    if (error instanceof ConfigError) return hookError(error.message);
    throw error;
  }
};
