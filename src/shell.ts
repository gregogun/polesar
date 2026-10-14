/**
 * Just enough shell lexing to see which commands a Bash tool call runs.
 * It isn't a shell: it errs towards finding commands, so a guard built on it
 * sees through quoting, chaining, substitutions and `sh -c`, but not through
 * variables or scripts written to disk.
 */

/** Substitutions nested deeper than this aren't analysed; the caller should fail closed. */
const MAX_DEPTH = 16;

export class UnanalysableCommandError extends Error {
  override name = 'UnanalysableCommandError';
}

const SEPARATORS = new Set([';', '&', '|', '(', ')', '\n']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);
/** Commands that run their arguments as another command. */
const WRAPPERS = new Set(['sudo', 'env', 'command', 'exec', 'nohup', 'time']);

const ASSIGNMENT = /^[A-Za-z_]\w*=/;

const basename = (word: string) => word.slice(word.lastIndexOf('/') + 1);

/** Reads `$( ... )` starting just after the `(`; returns the body and the index after `)`. */
const readSubstitution = (source: string, start: number) => {
  let depth = 1;
  for (let i = start; i < source.length; i++) {
    if (source[i] === '(') depth++;
    if (source[i] === ')' && --depth === 0) {
      return { body: source.slice(start, i), end: i + 1 };
    }
  }
  return { body: source.slice(start), end: source.length };
};

/** Reads a backtick substitution starting just after the opening backtick. */
const readBackticks = (source: string, start: number) => {
  const close = source.indexOf('`', start);
  const end = close === -1 ? source.length : close;
  return { body: source.slice(start, end), end: end + 1 };
};

type Lexed = { commands: string[][]; substitutions: string[] };

/** Splits a script into simple commands (argv lists), collecting `$(...)` and backtick bodies. */
const lex = (source: string): Lexed => {
  const commands: string[][] = [];
  const substitutions: string[] = [];
  let argv: string[] = [];
  let word: string | undefined;
  /** Heredoc delimiters whose bodies start at the next newline. */
  const heredocs: { delimiter: string; stripTabs: boolean }[] = [];

  const endWord = () => {
    if (word !== undefined) argv.push(word);
    word = undefined;
  };
  const endCommand = () => {
    endWord();
    if (argv.length > 0) commands.push(argv);
    argv = [];
  };
  const append = (text: string) => {
    word = (word ?? '') + text;
  };
  const skipHeredocBodies = (from: number): number => {
    let i = from;
    for (const { delimiter, stripTabs } of heredocs.splice(0)) {
      while (i < source.length) {
        const newline = source.indexOf('\n', i);
        const lineEnd = newline === -1 ? source.length : newline;
        let line = source.slice(i, lineEnd);
        if (stripTabs) line = line.replace(/^\t+/, '');
        i = lineEnd + 1;
        if (line === delimiter) break;
      }
    }
    return i;
  };

  let i = 0;
  while (i < source.length) {
    const char = source[i]!;
    if (char === '\\') {
      // A backslash-newline continues the line; any other escaped char is literal.
      if (source[i + 1] !== '\n') append(source[i + 1] ?? '');
      i += 2;
    } else if (char === "'") {
      const close = source.indexOf("'", i + 1);
      const end = close === -1 ? source.length : close;
      append(source.slice(i + 1, end));
      i = end + 1;
    } else if (char === '"') {
      append('');
      i++;
      while (i < source.length && source[i] !== '"') {
        if (source[i] === '\\' && '"\\$`'.includes(source[i + 1] ?? '')) {
          append(source[i + 1]!);
          i += 2;
        } else if (source.startsWith('$(', i)) {
          const { body, end } = readSubstitution(source, i + 2);
          substitutions.push(body);
          append(source.slice(i, end));
          i = end;
        } else if (source[i] === '`') {
          const { body, end } = readBackticks(source, i + 1);
          substitutions.push(body);
          append(source.slice(i, end));
          i = end;
        } else {
          append(source[i]!);
          i++;
        }
      }
      i++;
    } else if (source.startsWith('$(', i)) {
      const { body, end } = readSubstitution(source, i + 2);
      substitutions.push(body);
      append(source.slice(i, end));
      i = end;
    } else if (char === '`') {
      const { body, end } = readBackticks(source, i + 1);
      substitutions.push(body);
      append(source.slice(i, end));
      i = end;
    } else if (source.startsWith('<<', i) && !source.startsWith('<<<', i)) {
      endWord();
      i += 2;
      const stripTabs = source[i] === '-';
      if (stripTabs) i++;
      while (source[i] === ' ' || source[i] === '\t') i++;
      const match = /^(['"]?)([^\s'";&|<>()]+)\1/.exec(source.slice(i));
      if (match) {
        heredocs.push({ delimiter: match[2]!, stripTabs });
        i += match[0].length;
      }
    } else if (char === '#' && word === undefined) {
      const newline = source.indexOf('\n', i);
      i = newline === -1 ? source.length : newline;
    } else if (char === '\n') {
      endCommand();
      i = skipHeredocBodies(i + 1);
    } else if (SEPARATORS.has(char)) {
      endCommand();
      i++;
    } else if (char === ' ' || char === '\t') {
      endWord();
      i++;
    } else {
      append(char);
      i++;
    }
  }
  endCommand();
  return { commands, substitutions };
};

/**
 * The command(s) an argv runs once leading `VAR=value` assignments and
 * wrappers like `sudo` and `env` are dropped. A wrapper's option values
 * (`sudo -u root ...`) can't be told from the command, so every suffix
 * after the wrapper is a candidate: extra candidates only over-report.
 */
const unwrap = (argv: string[]): string[][] => {
  const start = argv.findIndex((arg) => !ASSIGNMENT.test(arg));
  if (start === -1) return [];
  const [first, ...tail] = argv.slice(start);
  const program = basename(first!);
  if (!WRAPPERS.has(program)) return [[program, ...tail]];
  return tail.flatMap((arg, index) =>
    arg.startsWith('-') ? [] : unwrap(tail.slice(index))
  );
};

/** The script an `sh -c '...'` or `eval ...` command runs, if it is one. */
const innerScript = ([name, ...args]: string[]): string | undefined => {
  if (name === 'eval') return args.join(' ');
  if (name === undefined || !SHELLS.has(name)) return undefined;
  const flag = args.findIndex((arg) => /^-[a-z]*c[a-z]*$/.test(arg));
  return flag === -1 ? undefined : args[flag + 1];
};

/**
 * Every simple command a Bash tool call would run, as argv lists with
 * assignments and wrappers dropped and the program reduced to its basename.
 * Throws `UnanalysableCommandError` for absurdly nested scripts.
 */
export const commandsIn = (script: string, depth = 0): string[][] => {
  if (depth > MAX_DEPTH) {
    throw new UnanalysableCommandError(
      `command substitutions or nested shells deeper than ${MAX_DEPTH} levels`
    );
  }
  const { commands, substitutions } = lex(script);
  const found: string[][] = [];
  for (const command of commands.flatMap(unwrap)) {
    found.push(command);
    const inner = innerScript(command);
    if (inner !== undefined) found.push(...commandsIn(inner, depth + 1));
  }
  for (const body of substitutions) found.push(...commandsIn(body, depth + 1));
  return found;
};
