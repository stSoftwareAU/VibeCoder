/**
 * Capture what a call writes to `console.warn` (Issue #1032).
 *
 * The deprecation notices `config_precedence.ts` emits are observable only
 * through the console, and three suites now assert on them. One helper rather
 * than one copy per suite: `console.warn` is process-global, so how it is
 * swapped and restored is exactly the kind of detail that must not be written
 * three ways.
 *
 * Deno runs test *files* in parallel and the tests inside one file serially,
 * so the swap is confined to the file that made it.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

/**
 * Run `fn` with `console.warn` captured.
 *
 * @param fn - The call under test; runs synchronously.
 * @returns One entry per `console.warn` call, arguments joined by a space.
 */
export function capturingWarnings(fn: () => void): string[] {
  const lines: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    fn();
  } finally {
    console.warn = original;
  }
  return lines;
}
