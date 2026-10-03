/**
 * Result-placeholder gate (Issue #3124).
 *
 * The fleet's prompt templates leave fill-in-later tokens such as
 * `QUALITY_RESULT_PLACEHOLDER` in a few scaffolded sections, on the
 * understanding the agent overwrites each one with the actual outcome before
 * the text is ever shown to a human. A run that skips that step leaves the
 * literal token sitting where a quality-gate (or other command) result
 * belongs — on a PR, that reads as "the gate was run" to anyone who does not
 * know the fleet's internal vocabulary, when in truth nothing was reported at
 * all. A left-over placeholder is therefore treated the same as an unreported
 * result: the PR-creation path blocks on it (folded into whichever
 * summary-rule gate also fails, so one recovery turn asks for everything —
 * `completion_phase.ts`), and the reply path never lets one reach a public PR
 * comment at all (`pr_branch_preparation.ts`'s `readPrResponseMessage`
 * chokepoint).
 *
 * Modelled on `docs_sweep_gate.ts`: pure functions only, a hardcoded regex (no
 * `new RegExp()` built from input), and a bounded scan of text that is
 * agent-authored and steered by an untrusted issue body, so it is treated as
 * untrusted throughout.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

/** Cap on untrusted text scanned by the gate's regex (defence in depth). */
const MAX_SCAN_CHARS = 200_000;

/** Up to how many distinct tokens are named in a comment or prompt. */
const MAX_NAMED_TOKENS = 10;

/**
 * A fill-in-later token: an all-caps identifier ending in `_PLACEHOLDER`.
 * `SECTION_PLACEHOLDER_VALUES`-style names with a trailing word character
 * after `PLACEHOLDER` correctly do not match — `\b` after `PLACEHOLDER`
 * requires a non-word boundary there.
 */
const PLACEHOLDER_TOKEN_RE = /\b[A-Z][A-Z0-9_]*_PLACEHOLDER\b/g;

/**
 * Split text into alternating "outside code" / "inside code" segments, so
 * callers can scan or rewrite only the prose a reader actually sees.
 * Fenced blocks (``` or ~~~, to the matching close or end of text) and
 * inline backtick spans are both "inside code" — a token named for
 * discussion (`` `REDACTION_PLACEHOLDER` ``) is not an unfilled result.
 */
function splitOutsideCode(
  text: string,
): Array<{ value: string; inCode: boolean }> {
  const segments: Array<{ value: string; inCode: boolean }> = [];
  const FENCE_RE = /^(`{3,}|~{3,})/;
  const lines = text.split(/(?<=\n)/); // keep line terminators attached
  let i = 0;
  let cursor = "";
  let inFence = false;
  let fenceMarker = "";

  function flushCursor(inCode: boolean) {
    if (cursor.length > 0) segments.push({ value: cursor, inCode });
    cursor = "";
  }

  while (i < lines.length) {
    const line = lines[i]!;
    const fenceMatch = line.match(FENCE_RE);
    if (fenceMatch) {
      if (!inFence) {
        flushCursor(false);
        inFence = true;
        fenceMarker = fenceMatch[1]![0]!; // '`' or '~'
        cursor += line;
      } else if (line.trimStart()[0] === fenceMarker) {
        cursor += line;
        flushCursor(true);
        inFence = false;
        fenceMarker = "";
      } else {
        cursor += line;
      }
      i++;
      continue;
    }
    if (inFence) {
      cursor += line;
      i++;
      continue;
    }
    // Outside a fence: split the line itself on inline backtick spans.
    const INLINE_CODE_RE = /`[^`\n]*`/g;
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = INLINE_CODE_RE.exec(line)) !== null) {
      cursor += line.slice(lastIndex, match.index);
      flushCursor(false);
      segments.push({ value: match[0], inCode: true });
      lastIndex = match.index + match[0].length;
    }
    cursor += line.slice(lastIndex);
    i++;
  }
  flushCursor(inFence);
  return segments;
}

/**
 * Find every distinct result-placeholder token in `text`, outside fenced
 * code blocks and inline code spans, in first-seen order, capped at
 * {@link MAX_NAMED_TOKENS}. A token mentioned only inside backticks — e.g.
 * discussing `` `REDACTION_PLACEHOLDER` `` — is deliberately not reported;
 * one left bare in prose (`QUALITY_RESULT_PLACEHOLDER`) is.
 */
export function findResultPlaceholders(text: string): string[] {
  const bounded = (text ?? "").slice(0, MAX_SCAN_CHARS);
  const found: string[] = [];
  const seen = new Set<string>();
  for (const segment of splitOutsideCode(bounded)) {
    if (segment.inCode) continue;
    for (const token of segment.value.matchAll(PLACEHOLDER_TOKEN_RE)) {
      const name = token[0];
      if (seen.has(name)) continue;
      seen.add(name);
      found.push(name);
      if (found.length >= MAX_NAMED_TOKENS) return found;
    }
  }
  return found;
}

/** Verdict of the result-placeholder gate over a piece of text. */
export interface ResultPlaceholderResult {
  /** True when no bare placeholder token was found. */
  valid: boolean;
  /** The distinct tokens found, first-seen order. */
  tokens: string[];
}

/**
 * Verify that `text` carries no left-over fill-in-later token where a
 * command's result belongs.
 */
export function validateResultPlaceholders(
  text: string,
): ResultPlaceholderResult {
  const tokens = findResultPlaceholders(text);
  return { valid: tokens.length === 0, tokens };
}

/** Replace every bare (outside-code) placeholder occurrence with `replacement`. */
export function replaceResultPlaceholders(
  text: string,
  replacement: string,
): string {
  const segments = splitOutsideCode(text ?? "");
  return segments
    .map((segment) =>
      segment.inCode
        ? segment.value
        : segment.value.replace(PLACEHOLDER_TOKEN_RE, replacement)
    )
    .join("");
}

/** Render the token list for a comment or prompt, e.g. `` `FOO_PLACEHOLDER`, `BAR_PLACEHOLDER` ``. */
function describeTokens(tokens: readonly string[]): string {
  // Every token already matched the strict `[A-Z][A-Z0-9_]*_PLACEHOLDER`
  // regex, so it is safe to echo verbatim into Markdown and a prompt.
  return tokens.map((token) => `\`${token}\``).join(", ");
}

