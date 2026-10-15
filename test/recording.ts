import { appendFileSync } from 'node:fs';

/** One call a port received, as `runLoop` reads it back. */
export type RecordedCall = { port: string; method: string; args: unknown[] };

/**
 * Wraps a fake port so every method call is appended to `log` as a JSON line,
 * letting tests observe the CLI's effects on its ports from outside the process.
 * Without a log the port is returned as is.
 */
export const recording = <T extends object>(
  port: string,
  target: T,
  log: string | undefined
): T => {
  if (log === undefined) return target;
  return new Proxy(target, {
    get(object, key) {
      const value: unknown = Reflect.get(object, key, object);
      if (typeof value !== 'function' || typeof key !== 'string') return value;
      return (...args: unknown[]): unknown => {
        const call: RecordedCall = { port, method: key, args };
        appendFileSync(log, `${JSON.stringify(call)}\n`);
        return (value as (...args: unknown[]) => unknown).apply(object, args);
      };
    },
  });
};
