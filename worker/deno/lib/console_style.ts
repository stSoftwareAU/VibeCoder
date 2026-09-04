/**
 * The one place setup speaks in glyphs and colour (Issue #870, part of #863).
 *
 * `setup.sh` has printed `ℹ`/`✓`/`⚠`/`✗` in blue/green/yellow/red since it was
 * written, and `setup_cli.ts` grew its own copy of the same escape constants.
 * Two copies is how the two surfaces drift, and the conversation delegated to
 * `update_mode_setup.ts` never had either — it printed plain text beside styled
 * output. This module holds the pairing once, so a surface can only be styled
 * the house way.
 *
 * Two rules the formatters must never break:
 *   - Colour is emitted only when the destination stream is a terminal, and
 *     never when `NO_COLOR` is set. The worker exports `NO_COLOR=true` into
 *     every child process (`run_worker.ts`), and a stray escape would corrupt
 *     the many tests that assert on captured child-process stdout.
 *   - The formatters return strings and print nothing. Printing stays at the
 *     call site, so styling is testable without capturing stdout.
 */

/** A severity the setup surfaces speak in. */
export type ConsoleSeverity =
  | "info"
  | "success"
  | "warning"
  | "error"
  | "question";

/** Ends a colour run — `NC` in `setup.sh`. */
const RESET = "\x1b[0m";

/** Glyph and colour per severity, matching `setup.sh`. */
const SEVERITY_STYLES: Readonly<
  Record<ConsoleSeverity, { glyph: string; colour: string }>
> = {
  info: { glyph: "ℹ", colour: "\x1b[0;34m" },
  success: { glyph: "✓", colour: "\x1b[0;32m" },
  warning: { glyph: "⚠", colour: "\x1b[1;33m" },
  error: { glyph: "✗", colour: "\x1b[0;31m" },
  question: { glyph: "?", colour: "\x1b[1;33m" },
};

/** The gap between the glyph and the message, as `setup.sh` prints it. */
const GLYPH_GAP = "  ";

/** What a continuation line is indented by, to sit under the message above. */
export const CONTINUATION_INDENT = " ".repeat(1 + GLYPH_GAP.length);

/** What decides whether colour is emitted. */
export interface ConsoleStyleOptions {
  /** Is the destination stream a terminal? */
  tty: boolean;
  /** The value of `NO_COLOR`; unset, `null` or empty means "not set". */
  noColor?: string | null;
}

/** Formatters for one destination stream. */
export interface ConsoleStyler {
  /** True when this styler emits colour escapes. */
  readonly coloured: boolean;
  /** `ℹ` — an explanatory line. */
  info(message: string): string;
  /** `✓` — a confirmed answer or a completed step. */
  success(message: string): string;
  /** `⚠` — a rejected answer, a failed step, or a fallback taken. */
  warning(message: string): string;
  /** `✗` — a fault that stops the caller. */
  error(message: string): string;
  /** `?` — a question awaiting an answer. */
  question(message: string): string;
  /** No glyph: a continuation line aligned under the message above. */
  plain(message: string): string;
}

/**
 * Is colour allowed on this stream?
 *
 * `NO_COLOR` wins over a terminal, per no-color.org: any non-empty value
 * disables colour, an empty one is the same as not setting it at all.
 */
export function colourEnabled(options: ConsoleStyleOptions): boolean {
  if (!options.tty) return false;
  const noColor = options.noColor;
  return noColor === undefined || noColor === null || noColor === "";
}

/**
 * Build the formatters for a destination described by `options`.
 *
 * @param options - Whether the stream is a terminal, and what `NO_COLOR` says
 * @returns Formatters that return styled strings and print nothing
 */
export function createConsoleStyler(
  options: ConsoleStyleOptions,
): ConsoleStyler {
  const coloured = colourEnabled(options);

  const format = (severity: ConsoleSeverity, message: string): string => {
    const { glyph, colour } = SEVERITY_STYLES[severity];
    const marker = coloured ? `${colour}${glyph}${RESET}` : glyph;
    return `${marker}${GLYPH_GAP}${message}`;
  };

  return {
    coloured,
    info: (message) => format("info", message),
    success: (message) => format("success", message),
    warning: (message) => format("warning", message),
    error: (message) => format("error", message),
    question: (message) => format("question", message),
    plain: (message) => `${CONTINUATION_INDENT}${message}`,
  };
}

/** The stream shape {@link terminalStyler} needs — `Deno.stdout` satisfies it. */
export interface TerminalStream {
  isTerminal(): boolean;
}

/**
 * The styler for a real process stream, reading `NO_COLOR` from the
 * environment.
 *
 * @param stream - The destination stream; defaults to `Deno.stdout`
 * @returns Formatters that colour only an uncoloured-by-`NO_COLOR` terminal
 */
export function terminalStyler(
  stream: TerminalStream = Deno.stdout,
): ConsoleStyler {
  return createConsoleStyler({
    tty: stream.isTerminal(),
    noColor: Deno.env.get("NO_COLOR") ?? null,
  });
}

/**
 * A question with its default in brackets — the one place the suffix is built.
 *
 * A question with no default renders bare rather than trailing a stray `[]`,
 * which is why every prompt goes through here instead of interpolating its own
 * brackets.
 *
 * @param question - The question text, without any bracket suffix
 * @param value - The default offered, if there is one
 * @returns `"<question> [<value>]"`, or just the question when there is none
 */
export function bracketedDefault(
  question: string,
  value: string | undefined,
): string {
  const trimmed = value?.trim() ?? "";
  return trimmed === "" ? question : `${question} [${trimmed}]`;
}
