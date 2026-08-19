/**
 * Detector for the `tail -f … | head -N` foot-gun (Issue #1681).
 *
 * Background: when an agent processes streamed output with
 * `tail -f file | head -50`, the pipeline is fine *while the writer is alive*
 * — `head` slurps 50 lines and exits, the next write hits SIGPIPE, the
 * pipeline closes. But if the writer dies before `tail` writes again
 * (e.g. `deno test` crashes leaving the file static):
 *
 *   - `head` has already exited.
 *   - `tail -f` is waiting for new bytes that will never arrive.
 *   - No write means no SIGPIPE, so `tail -f` stays alive forever.
 *   - The pipeline parent (zsh) waits forever on `tail -f`.
 *   - Claude's Bash tool waits forever on zsh.
 *   - The worker waits forever on Claude.
 *
 * Observed in production: a single task wedged host-25 for 17h 45m past its
 * 4h timeout. PR #1680 now kills the tree on the outer Claude timeout, but
 * the underlying agent behaviour is still wrong — this detector lets us
 * regression-test the agent-side guidance and serve as a sanity check
 * against shell commands that are about to be executed.
 *
 * The detector flags any `tail` invocation with a follow flag (`-f`, `-F`,
 * `--follow`, or short-flag clusters containing `f`/`F`) that is not
 * bounded by a `timeout`/`gtimeout` guard in the same pipeline.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

/** Result of analysing a shell command for the foot-gun. */
export interface TailAntiPatternMatch {
  /** True when the command contains an unbounded `tail -f` pipeline. */
  readonly isAntiPattern: boolean;
  /** Human-readable reason — populated only when `isAntiPattern` is true. */
  readonly reason?: string;
  /** Suggested safe rewrite — populated only when `isAntiPattern` is true. */
  readonly suggestion?: string;
}

/** Tokens that split a shell command into independently-executed segments. */
const SEGMENT_SPLIT_RE = /(\|\||&&|;|\|)/;

/** Tokenise a shell segment on whitespace, preserving order. */
function tokenise(segment: string): readonly string[] {
  return segment.match(/\S+/g) ?? [];
}

/**
 * Walk a token stream and return true when a `tail` invocation in the
 * stream has a follow flag (`-f`, `-F`, `--follow`, or short-flag cluster
 * containing `f`/`F`).
 *
 * Examples that match:
 *   tail -f file
 *   tail -F file
 *   tail --follow file
 *   tail --follow=name file
 *   tail -fn 50 file
 *   tail -nf 50 file
 *   $TIMEOUT_CMD 30 tail -f file   (the function only reports presence;
 *                                    the caller decides whether the timeout
 *                                    guard is in scope)
 */
function tailHasFollowFlag(tokens: readonly string[]): boolean {
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] !== "tail") continue;
    for (let j = i + 1; j < tokens.length; j++) {
      const tok = tokens[j]!;
      if (!tok.startsWith("-")) break; // hit a file/positional argument
      if (tok === "--") break; // end-of-options
      if (tok === "--follow" || tok.startsWith("--follow=")) return true;
      if (tok.startsWith("--")) continue; // some other long option
      // Short-flag cluster: -f, -F, -fn, -nf, -fc 50, etc.
      if (/[fF]/.test(tok.slice(1))) return true;
    }
  }
  return false;
}

/** Tokens that bound a streaming read to a wall-clock window. */
const TIMEOUT_GUARDS: readonly string[] = [
  "timeout",
  "gtimeout",
  "$TIMEOUT_CMD",
];

/** Return true when a token list contains a recognised timeout guard. */
function hasTimeoutGuard(tokens: readonly string[]): boolean {
  for (const tok of tokens) {
    if (TIMEOUT_GUARDS.includes(tok)) return true;
  }
  return false;
}

/** Return true when a segment contains a bare `head` invocation. */
function containsHead(tokens: readonly string[]): boolean {
  return tokens.includes("head");
}

/**
 * Detect the `tail -f … | head -N` foot-gun in a shell command string.
 *
 * The detector returns `isAntiPattern: true` when the command pipes an
 * unbounded `tail -f` into another stage. An unbounded `tail -f` without
 * a downstream `head` is also flagged because, when the writer dies, the
 * shell will still wait forever on `tail`.
 *
 * A `timeout` (or `gtimeout` / `$TIMEOUT_CMD`) prefix in the same segment
 * suppresses the warning — that is the documented safe pattern.
 *
 * @param command The raw shell command line as it would be passed to `bash -c`.
 * @returns Match descriptor.
 */
export function detectTailFAntiPattern(command: string): TailAntiPatternMatch {
  if (!command || command.trim().length === 0) {
    return { isAntiPattern: false };
  }

  // Quick filter: if there is no `tail` token at all, nothing to do.
  if (!/\btail\b/.test(command)) {
    return { isAntiPattern: false };
  }

  // Split on pipeline / list separators while preserving the operator so
  // the indexing matches when we look for downstream `head`.
  const parts = command.split(SEGMENT_SPLIT_RE);
  // Even indices are segments; odd indices are the separators.
  const segments: string[] = [];
  const separators: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 0) {
      segments.push(parts[i]!);
    } else {
      separators.push(parts[i]!);
    }
  }

  for (let i = 0; i < segments.length; i++) {
    const tokens = tokenise(segments[i]!);
    if (!tailHasFollowFlag(tokens)) continue;
    if (hasTimeoutGuard(tokens)) continue;

    // Find the next segment connected by a pipe `|` (not `||`, `&&`, `;`).
    // Only `|` propagates SIGPIPE / data-flow semantics — the others are
    // unrelated commands.
    let pipedHead = false;
    for (let j = i; j < separators.length; j++) {
      if (separators[j] !== "|") break;
      if (containsHead(tokenise(segments[j + 1] ?? ""))) {
        pipedHead = true;
        break;
      }
    }

    if (pipedHead) {
      return {
        isAntiPattern: true,
        reason:
          "`tail -f … | head -N` hangs forever when the writer dies: head exits, " +
          "tail never sees SIGPIPE, the pipeline parent waits forever.",
        suggestion: "Use `tail -n N <file>` for a finished file, or " +
          "`$TIMEOUT_CMD 30 tail -f <file> | head -N` to bound the wait.",
      };
    }

    return {
      isAntiPattern: true,
      reason:
        "Unbounded `tail -f` may wait forever if the writer dies — the shell " +
        "command will not return, wedging the worker.",
      suggestion:
        "Use `tail -n N <file>` for a finished file, or wrap the follow with " +
        "`$TIMEOUT_CMD 30 tail -f <file>` to bound the wait.",
    };
  }

  return { isAntiPattern: false };
}