/**
 * Build the comment posted when the result-placeholder gate blocks PR
 * creation.
 *
 * Explains that a placeholder where a result belongs counts as an unreported
 * result, and asks for the actual outcome, not a re-derivation of what the
 * command was for.
 */
export function buildResultPlaceholderGateComment(
  tokens: readonly string[],
): string {
  return [
    "⚠️ **Unfilled result placeholder.** The PR summary still carries " +
    `${tokens.length === 1 ? "a token" : "token(s)"} where a command's ` +
    `result belongs: ${describeTokens(tokens)}.`,
    "",
    "A fill-in-later token left in place of a result counts as an unreported " +
    "result, not a passing one — it reads as \"the gate was run\" to anyone " +
    "who does not know the fleet's internal vocabulary, when nothing was " +
    "actually reported.",
    "",
    "For each token above, re-run the command it stands for on the branch's " +
    "final head and replace it with the actual outcome:",
    "",
    "- Passed — say so, briefly.",
    "- Failed — say so, and give its first error.",
    "- Not run at all — say that plainly rather than leaving the token in " +
    "place.",
  ].join("\n");
}

/**
 * Build the prompt for the single reply-path recovery turn (Issue #3124).
 *
 * Tells the agent its own `.pr_response_message` still carries unresolved
 * placeholder token(s), and asks it to rewrite ONLY that file with the
 * actual outcome — or a plain statement the command was not run — making no
 * other change.
 */
export function buildReplyPlaceholderRetryPrompt(
  tokens: readonly string[],
): string {
  return `Your \`.pr_response_message\` still contains unresolved result-placeholder token(s): ${
    describeTokens(tokens)
  }.

A placeholder left where a command's result belongs reads as a claim the command passed, when in truth nothing was reported — this must not reach the public PR comment unresolved.

Do exactly this, and nothing else:

1. Rewrite ONLY \`.pr_response_message\`, replacing each token above with the actual outcome of the command it stands for: passed (briefly), or failed with its first error, or state plainly the command was not run.
2. Make no other change — do not touch any other file, do not create a PR, do not close the issue.

If you cannot determine the actual outcome, say so plainly in that file rather than leaving the token in place.`;
}

/** Minimal logger surface the reply-path recovery helper needs. */
export interface ReplyPlaceholderRetryLogger {
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

/** Injected effects for {@link retryReplyPlaceholdersOnce}, so it is unit-testable. */
export interface ReplyPlaceholderRetryDeps {
  /** Read the file's content without consuming it; `undefined` if missing. */
  readFile: (path: string) => Promise<string | undefined>;
  /** Re-invoke the agent once with the given prompt. */
  runAgent: (
    prompt: string,
  ) => Promise<{ ok: boolean; error?: Error }>;
  /** Optional logger, so a retry (or its failure) is reported loudly. */
  logger?: ReplyPlaceholderRetryLogger;
}

/** Outcome of one reply-path placeholder-recovery peek. */
export interface ReplyPlaceholderRetryOutcome {
  /** Whether the agent was re-invoked. */
  retried: boolean;
  /** The tokens that triggered the retry (empty when `retried` is false). */
  tokens: string[];
}

/**
 * Peek at the reply file for unresolved result-placeholder tokens and, if
 * any are found, re-invoke the agent ONCE to rewrite the file (Issue #3124).
 *
 * This is the one in-run recovery turn on the reply path, mirroring
 * `recoverFromSummaryRuleBlock` on the PR-creation path: a single retry, not
 * a loop. Tokens still present afterwards are left for the fail-loud
 * chokepoint backstop in `pr_branch_preparation.ts`'s `readPrResponseMessage`
 * to catch — this helper does not re-check after the retry, so a failed or
 * exhausted recovery never blocks the already-successful feedback run.
 *
 * @param path - The `.pr_response_message` path, read without consuming it.
 */
export async function retryReplyPlaceholdersOnce(
  path: string,
  deps: ReplyPlaceholderRetryDeps,
): Promise<ReplyPlaceholderRetryOutcome> {
  const content = await deps.readFile(path);
  if (content === undefined) return { retried: false, tokens: [] };

  const tokens = findResultPlaceholders(content);
  if (tokens.length === 0) return { retried: false, tokens: [] };

  deps.logger?.warn(
    "Reply carries unresolved result-placeholder token(s) — recovering once in-run (Issue #3124)",
    { tokens },
  );

  const result = await deps.runAgent(buildReplyPlaceholderRetryPrompt(tokens));
  if (!result.ok) {
    // The chokepoint backstop in `readPrResponseMessage` still applies —
    // this is logged, not fatal, because the feedback run's main work has
    // already succeeded by the time this peek runs.
    deps.logger?.error(
      `Result-placeholder reply recovery invocation failed — the ` +
        `fail-loud chokepoint backstop will apply instead: ${
          result.error?.message ?? "unknown error"
        }`,
      { tokens },
    );
  }

  return { retried: true, tokens };
}
