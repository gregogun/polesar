import { spawn } from 'node:child_process';
import { recordReading } from './usage.ts';

/**
 * Runs as Claude Code's status line: saves the usage reading in `payload`,
 * then runs your own status line `command` (if any) on the same payload, its
 * output and exit code passed through untouched. Saving never gets in the way
 * of showing the status line. Resolves to the exit code.
 */
export const statusLine = async (
  payload: string,
  command: string | undefined,
  { home, now }: { home: string; now: number }
): Promise<number> => {
  const saved = recordReading(home, payload, now).catch(() => undefined);
  if (command === undefined) {
    await saved;
    return 0;
  }
  const shown = new Promise<number>((resolve) => {
    const child = spawn('/bin/sh', ['-c', command], {
      stdio: ['pipe', 'inherit', 'inherit'],
    });
    child.on('error', () => resolve(127));
    child.on('close', (code) => resolve(code ?? 1));
    // A command that exits without reading its input mustn't fail the status line.
    child.stdin.on('error', () => undefined);
    child.stdin.end(payload);
  });
  const [code] = await Promise.all([shown, saved]);
  return code;
};
