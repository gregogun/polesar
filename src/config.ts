/** Reading the repo's polesar.json, shared by every command configured there. */
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';

const CONFIG_FILE = 'polesar.json';

export const CONFIG_EXAMPLE = `{
  "verify": {
    "checks": {
      "typecheck": "pnpm tsc --noEmit",
      "lint": "pnpm eslint ."
    }
  }
}`;

/** The repo's polesar config is missing or malformed; the message says how to fix it. */
export class ConfigError extends Error {
  override name = 'ConfigError';
}

/** The repo has no polesar config at all. */
export class MissingConfigError extends ConfigError {
  override name = 'MissingConfigError';
}

export const exists = (file: string) =>
  access(file).then(
    () => true,
    () => false
  );

/** The nearest polesar.json from `cwd` up to its git root (or the filesystem root outside git). */
export const findConfig = async (cwd: string): Promise<string> => {
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    const file = path.join(dir, CONFIG_FILE);
    if (await exists(file)) return file;
    if ((await exists(path.join(dir, '.git'))) || path.dirname(dir) === dir) {
      throw new MissingConfigError(
        `no ${CONFIG_FILE} in ${cwd} or its parents up to ${dir}. Create one at the repo root listing the cheap checks to run, e.g.:\n${CONFIG_EXAMPLE}`
      );
    }
  }
};

export const readConfig = async (file: string): Promise<unknown> => {
  const text = await readFile(file, 'utf8');
  try {
    return JSON.parse(text);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new ConfigError(`${file} is not valid JSON: ${reason}`);
  }
};

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
