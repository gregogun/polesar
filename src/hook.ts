import {
  ConfigError,
  MissingConfigError,
  summarise,
  verify,
} from './verify.ts';

/** What a Claude Code hook command writes and exits with. */
type HookResponse = { exitCode: number; stdout: string; stderr: string };

type StopPayload = { cwd: string; stopHookActive: boolean };

/** Exit 0 with a JSON decision (or none, to allow) on stdout. */
const respond = (output?: object): HookResponse => ({
  exitCode: 0,
  stdout: output ? `${JSON.stringify(output)}\n` : '',
  stderr: '',
});

/** Exit 1 is a non-blocking hook error: shown to the user, the agent isn't sent back. */
const hookError = (message: string): HookResponse => ({
  exitCode: 1,
  stdout: '',
  stderr: `polesar: ${message}\n`,
});

const parsePayload = (payload: string): StopPayload | undefined => {
  try {
    const { cwd, stop_hook_active } = JSON.parse(payload) as {
      cwd?: unknown;
      stop_hook_active?: unknown;
    };
    if (typeof cwd !== 'string') return undefined;
    return { cwd, stopHookActive: stop_hook_active === true };
  } catch {
    return undefined;
  }
};

/**
 * Claude Code Stop hook: an agent claiming it's done is sent back once with
 * the failure summary while the cheap checks are red. If it tries to stop
 * again with checks still red, the stop goes through and the user is warned,
 * so a stuck agent can't burn tokens in a loop.
 */
export const stopHook = async (payload: string): Promise<HookResponse> => {
  const stop = parsePayload(payload);
  if (stop === undefined) {
    return hookError(
      'expected a Claude Code Stop hook payload on stdin: a JSON object with a "cwd" string'
    );
  }
  try {
    const result = await verify(stop.cwd);
    if (result.passed) return respond();
    const summary = summarise(result);
    return stop.stopHookActive
      ? respond({
          systemMessage: `polesar: checks still failing after the agent was sent back once; stopping anyway.\n${summary}`,
        })
      : respond({ decision: 'block', reason: summary });
  } catch (error) {
    // A repo that hasn't opted in to verify has nothing to hold the agent to.
    if (error instanceof MissingConfigError) return respond();
    if (error instanceof ConfigError) return hookError(error.message);
    throw error;
  }
};
