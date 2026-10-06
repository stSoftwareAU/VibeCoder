/**
 * Result-placeholder gate (Issue #3124, widened by Issue #3248).
 *
 * While drafting, the agent sometimes invents its own fill-in-later token —
 * an all-caps name ending in `_PLACEHOLDER`, `_PENDING`, `_TBD` or `_TODO`,
 * such as `QUALITY_RESULT_PLACEHOLDER` — where a command's result belongs,
 * and then never replaces it with the outcome. No prompt template supplies
 * that token. Left bare, it reads as "the gate was run" to anyone who does
 * not know it is a stand-in, when in truth nothing was reported at all.
 *
 * A fleet PR (GRQ#5164) escaped the suffix check entirely with
 * `GATE_OUTCOME_PENDING` on a result line:
 * `` - `./quality.sh < /dev/null` on the head: GATE_OUTCOME_PENDING ``. Since
 * Issue #3248, a second, structural rule backstops the suffix one: on a line
 * whose raw text cites a known gate command (`./quality.sh`, `deno test`,
 * `cargo test`, etc.), the text after the line's last result separator is
 * checked as a whole — a bare ALL-CAPS identifier with at least one
 * underscore there (optionally followed by a full stop) is a fill-in-later
 * token regardless of its suffix. `PASSED` and `OK` (no underscore) are not
 * flagged; a line with no cited gate command is not flagged. A result
 * separator is a `:` anywhere on the line, or — since Issue #3287, after a
 * PR (#3283) escaped the colon form with
 * `` - `./quality.sh` — GATE_RESULT `` — an em dash, en dash, spaced hyphen
 * or double hyphen, or `=`, each counted only after the cited command.
 *
 * A left-over placeholder, caught by either rule, is therefore treated the
 * same as an unreported result: the PR-creation path blocks on it (folded
 * into whichever summary-rule gate also fails, so one recovery turn asks for
 * everything — `completion_phase.ts`), and the reply path never lets one
 * reach a public PR comment at all (`pr_branch_preparation.ts`'s
 * `readPrResponseMessage` chokepoint).
 *
 * Modelled on `docs_sweep_gate.ts`: pure functions only, hardcoded regexes
 * (no `new RegExp()` built from input), and a bounded scan of text that is
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
 * A fill-in-later token: an all-caps identifier ending in `_PLACEHOLDER`,
 * `_PENDING`, `_TBD` or `_TODO` — the fill-in-later suffixes seen in fleet
 * output (Issues #3124 and #3248). `SECTION_PLACEHOLDER_VALUES`- or
 * `SYNC_PENDING_COUNT`-style names with a trailing word character after the
 * suffix correctly do not match — the final `\b` requires a non-word
 * boundary there.
 */
const PLACEHOLDER_TOKEN_RE =
  /\b[A-Z][A-Z0-9_]*_(?:PLACEHOLDER|PENDING|TBD|TODO)\b/g;

/** A gate command a result line cites (Issue #3248). */
const GATE_COMMAND_RE =
  /\bquality\.sh\b|\b(?:deno|cargo|npm|pnpm|yarn|go|make)\s+(?:task|test|lint|check|fmt|clippy|audit|run|build|vet)\b|\b(?:pytest|shellcheck|semgrep)\b/;

