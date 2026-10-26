/**
 * Ask one setup question on the console (Issues #2701, #4119).
 *
 * `setup.ps1` runs the setup CLI with stdout piped through `Out-Host`, which
 * prints a line only once it ends. A question left waiting on its own line
 * would therefore not appear until after the operator had answered it. When
 * stdout is not a terminal the question is printed as a whole line first and
 * then a bare `>` prompt; on a terminal it is asked in place.
 *
 * Uses Australian English throughout (behaviour, etc.).
 */

/** The console calls `askOnConsole` makes; tests supply all of them. */
export interface ConsoleAskIo {
  /** Whether stdout is a terminal rather than a pipe. */
  stdoutIsTerminal: () => boolean;
  /** Print `message` and read one line, `null` at EOF. */
  prompt: (message: string) => string | null;
  /** Print one whole line. */
  log: (message: string) => void;
}

/** The real console. */
export const CONSOLE_ASK_IO: ConsoleAskIo = {
  stdoutIsTerminal: () => Deno.stdout.isTerminal(),
  prompt: (message) => prompt(message),
  log: (message) => console.log(message),
};

/**
 * Ask `question` and read the answer, `null` at EOF.
 *
 * @param question - The question, ending with its default in brackets
 * @param io - The console to ask on
 */
export function askOnConsole(
  question: string,
  io: ConsoleAskIo = CONSOLE_ASK_IO,
): Promise<string | null> {
  if (io.stdoutIsTerminal()) return Promise.resolve(io.prompt(question));
  io.log(question);
  return Promise.resolve(io.prompt(">"));
}
