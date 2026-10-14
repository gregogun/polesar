import path from 'node:path';

/** A `runCli` files entry: a polesar.json in `dir` configuring these verify checks. */
export const polesarConfig = (checks: Record<string, string>, dir = '') => ({
  [path.join(dir, 'polesar.json')]: JSON.stringify({ verify: { checks } }),
});