/** A bare ALL-CAPS identifier with at least one underscore, optionally ending in a full stop. */
const BARE_IDENTIFIER_RE = /^([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\.?$/;

/**
 * Result separators counted only after the cited gate command (Issue #3287);
 * a colon counts anywhere on the line (Issue #3248). Restricting these to
 * after the command keeps a list bullet's `- ` or an option's `=` before it
 * from reading as one.
 */
const POST_COMMAND_SEPARATORS = ["—", "–", " -- ", " - ", "="] as const;

/** Offset just past the line's last result separator, or -1 when it has none. */
function resultTailStart(maskedLine: string, commandEnd: number): number {
  let bestAt = -1;
  let tailStart = -1;

  const colon = maskedLine.lastIndexOf(":");
  if (colon !== -1) {
    bestAt = colon;
    tailStart = colon + 1;
  }

  for (const sep of POST_COMMAND_SEPARATORS) {
    const at = maskedLine.lastIndexOf(sep);
    if (at >= commandEnd && at > bestAt) {
      bestAt = at;
      tailStart = at + sep.length;
    }
  }

  return tailStart;
}

/**
 * Split text into alternating "outside code" / "inside code" segments, so
 * callers can scan or rewrite only the prose a reader actually sees.
 * Fenced blocks (``` or ~~~, to the matching close or end of text) and
 * inline backtick spans are both "inside code" — a token named for
 * discussion (`` `REDACTION_PLACEHOLDER` ``) is not an unfilled result.
 */
/** A fence line: the marker character, how long the run is, and the rest of the line. */
interface FenceLine {
  char: string;
  length: number;
  rest: string;
}

/**
 * A line whose first non-space characters are a fence. Indent is ignored, so
 * a fence under a list item counts. CommonMark's three-space limit does not:
 * archived summaries indent list fences further than that.
 */
function parseFenceLine(line: string): FenceLine | null {
  // `split` keeps the line break, and `.` does not match it, so trim first.
  const match = line.trim().match(/^(`{3,}|~{3,})(.*)$/);
  if (!match) return null;
  return {
    char: match[1]![0]!,
    length: match[1]!.length,
    rest: match[2] ?? "",
  };
}

/** A closer uses the opener's character, is at least as long, and has no info string. */
function isClosingFence(line: string, opener: FenceLine): boolean {
  const parsed = parseFenceLine(line);
  if (!parsed) return false;
  return parsed.char === opener.char && parsed.length >= opener.length &&
    parsed.rest.trim() === "";
}

/**
 * Pair inline code spans inside one paragraph. A run of N backticks closes
 * at the next run of exactly N, and that span may contain a line break.
 * A run with no closer is literal text. CommonMark does not let a span
 * cross a blank line, so the caller passes one paragraph at a time.
 */
function splitInlineSpans(
  block: string,
): Array<{ value: string; inCode: boolean }> {
  const runs: Array<{ index: number; length: number }> = [];
  const runRe = /`+/g;
  let found: RegExpExecArray | null;
  while ((found = runRe.exec(block)) !== null) {
    runs.push({ index: found.index, length: found[0].length });
  }

  const segments: Array<{ value: string; inCode: boolean }> = [];
  let cursor = 0;
  let r = 0;
  while (r < runs.length) {
    const open = runs[r]!;
    if (open.index > cursor) {
      segments.push({ value: block.slice(cursor, open.index), inCode: false });
    }
    let closeAt = -1;
    for (let k = r + 1; k < runs.length; k++) {
      if (runs[k]!.length === open.length) {
        closeAt = k;
        break;
      }
    }
    if (closeAt === -1) {
      const end = open.index + open.length;
      segments.push({ value: block.slice(open.index, end), inCode: false });
      cursor = end;
      r++;
      continue;
    }
    const close = runs[closeAt]!;
    const end = close.index + close.length;
    segments.push({ value: block.slice(open.index, end), inCode: true });
    cursor = end;
    r = closeAt + 1;
  }
  if (cursor < block.length) {
    segments.push({ value: block.slice(cursor), inCode: false });
  }
  return segments;
}

function splitOutsideCode(
  text: string,
): Array<{ value: string; inCode: boolean }> {
  const segments: Array<{ value: string; inCode: boolean }> = [];
  const lines = text.split(/(?<=\n)/); // keep line terminators attached
  let i = 0;
  let fenceCursor = "";
  let paragraph = "";
  let inFence = false;
  let opener: FenceLine | null = null;

  function pushSegment(value: string, inCode: boolean) {
    if (value.length === 0) return;
    const last = segments[segments.length - 1];
    if (last && last.inCode === inCode) last.value += value;
    else segments.push({ value, inCode });
  }

  function flushParagraph() {
    if (paragraph.length === 0) return;
    for (const segment of splitInlineSpans(paragraph)) {
      pushSegment(segment.value, segment.inCode);
    }
    paragraph = "";
  }

  while (i < lines.length) {
    const line = lines[i]!;
    const fenceMatch = parseFenceLine(line);
    if (fenceMatch && !inFence) {
      flushParagraph();
      inFence = true;
      opener = fenceMatch;
      fenceCursor += line;
      i++;
      continue;
    }
    if (inFence && opener && isClosingFence(line, opener)) {
      fenceCursor += line;
      pushSegment(fenceCursor, true);
      fenceCursor = "";
      inFence = false;
      opener = null;
      i++;
      continue;
    }
    if (inFence) {
      fenceCursor += line;
      i++;
      continue;
    }
    // A blank line ends the paragraph, so a code span cannot cross it.
    if (line.trim() === "") {
      flushParagraph();
      pushSegment(line, false);
      i++;
      continue;
    }
    paragraph += line;
    i++;
  }
  if (inFence) pushSegment(fenceCursor, true);
  else flushParagraph();
  return segments;
}

/**
 * Replace every in-code character (everything but `\n`) with a space, so the
 * result is the same length — and every offset lines up — as `text`, but
 * carries only the prose a reader actually sees.
 */
function maskCode(text: string): string {
  return splitOutsideCode(text)
    .map((segment) =>
      segment.inCode ? segment.value.replace(/[^\n]/g, " ") : segment.value
    )
    .join("");
}

/** One located fill-in-later token, from either the suffix rule or the backstop. */
interface TokenMatch {
  /** Offset of the token's first character in the original text. */
  start: number;
  /** Offset just past the token's last character. */
  end: number;
  /** The token's text. */
  name: string;
}

/**
 * Find every fill-in-later token in `text`, outside fenced code blocks and
 * inline code spans, in document order (Issue #3248).
 *
 * Two independent rules run over the code-masked text (so offsets still line
 * up with the original): the suffix rule ({@link PLACEHOLDER_TOKEN_RE}), and
 * a structural backstop for result lines — a line whose RAW text cites a
 * known gate command, where the text after the line's last result separator
 * (taken from the masked line) is a bare ALL-CAPS identifier with an
 * underscore, optionally followed by a full stop. A result separator is a
 * `:` anywhere on the line, or (Issue #3287) an em dash, en dash, spaced
 * hyphen or double hyphen, or `=`, counted only after the cited command (see
 * {@link resultTailStart}). The backstop and the suffix rule can
 * both find the same token (e.g. `GATE_OUTCOME_PENDING`); overlapping
 * matches are de-duplicated, keeping the earlier one.
 */
function findTokenMatches(text: string): TokenMatch[] {
  const masked = maskCode(text);
  const matches: TokenMatch[] = [];

  for (const found of masked.matchAll(PLACEHOLDER_TOKEN_RE)) {
    matches.push({
      start: found.index!,
      end: found.index! + found[0].length,
      name: found[0],
    });
  }

  let lineStart = 0;
  while (lineStart <= masked.length) {
    const nl = masked.indexOf("\n", lineStart);
    const lineEnd = nl === -1 ? masked.length : nl;
    const rawLine = text.slice(lineStart, lineEnd);
    const maskedLine = masked.slice(lineStart, lineEnd);
    const command = rawLine.match(GATE_COMMAND_RE);
    if (command) {
      const tailStart = resultTailStart(
        maskedLine,
        command.index! + command[0].length,
      );
      if (tailStart !== -1) {
        const tail = maskedLine.slice(tailStart);
        const trimmed = tail.trim();
        const identMatch = trimmed.match(BARE_IDENTIFIER_RE);
        if (identMatch) {
          const name = identMatch[1]!;
          const leadingWhitespace = tail.length - tail.trimStart().length;
          const start = lineStart + tailStart + leadingWhitespace;
          matches.push({ start, end: start + name.length, name });
        }
      }
    }
    if (lineEnd === masked.length) break;
    lineStart = lineEnd + 1;
  }

  matches.sort((a, b) => a.start - b.start);
  const kept: TokenMatch[] = [];
  for (const match of matches) {
    const previous = kept[kept.length - 1];
    if (previous && match.start < previous.end) continue;
    kept.push(match);
  }
  return kept;
}

/**
 * Find every distinct fill-in-later token name in `text`, in first-seen
 * order, capped at {@link MAX_NAMED_TOKENS} (Issues #3124, #3248). A token
 * mentioned only inside backticks — e.g. discussing
 * `` `REDACTION_PLACEHOLDER` `` — is deliberately not reported; one left
 * bare in prose (`QUALITY_RESULT_PLACEHOLDER`), or a bare ALL-CAPS
 * identifier on a result line (`GATE_OUTCOME_PENDING`), is.
 */
export function findResultPlaceholders(text: string): string[] {
  const bounded = (text ?? "").slice(0, MAX_SCAN_CHARS);
  const found: string[] = [];
  const seen = new Set<string>();
  for (const match of findTokenMatches(bounded)) {
    if (seen.has(match.name)) continue;
    seen.add(match.name);
    found.push(match.name);
    if (found.length >= MAX_NAMED_TOKENS) return found;
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

/**
 * Replace every bare (outside-code) fill-in-later token — from either rule —
 * with `replacement`, splicing into the ORIGINAL text so code spans and
 * fences stay byte-identical (Issues #3124, #3248).
 */
export function replaceResultPlaceholders(
  text: string,
  replacement: string,
): string {
  const original = text ?? "";
  const matches = findTokenMatches(original);
  let result = original;
  for (let i = matches.length - 1; i >= 0; i--) {
    const match = matches[i]!;
    result = result.slice(0, match.start) + replacement +
      result.slice(match.end);
  }
  return result;
}

/** Render the token list for a comment or prompt, e.g. `` `FOO_PLACEHOLDER`, `BAR_PLACEHOLDER` ``. */
function describeTokens(tokens: readonly string[]): string {
  // Every token comes from either the strict `[A-Z][A-Z0-9_]*_(?:PLACEHOLDER|
  // PENDING|TBD|TODO)` suffix regex or the structural backstop's
  // `[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+` identifier, so every name is
  // `[A-Z][A-Z0-9_]*` — safe to echo verbatim into Markdown and a prompt.
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
    'result, not a passing one — it reads as "the gate was run" to anyone ' +
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
