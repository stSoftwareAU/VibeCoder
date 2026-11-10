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
 * Pure functions only, hardcoded regexes
 * (no `new RegExp()` built from input), and a bounded scan of text that is
 * agent-authored and steered by an untrusted issue body, so it is treated as
 * untrusted throughout.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */ import { maskMarkdownCode } from "./markdown_code_spans.ts";
/** Cap on untrusted text scanned by the gate's regex (defence in depth). */ const MAX_SCAN_CHARS = 200_000;
/** Up to how many distinct tokens are named in a comment or prompt. */ const MAX_NAMED_TOKENS = 10;
/**
 * A fill-in-later token: an all-caps identifier ending in `_PLACEHOLDER`,
 * `_PENDING`, `_TBD` or `_TODO` — the fill-in-later suffixes seen in fleet
 * output (Issues #3124 and #3248). `SECTION_PLACEHOLDER_VALUES`- or
 * `SYNC_PENDING_COUNT`-style names with a trailing word character after the
 * suffix correctly do not match — the final `\b` requires a non-word
 * boundary there.
 */ const PLACEHOLDER_TOKEN_RE = /\b[A-Z][A-Z0-9_]*_(?:PLACEHOLDER|PENDING|TBD|TODO)\b/g;
/** A gate command a result line cites (Issue #3248). */ const GATE_COMMAND_RE = /\bquality\.sh\b|\b(?:deno|cargo|npm|pnpm|yarn|go|make)\s+(?:task|test|lint|check|fmt|clippy|audit|run|build|vet)\b|\b(?:pytest|shellcheck|semgrep)\b/;
/** A bare ALL-CAPS identifier with at least one underscore, optionally ending in a full stop. */ const BARE_IDENTIFIER_RE = /^([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\.?$/;
/**
 * Result separators counted only after the cited gate command (Issue #3287);
 * a colon counts anywhere on the line (Issue #3248). Restricting these to
 * after the command keeps a list bullet's `- ` or an option's `=` before it
 * from reading as one.
 */ const POST_COMMAND_SEPARATORS = [
  "—",
  "–",
  " -- ",
  " - ",
  "="
];
/** Offset just past the line's last result separator, or -1 when it has none. */ function resultTailStart(maskedLine, commandEnd) {
  let bestAt = -1;
  let tailStart = -1;
  const colon = maskedLine.lastIndexOf(":");
  if (colon !== -1) {
    bestAt = colon;
    tailStart = colon + 1;
  }
  for (const sep of POST_COMMAND_SEPARATORS){
    const at = maskedLine.lastIndexOf(sep);
    if (at >= commandEnd && at > bestAt) {
      bestAt = at;
      tailStart = at + sep.length;
    }
  }
  return tailStart;
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
 */ function findTokenMatches(text) {
  const masked = maskMarkdownCode(text);
  const matches = [];
  for (const found of masked.matchAll(PLACEHOLDER_TOKEN_RE)){
    matches.push({
      start: found.index,
      end: found.index + found[0].length,
      name: found[0]
    });
  }
  let lineStart = 0;
  while(lineStart <= masked.length){
    const nl = masked.indexOf("\n", lineStart);
    const lineEnd = nl === -1 ? masked.length : nl;
    const rawLine = text.slice(lineStart, lineEnd);
    const maskedLine = masked.slice(lineStart, lineEnd);
    const command = rawLine.match(GATE_COMMAND_RE);
    if (command) {
      const tailStart = resultTailStart(maskedLine, command.index + command[0].length);
      if (tailStart !== -1) {
        const tail = maskedLine.slice(tailStart);
        const trimmed = tail.trim();
        const identMatch = trimmed.match(BARE_IDENTIFIER_RE);
        if (identMatch) {
          const name = identMatch[1];
          const leadingWhitespace = tail.length - tail.trimStart().length;
          const start = lineStart + tailStart + leadingWhitespace;
          matches.push({
            start,
            end: start + name.length,
            name
          });
        }
      }
    }
    if (lineEnd === masked.length) break;
    lineStart = lineEnd + 1;
  }
  matches.sort((a, b)=>a.start - b.start);
  const kept = [];
  for (const match of matches){
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
 */ export function findResultPlaceholders(text) {
  const bounded = (text ?? "").slice(0, MAX_SCAN_CHARS);
  const found = [];
  const seen = new Set();
  for (const match of findTokenMatches(bounded)){
    if (seen.has(match.name)) continue;
    seen.add(match.name);
    found.push(match.name);
    if (found.length >= MAX_NAMED_TOKENS) return found;
  }
  return found;
}
/**
 * Verify that `text` carries no left-over fill-in-later token where a
 * command's result belongs.
 */ export function validateResultPlaceholders(text) {
  const tokens = findResultPlaceholders(text);
  return {
    valid: tokens.length === 0,
    tokens
  };
}
/**
 * Replace every bare (outside-code) fill-in-later token — from either rule —
 * with `replacement`, splicing into the ORIGINAL text so code spans and
 * fences stay byte-identical (Issues #3124, #3248).
 */ export function replaceResultPlaceholders(text, replacement) {
  const original = text ?? "";
  const matches = findTokenMatches(original);
  let result = original;
  for(let i = matches.length - 1; i >= 0; i--){
    const match = matches[i];
    result = result.slice(0, match.start) + replacement + result.slice(match.end);
  }
  return result;
}
/** Render the token list for a comment or prompt, e.g. `` `FOO_PLACEHOLDER`, `BAR_PLACEHOLDER` ``. */ function describeTokens(tokens) {
  // Every token comes from either the strict `[A-Z][A-Z0-9_]*_(?:PLACEHOLDER|
  // PENDING|TBD|TODO)` suffix regex or the structural backstop's
  // `[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+` identifier, so every name is
  // `[A-Z][A-Z0-9_]*` — safe to echo verbatim into Markdown and a prompt.
  return tokens.map((token)=>`\`${token}\``).join(", ");
}
/**
 * Build the comment posted when the result-placeholder gate blocks PR
 * creation.
 *
 * Explains that a placeholder where a result belongs counts as an unreported
 * result, and asks for the actual outcome, not a re-derivation of what the
 * command was for.
 */ export function buildResultPlaceholderGateComment(tokens) {
  return [
    "⚠️ **Unfilled result placeholder.** The PR summary still carries " + `${tokens.length === 1 ? "a token" : "token(s)"} where a command's ` + `result belongs: ${describeTokens(tokens)}.`,
    "",
    "A fill-in-later token left in place of a result counts as an unreported " + 'result, not a passing one — it reads as "the gate was run" to anyone ' + "who does not know the fleet's internal vocabulary, when nothing was " + "actually reported.",
    "",
    "For each token above, re-run the command it stands for on the branch's " + "final head and replace it with the actual outcome:",
    "",
    "- Passed — say so, briefly.",
    "- Failed — say so, and give its first error.",
    "- Not run at all — say that plainly rather than leaving the token in " + "place."
  ].join("\n");
}
/**
 * Build the prompt for the single reply-path recovery turn (Issue #3124).
 *
 * Tells the agent its own `.pr_response_message` still carries unresolved
 * placeholder token(s), and asks it to rewrite ONLY that file with the
 * actual outcome — or a plain statement the command was not run — making no
 * other change.
 */ export function buildReplyPlaceholderRetryPrompt(tokens) {
  return `Your \`.pr_response_message\` still contains unresolved result-placeholder token(s): ${describeTokens(tokens)}.

A placeholder left where a command's result belongs reads as a claim the command passed, when in truth nothing was reported — this must not reach the public PR comment unresolved.

Do exactly this, and nothing else:

1. Rewrite ONLY \`.pr_response_message\`, replacing each token above with the actual outcome of the command it stands for: passed (briefly), or failed with its first error, or state plainly the command was not run.
2. Make no other change — do not touch any other file, do not create a PR, do not close the issue.

If you cannot determine the actual outcome, say so plainly in that file rather than leaving the token in place.`;
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
 */ export async function retryReplyPlaceholdersOnce(path, deps) {
  const content = await deps.readFile(path);
  if (content === undefined) return {
    retried: false,
    tokens: []
  };
  const tokens = findResultPlaceholders(content);
  if (tokens.length === 0) return {
    retried: false,
    tokens: []
  };
  deps.logger?.warn("Reply carries unresolved result-placeholder token(s) — recovering once in-run (Issue #3124)", {
    tokens
  });
  const result = await deps.runAgent(buildReplyPlaceholderRetryPrompt(tokens));
  if (!result.ok) {
    // The chokepoint backstop in `readPrResponseMessage` still applies —
    // this is logged, not fatal, because the feedback run's main work has
    // already succeeded by the time this peek runs.
    deps.logger?.error(`Result-placeholder reply recovery invocation failed — the ` + `fail-loud chokepoint backstop will apply instead: ${result.error?.message ?? "unknown error"}`, {
      tokens
    });
  }
  return {
    retried: true,
    tokens
  };
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9yZXN1bHRfcGxhY2Vob2xkZXJfZ2F0ZS50cyJdLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIFJlc3VsdC1wbGFjZWhvbGRlciBnYXRlIChJc3N1ZSAjMzEyNCwgd2lkZW5lZCBieSBJc3N1ZSAjMzI0OCkuXG4gKlxuICogV2hpbGUgZHJhZnRpbmcsIHRoZSBhZ2VudCBzb21ldGltZXMgaW52ZW50cyBpdHMgb3duIGZpbGwtaW4tbGF0ZXIgdG9rZW4g4oCUXG4gKiBhbiBhbGwtY2FwcyBuYW1lIGVuZGluZyBpbiBgX1BMQUNFSE9MREVSYCwgYF9QRU5ESU5HYCwgYF9UQkRgIG9yIGBfVE9ET2AsXG4gKiBzdWNoIGFzIGBRVUFMSVRZX1JFU1VMVF9QTEFDRUhPTERFUmAg4oCUIHdoZXJlIGEgY29tbWFuZCdzIHJlc3VsdCBiZWxvbmdzLFxuICogYW5kIHRoZW4gbmV2ZXIgcmVwbGFjZXMgaXQgd2l0aCB0aGUgb3V0Y29tZS4gTm8gcHJvbXB0IHRlbXBsYXRlIHN1cHBsaWVzXG4gKiB0aGF0IHRva2VuLiBMZWZ0IGJhcmUsIGl0IHJlYWRzIGFzIFwidGhlIGdhdGUgd2FzIHJ1blwiIHRvIGFueW9uZSB3aG8gZG9lc1xuICogbm90IGtub3cgaXQgaXMgYSBzdGFuZC1pbiwgd2hlbiBpbiB0cnV0aCBub3RoaW5nIHdhcyByZXBvcnRlZCBhdCBhbGwuXG4gKlxuICogQSBmbGVldCBQUiAoR1JRIzUxNjQpIGVzY2FwZWQgdGhlIHN1ZmZpeCBjaGVjayBlbnRpcmVseSB3aXRoXG4gKiBgR0FURV9PVVRDT01FX1BFTkRJTkdgIG9uIGEgcmVzdWx0IGxpbmU6XG4gKiBgYCAtIGAuL3F1YWxpdHkuc2ggPCAvZGV2L251bGxgIG9uIHRoZSBoZWFkOiBHQVRFX09VVENPTUVfUEVORElORyBgYC4gU2luY2VcbiAqIElzc3VlICMzMjQ4LCBhIHNlY29uZCwgc3RydWN0dXJhbCBydWxlIGJhY2tzdG9wcyB0aGUgc3VmZml4IG9uZTogb24gYSBsaW5lXG4gKiB3aG9zZSByYXcgdGV4dCBjaXRlcyBhIGtub3duIGdhdGUgY29tbWFuZCAoYC4vcXVhbGl0eS5zaGAsIGBkZW5vIHRlc3RgLFxuICogYGNhcmdvIHRlc3RgLCBldGMuKSwgdGhlIHRleHQgYWZ0ZXIgdGhlIGxpbmUncyBsYXN0IHJlc3VsdCBzZXBhcmF0b3IgaXNcbiAqIGNoZWNrZWQgYXMgYSB3aG9sZSDigJQgYSBiYXJlIEFMTC1DQVBTIGlkZW50aWZpZXIgd2l0aCBhdCBsZWFzdCBvbmVcbiAqIHVuZGVyc2NvcmUgdGhlcmUgKG9wdGlvbmFsbHkgZm9sbG93ZWQgYnkgYSBmdWxsIHN0b3ApIGlzIGEgZmlsbC1pbi1sYXRlclxuICogdG9rZW4gcmVnYXJkbGVzcyBvZiBpdHMgc3VmZml4LiBgUEFTU0VEYCBhbmQgYE9LYCAobm8gdW5kZXJzY29yZSkgYXJlIG5vdFxuICogZmxhZ2dlZDsgYSBsaW5lIHdpdGggbm8gY2l0ZWQgZ2F0ZSBjb21tYW5kIGlzIG5vdCBmbGFnZ2VkLiBBIHJlc3VsdFxuICogc2VwYXJhdG9yIGlzIGEgYDpgIGFueXdoZXJlIG9uIHRoZSBsaW5lLCBvciDigJQgc2luY2UgSXNzdWUgIzMyODcsIGFmdGVyIGFcbiAqIFBSICgjMzI4MykgZXNjYXBlZCB0aGUgY29sb24gZm9ybSB3aXRoXG4gKiBgYCAtIGAuL3F1YWxpdHkuc2hgIOKAlCBHQVRFX1JFU1VMVCBgYCDigJQgYW4gZW0gZGFzaCwgZW4gZGFzaCwgc3BhY2VkIGh5cGhlblxuICogb3IgZG91YmxlIGh5cGhlbiwgb3IgYD1gLCBlYWNoIGNvdW50ZWQgb25seSBhZnRlciB0aGUgY2l0ZWQgY29tbWFuZC5cbiAqXG4gKiBBIGxlZnQtb3ZlciBwbGFjZWhvbGRlciwgY2F1Z2h0IGJ5IGVpdGhlciBydWxlLCBpcyB0aGVyZWZvcmUgdHJlYXRlZCB0aGVcbiAqIHNhbWUgYXMgYW4gdW5yZXBvcnRlZCByZXN1bHQ6IHRoZSBQUi1jcmVhdGlvbiBwYXRoIGJsb2NrcyBvbiBpdCAoZm9sZGVkXG4gKiBpbnRvIHdoaWNoZXZlciBzdW1tYXJ5LXJ1bGUgZ2F0ZSBhbHNvIGZhaWxzLCBzbyBvbmUgcmVjb3ZlcnkgdHVybiBhc2tzIGZvclxuICogZXZlcnl0aGluZyDigJQgYGNvbXBsZXRpb25fcGhhc2UudHNgKSwgYW5kIHRoZSByZXBseSBwYXRoIG5ldmVyIGxldHMgb25lXG4gKiByZWFjaCBhIHB1YmxpYyBQUiBjb21tZW50IGF0IGFsbCAoYHByX2JyYW5jaF9wcmVwYXJhdGlvbi50c2Anc1xuICogYHJlYWRQclJlc3BvbnNlTWVzc2FnZWAgY2hva2Vwb2ludCkuXG4gKlxuICogUHVyZSBmdW5jdGlvbnMgb25seSwgaGFyZGNvZGVkIHJlZ2V4ZXNcbiAqIChubyBgbmV3IFJlZ0V4cCgpYCBidWlsdCBmcm9tIGlucHV0KSwgYW5kIGEgYm91bmRlZCBzY2FuIG9mIHRleHQgdGhhdCBpc1xuICogYWdlbnQtYXV0aG9yZWQgYW5kIHN0ZWVyZWQgYnkgYW4gdW50cnVzdGVkIGlzc3VlIGJvZHksIHNvIGl0IGlzIHRyZWF0ZWQgYXNcbiAqIHVudHJ1c3RlZCB0aHJvdWdob3V0LlxuICpcbiAqIFVzZXMgQXVzdHJhbGlhbiBFbmdsaXNoIHRocm91Z2hvdXQgKGJlaGF2aW91ciwgY29sb3VyLCBvcmdhbmlzYXRpb24sIGV0Yy4pLlxuICovXG5cbmltcG9ydCB7IG1hc2tNYXJrZG93bkNvZGUgfSBmcm9tIFwiLi9tYXJrZG93bl9jb2RlX3NwYW5zLnRzXCI7XG5cbi8qKiBDYXAgb24gdW50cnVzdGVkIHRleHQgc2Nhbm5lZCBieSB0aGUgZ2F0ZSdzIHJlZ2V4IChkZWZlbmNlIGluIGRlcHRoKS4gKi9cbmNvbnN0IE1BWF9TQ0FOX0NIQVJTID0gMjAwXzAwMDtcblxuLyoqIFVwIHRvIGhvdyBtYW55IGRpc3RpbmN0IHRva2VucyBhcmUgbmFtZWQgaW4gYSBjb21tZW50IG9yIHByb21wdC4gKi9cbmNvbnN0IE1BWF9OQU1FRF9UT0tFTlMgPSAxMDtcblxuLyoqXG4gKiBBIGZpbGwtaW4tbGF0ZXIgdG9rZW46IGFuIGFsbC1jYXBzIGlkZW50aWZpZXIgZW5kaW5nIGluIGBfUExBQ0VIT0xERVJgLFxuICogYF9QRU5ESU5HYCwgYF9UQkRgIG9yIGBfVE9ET2Ag4oCUIHRoZSBmaWxsLWluLWxhdGVyIHN1ZmZpeGVzIHNlZW4gaW4gZmxlZXRcbiAqIG91dHB1dCAoSXNzdWVzICMzMTI0IGFuZCAjMzI0OCkuIGBTRUNUSU9OX1BMQUNFSE9MREVSX1ZBTFVFU2AtIG9yXG4gKiBgU1lOQ19QRU5ESU5HX0NPVU5UYC1zdHlsZSBuYW1lcyB3aXRoIGEgdHJhaWxpbmcgd29yZCBjaGFyYWN0ZXIgYWZ0ZXIgdGhlXG4gKiBzdWZmaXggY29ycmVjdGx5IGRvIG5vdCBtYXRjaCDigJQgdGhlIGZpbmFsIGBcXGJgIHJlcXVpcmVzIGEgbm9uLXdvcmRcbiAqIGJvdW5kYXJ5IHRoZXJlLlxuICovXG5jb25zdCBQTEFDRUhPTERFUl9UT0tFTl9SRSA9XG4gIC9cXGJbQS1aXVtBLVowLTlfXSpfKD86UExBQ0VIT0xERVJ8UEVORElOR3xUQkR8VE9ETylcXGIvZztcblxuLyoqIEEgZ2F0ZSBjb21tYW5kIGEgcmVzdWx0IGxpbmUgY2l0ZXMgKElzc3VlICMzMjQ4KS4gKi9cbmNvbnN0IEdBVEVfQ09NTUFORF9SRSA9XG4gIC9cXGJxdWFsaXR5XFwuc2hcXGJ8XFxiKD86ZGVub3xjYXJnb3xucG18cG5wbXx5YXJufGdvfG1ha2UpXFxzKyg/OnRhc2t8dGVzdHxsaW50fGNoZWNrfGZtdHxjbGlwcHl8YXVkaXR8cnVufGJ1aWxkfHZldClcXGJ8XFxiKD86cHl0ZXN0fHNoZWxsY2hlY2t8c2VtZ3JlcClcXGIvO1xuXG4vKiogQSBiYXJlIEFMTC1DQVBTIGlkZW50aWZpZXIgd2l0aCBhdCBsZWFzdCBvbmUgdW5kZXJzY29yZSwgb3B0aW9uYWxseSBlbmRpbmcgaW4gYSBmdWxsIHN0b3AuICovXG5jb25zdCBCQVJFX0lERU5USUZJRVJfUkUgPSAvXihbQS1aXVtBLVowLTldKig/Ol9bQS1aMC05XSspKylcXC4/JC87XG5cbi8qKlxuICogUmVzdWx0IHNlcGFyYXRvcnMgY291bnRlZCBvbmx5IGFmdGVyIHRoZSBjaXRlZCBnYXRlIGNvbW1hbmQgKElzc3VlICMzMjg3KTtcbiAqIGEgY29sb24gY291bnRzIGFueXdoZXJlIG9uIHRoZSBsaW5lIChJc3N1ZSAjMzI0OCkuIFJlc3RyaWN0aW5nIHRoZXNlIHRvXG4gKiBhZnRlciB0aGUgY29tbWFuZCBrZWVwcyBhIGxpc3QgYnVsbGV0J3MgYC0gYCBvciBhbiBvcHRpb24ncyBgPWAgYmVmb3JlIGl0XG4gKiBmcm9tIHJlYWRpbmcgYXMgb25lLlxuICovXG5jb25zdCBQT1NUX0NPTU1BTkRfU0VQQVJBVE9SUyA9IFtcIuKAlFwiLCBcIuKAk1wiLCBcIiAtLSBcIiwgXCIgLSBcIiwgXCI9XCJdIGFzIGNvbnN0O1xuXG4vKiogT2Zmc2V0IGp1c3QgcGFzdCB0aGUgbGluZSdzIGxhc3QgcmVzdWx0IHNlcGFyYXRvciwgb3IgLTEgd2hlbiBpdCBoYXMgbm9uZS4gKi9cbmZ1bmN0aW9uIHJlc3VsdFRhaWxTdGFydChtYXNrZWRMaW5lOiBzdHJpbmcsIGNvbW1hbmRFbmQ6IG51bWJlcik6IG51bWJlciB7XG4gIGxldCBiZXN0QXQgPSAtMTtcbiAgbGV0IHRhaWxTdGFydCA9IC0xO1xuXG4gIGNvbnN0IGNvbG9uID0gbWFza2VkTGluZS5sYXN0SW5kZXhPZihcIjpcIik7XG4gIGlmIChjb2xvbiAhPT0gLTEpIHtcbiAgICBiZXN0QXQgPSBjb2xvbjtcbiAgICB0YWlsU3RhcnQgPSBjb2xvbiArIDE7XG4gIH1cblxuICBmb3IgKGNvbnN0IHNlcCBvZiBQT1NUX0NPTU1BTkRfU0VQQVJBVE9SUykge1xuICAgIGNvbnN0IGF0ID0gbWFza2VkTGluZS5sYXN0SW5kZXhPZihzZXApO1xuICAgIGlmIChhdCA+PSBjb21tYW5kRW5kICYmIGF0ID4gYmVzdEF0KSB7XG4gICAgICBiZXN0QXQgPSBhdDtcbiAgICAgIHRhaWxTdGFydCA9IGF0ICsgc2VwLmxlbmd0aDtcbiAgICB9XG4gIH1cblxuICByZXR1cm4gdGFpbFN0YXJ0O1xufVxuXG4vKiogT25lIGxvY2F0ZWQgZmlsbC1pbi1sYXRlciB0b2tlbiwgZnJvbSBlaXRoZXIgdGhlIHN1ZmZpeCBydWxlIG9yIHRoZSBiYWNrc3RvcC4gKi9cbmludGVyZmFjZSBUb2tlbk1hdGNoIHtcbiAgLyoqIE9mZnNldCBvZiB0aGUgdG9rZW4ncyBmaXJzdCBjaGFyYWN0ZXIgaW4gdGhlIG9yaWdpbmFsIHRleHQuICovXG4gIHN0YXJ0OiBudW1iZXI7XG4gIC8qKiBPZmZzZXQganVzdCBwYXN0IHRoZSB0b2tlbidzIGxhc3QgY2hhcmFjdGVyLiAqL1xuICBlbmQ6IG51bWJlcjtcbiAgLyoqIFRoZSB0b2tlbidzIHRleHQuICovXG4gIG5hbWU6IHN0cmluZztcbn1cblxuLyoqXG4gKiBGaW5kIGV2ZXJ5IGZpbGwtaW4tbGF0ZXIgdG9rZW4gaW4gYHRleHRgLCBvdXRzaWRlIGZlbmNlZCBjb2RlIGJsb2NrcyBhbmRcbiAqIGlubGluZSBjb2RlIHNwYW5zLCBpbiBkb2N1bWVudCBvcmRlciAoSXNzdWUgIzMyNDgpLlxuICpcbiAqIFR3byBpbmRlcGVuZGVudCBydWxlcyBydW4gb3ZlciB0aGUgY29kZS1tYXNrZWQgdGV4dCAoc28gb2Zmc2V0cyBzdGlsbCBsaW5lXG4gKiB1cCB3aXRoIHRoZSBvcmlnaW5hbCk6IHRoZSBzdWZmaXggcnVsZSAoe0BsaW5rIFBMQUNFSE9MREVSX1RPS0VOX1JFfSksIGFuZFxuICogYSBzdHJ1Y3R1cmFsIGJhY2tzdG9wIGZvciByZXN1bHQgbGluZXMg4oCUIGEgbGluZSB3aG9zZSBSQVcgdGV4dCBjaXRlcyBhXG4gKiBrbm93biBnYXRlIGNvbW1hbmQsIHdoZXJlIHRoZSB0ZXh0IGFmdGVyIHRoZSBsaW5lJ3MgbGFzdCByZXN1bHQgc2VwYXJhdG9yXG4gKiAodGFrZW4gZnJvbSB0aGUgbWFza2VkIGxpbmUpIGlzIGEgYmFyZSBBTEwtQ0FQUyBpZGVudGlmaWVyIHdpdGggYW5cbiAqIHVuZGVyc2NvcmUsIG9wdGlvbmFsbHkgZm9sbG93ZWQgYnkgYSBmdWxsIHN0b3AuIEEgcmVzdWx0IHNlcGFyYXRvciBpcyBhXG4gKiBgOmAgYW55d2hlcmUgb24gdGhlIGxpbmUsIG9yIChJc3N1ZSAjMzI4NykgYW4gZW0gZGFzaCwgZW4gZGFzaCwgc3BhY2VkXG4gKiBoeXBoZW4gb3IgZG91YmxlIGh5cGhlbiwgb3IgYD1gLCBjb3VudGVkIG9ubHkgYWZ0ZXIgdGhlIGNpdGVkIGNvbW1hbmQgKHNlZVxuICoge0BsaW5rIHJlc3VsdFRhaWxTdGFydH0pLiBUaGUgYmFja3N0b3AgYW5kIHRoZSBzdWZmaXggcnVsZSBjYW5cbiAqIGJvdGggZmluZCB0aGUgc2FtZSB0b2tlbiAoZS5nLiBgR0FURV9PVVRDT01FX1BFTkRJTkdgKTsgb3ZlcmxhcHBpbmdcbiAqIG1hdGNoZXMgYXJlIGRlLWR1cGxpY2F0ZWQsIGtlZXBpbmcgdGhlIGVhcmxpZXIgb25lLlxuICovXG5mdW5jdGlvbiBmaW5kVG9rZW5NYXRjaGVzKHRleHQ6IHN0cmluZyk6IFRva2VuTWF0Y2hbXSB7XG4gIGNvbnN0IG1hc2tlZCA9IG1hc2tNYXJrZG93bkNvZGUodGV4dCk7XG4gIGNvbnN0IG1hdGNoZXM6IFRva2VuTWF0Y2hbXSA9IFtdO1xuXG4gIGZvciAoY29uc3QgZm91bmQgb2YgbWFza2VkLm1hdGNoQWxsKFBMQUNFSE9MREVSX1RPS0VOX1JFKSkge1xuICAgIG1hdGNoZXMucHVzaCh7XG4gICAgICBzdGFydDogZm91bmQuaW5kZXghLFxuICAgICAgZW5kOiBmb3VuZC5pbmRleCEgKyBmb3VuZFswXS5sZW5ndGgsXG4gICAgICBuYW1lOiBmb3VuZFswXSxcbiAgICB9KTtcbiAgfVxuXG4gIGxldCBsaW5lU3RhcnQgPSAwO1xuICB3aGlsZSAobGluZVN0YXJ0IDw9IG1hc2tlZC5sZW5ndGgpIHtcbiAgICBjb25zdCBubCA9IG1hc2tlZC5pbmRleE9mKFwiXFxuXCIsIGxpbmVTdGFydCk7XG4gICAgY29uc3QgbGluZUVuZCA9IG5sID09PSAtMSA/IG1hc2tlZC5sZW5ndGggOiBubDtcbiAgICBjb25zdCByYXdMaW5lID0gdGV4dC5zbGljZShsaW5lU3RhcnQsIGxpbmVFbmQpO1xuICAgIGNvbnN0IG1hc2tlZExpbmUgPSBtYXNrZWQuc2xpY2UobGluZVN0YXJ0LCBsaW5lRW5kKTtcbiAgICBjb25zdCBjb21tYW5kID0gcmF3TGluZS5tYXRjaChHQVRFX0NPTU1BTkRfUkUpO1xuICAgIGlmIChjb21tYW5kKSB7XG4gICAgICBjb25zdCB0YWlsU3RhcnQgPSByZXN1bHRUYWlsU3RhcnQoXG4gICAgICAgIG1hc2tlZExpbmUsXG4gICAgICAgIGNvbW1hbmQuaW5kZXghICsgY29tbWFuZFswXS5sZW5ndGgsXG4gICAgICApO1xuICAgICAgaWYgKHRhaWxTdGFydCAhPT0gLTEpIHtcbiAgICAgICAgY29uc3QgdGFpbCA9IG1hc2tlZExpbmUuc2xpY2UodGFpbFN0YXJ0KTtcbiAgICAgICAgY29uc3QgdHJpbW1lZCA9IHRhaWwudHJpbSgpO1xuICAgICAgICBjb25zdCBpZGVudE1hdGNoID0gdHJpbW1lZC5tYXRjaChCQVJFX0lERU5USUZJRVJfUkUpO1xuICAgICAgICBpZiAoaWRlbnRNYXRjaCkge1xuICAgICAgICAgIGNvbnN0IG5hbWUgPSBpZGVudE1hdGNoWzFdITtcbiAgICAgICAgICBjb25zdCBsZWFkaW5nV2hpdGVzcGFjZSA9IHRhaWwubGVuZ3RoIC0gdGFpbC50cmltU3RhcnQoKS5sZW5ndGg7XG4gICAgICAgICAgY29uc3Qgc3RhcnQgPSBsaW5lU3RhcnQgKyB0YWlsU3RhcnQgKyBsZWFkaW5nV2hpdGVzcGFjZTtcbiAgICAgICAgICBtYXRjaGVzLnB1c2goeyBzdGFydCwgZW5kOiBzdGFydCArIG5hbWUubGVuZ3RoLCBuYW1lIH0pO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuICAgIGlmIChsaW5lRW5kID09PSBtYXNrZWQubGVuZ3RoKSBicmVhaztcbiAgICBsaW5lU3RhcnQgPSBsaW5lRW5kICsgMTtcbiAgfVxuXG4gIG1hdGNoZXMuc29ydCgoYSwgYikgPT4gYS5zdGFydCAtIGIuc3RhcnQpO1xuICBjb25zdCBrZXB0OiBUb2tlbk1hdGNoW10gPSBbXTtcbiAgZm9yIChjb25zdCBtYXRjaCBvZiBtYXRjaGVzKSB7XG4gICAgY29uc3QgcHJldmlvdXMgPSBrZXB0W2tlcHQubGVuZ3RoIC0gMV07XG4gICAgaWYgKHByZXZpb3VzICYmIG1hdGNoLnN0YXJ0IDwgcHJldmlvdXMuZW5kKSBjb250aW51ZTtcbiAgICBrZXB0LnB1c2gobWF0Y2gpO1xuICB9XG4gIHJldHVybiBrZXB0O1xufVxuXG4vKipcbiAqIEZpbmQgZXZlcnkgZGlzdGluY3QgZmlsbC1pbi1sYXRlciB0b2tlbiBuYW1lIGluIGB0ZXh0YCwgaW4gZmlyc3Qtc2VlblxuICogb3JkZXIsIGNhcHBlZCBhdCB7QGxpbmsgTUFYX05BTUVEX1RPS0VOU30gKElzc3VlcyAjMzEyNCwgIzMyNDgpLiBBIHRva2VuXG4gKiBtZW50aW9uZWQgb25seSBpbnNpZGUgYmFja3RpY2tzIOKAlCBlLmcuIGRpc2N1c3NpbmdcbiAqIGBgIGBSRURBQ1RJT05fUExBQ0VIT0xERVJgIGBgIOKAlCBpcyBkZWxpYmVyYXRlbHkgbm90IHJlcG9ydGVkOyBvbmUgbGVmdFxuICogYmFyZSBpbiBwcm9zZSAoYFFVQUxJVFlfUkVTVUxUX1BMQUNFSE9MREVSYCksIG9yIGEgYmFyZSBBTEwtQ0FQU1xuICogaWRlbnRpZmllciBvbiBhIHJlc3VsdCBsaW5lIChgR0FURV9PVVRDT01FX1BFTkRJTkdgKSwgaXMuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBmaW5kUmVzdWx0UGxhY2Vob2xkZXJzKHRleHQ6IHN0cmluZyk6IHN0cmluZ1tdIHtcbiAgY29uc3QgYm91bmRlZCA9ICh0ZXh0ID8/IFwiXCIpLnNsaWNlKDAsIE1BWF9TQ0FOX0NIQVJTKTtcbiAgY29uc3QgZm91bmQ6IHN0cmluZ1tdID0gW107XG4gIGNvbnN0IHNlZW4gPSBuZXcgU2V0PHN0cmluZz4oKTtcbiAgZm9yIChjb25zdCBtYXRjaCBvZiBmaW5kVG9rZW5NYXRjaGVzKGJvdW5kZWQpKSB7XG4gICAgaWYgKHNlZW4uaGFzKG1hdGNoLm5hbWUpKSBjb250aW51ZTtcbiAgICBzZWVuLmFkZChtYXRjaC5uYW1lKTtcbiAgICBmb3VuZC5wdXNoKG1hdGNoLm5hbWUpO1xuICAgIGlmIChmb3VuZC5sZW5ndGggPj0gTUFYX05BTUVEX1RPS0VOUykgcmV0dXJuIGZvdW5kO1xuICB9XG4gIHJldHVybiBmb3VuZDtcbn1cblxuLyoqIFZlcmRpY3Qgb2YgdGhlIHJlc3VsdC1wbGFjZWhvbGRlciBnYXRlIG92ZXIgYSBwaWVjZSBvZiB0ZXh0LiAqL1xuZXhwb3J0IGludGVyZmFjZSBSZXN1bHRQbGFjZWhvbGRlclJlc3VsdCB7XG4gIC8qKiBUcnVlIHdoZW4gbm8gYmFyZSBwbGFjZWhvbGRlciB0b2tlbiB3YXMgZm91bmQuICovXG4gIHZhbGlkOiBib29sZWFuO1xuICAvKiogVGhlIGRpc3RpbmN0IHRva2VucyBmb3VuZCwgZmlyc3Qtc2VlbiBvcmRlci4gKi9cbiAgdG9rZW5zOiBzdHJpbmdbXTtcbn1cblxuLyoqXG4gKiBWZXJpZnkgdGhhdCBgdGV4dGAgY2FycmllcyBubyBsZWZ0LW92ZXIgZmlsbC1pbi1sYXRlciB0b2tlbiB3aGVyZSBhXG4gKiBjb21tYW5kJ3MgcmVzdWx0IGJlbG9uZ3MuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiB2YWxpZGF0ZVJlc3VsdFBsYWNlaG9sZGVycyhcbiAgdGV4dDogc3RyaW5nLFxuKTogUmVzdWx0UGxhY2Vob2xkZXJSZXN1bHQge1xuICBjb25zdCB0b2tlbnMgPSBmaW5kUmVzdWx0UGxhY2Vob2xkZXJzKHRleHQpO1xuICByZXR1cm4geyB2YWxpZDogdG9rZW5zLmxlbmd0aCA9PT0gMCwgdG9rZW5zIH07XG59XG5cbi8qKlxuICogUmVwbGFjZSBldmVyeSBiYXJlIChvdXRzaWRlLWNvZGUpIGZpbGwtaW4tbGF0ZXIgdG9rZW4g4oCUIGZyb20gZWl0aGVyIHJ1bGUg4oCUXG4gKiB3aXRoIGByZXBsYWNlbWVudGAsIHNwbGljaW5nIGludG8gdGhlIE9SSUdJTkFMIHRleHQgc28gY29kZSBzcGFucyBhbmRcbiAqIGZlbmNlcyBzdGF5IGJ5dGUtaWRlbnRpY2FsIChJc3N1ZXMgIzMxMjQsICMzMjQ4KS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlcGxhY2VSZXN1bHRQbGFjZWhvbGRlcnMoXG4gIHRleHQ6IHN0cmluZyxcbiAgcmVwbGFjZW1lbnQ6IHN0cmluZyxcbik6IHN0cmluZyB7XG4gIGNvbnN0IG9yaWdpbmFsID0gdGV4dCA/PyBcIlwiO1xuICBjb25zdCBtYXRjaGVzID0gZmluZFRva2VuTWF0Y2hlcyhvcmlnaW5hbCk7XG4gIGxldCByZXN1bHQgPSBvcmlnaW5hbDtcbiAgZm9yIChsZXQgaSA9IG1hdGNoZXMubGVuZ3RoIC0gMTsgaSA+PSAwOyBpLS0pIHtcbiAgICBjb25zdCBtYXRjaCA9IG1hdGNoZXNbaV0hO1xuICAgIHJlc3VsdCA9IHJlc3VsdC5zbGljZSgwLCBtYXRjaC5zdGFydCkgKyByZXBsYWNlbWVudCArXG4gICAgICByZXN1bHQuc2xpY2UobWF0Y2guZW5kKTtcbiAgfVxuICByZXR1cm4gcmVzdWx0O1xufVxuXG4vKiogUmVuZGVyIHRoZSB0b2tlbiBsaXN0IGZvciBhIGNvbW1lbnQgb3IgcHJvbXB0LCBlLmcuIGBgIGBGT09fUExBQ0VIT0xERVJgLCBgQkFSX1BMQUNFSE9MREVSYCBgYC4gKi9cbmZ1bmN0aW9uIGRlc2NyaWJlVG9rZW5zKHRva2VuczogcmVhZG9ubHkgc3RyaW5nW10pOiBzdHJpbmcge1xuICAvLyBFdmVyeSB0b2tlbiBjb21lcyBmcm9tIGVpdGhlciB0aGUgc3RyaWN0IGBbQS1aXVtBLVowLTlfXSpfKD86UExBQ0VIT0xERVJ8XG4gIC8vIFBFTkRJTkd8VEJEfFRPRE8pYCBzdWZmaXggcmVnZXggb3IgdGhlIHN0cnVjdHVyYWwgYmFja3N0b3Anc1xuICAvLyBgW0EtWl1bQS1aMC05XSooPzpfW0EtWjAtOV0rKStgIGlkZW50aWZpZXIsIHNvIGV2ZXJ5IG5hbWUgaXNcbiAgLy8gYFtBLVpdW0EtWjAtOV9dKmAg4oCUIHNhZmUgdG8gZWNobyB2ZXJiYXRpbSBpbnRvIE1hcmtkb3duIGFuZCBhIHByb21wdC5cbiAgcmV0dXJuIHRva2Vucy5tYXAoKHRva2VuKSA9PiBgXFxgJHt0b2tlbn1cXGBgKS5qb2luKFwiLCBcIik7XG59XG5cbi8qKlxuICogQnVpbGQgdGhlIGNvbW1lbnQgcG9zdGVkIHdoZW4gdGhlIHJlc3VsdC1wbGFjZWhvbGRlciBnYXRlIGJsb2NrcyBQUlxuICogY3JlYXRpb24uXG4gKlxuICogRXhwbGFpbnMgdGhhdCBhIHBsYWNlaG9sZGVyIHdoZXJlIGEgcmVzdWx0IGJlbG9uZ3MgY291bnRzIGFzIGFuIHVucmVwb3J0ZWRcbiAqIHJlc3VsdCwgYW5kIGFza3MgZm9yIHRoZSBhY3R1YWwgb3V0Y29tZSwgbm90IGEgcmUtZGVyaXZhdGlvbiBvZiB3aGF0IHRoZVxuICogY29tbWFuZCB3YXMgZm9yLlxuICovXG5leHBvcnQgZnVuY3Rpb24gYnVpbGRSZXN1bHRQbGFjZWhvbGRlckdhdGVDb21tZW50KFxuICB0b2tlbnM6IHJlYWRvbmx5IHN0cmluZ1tdLFxuKTogc3RyaW5nIHtcbiAgcmV0dXJuIFtcbiAgICBcIuKaoO+4jyAqKlVuZmlsbGVkIHJlc3VsdCBwbGFjZWhvbGRlci4qKiBUaGUgUFIgc3VtbWFyeSBzdGlsbCBjYXJyaWVzIFwiICtcbiAgICBgJHt0b2tlbnMubGVuZ3RoID09PSAxID8gXCJhIHRva2VuXCIgOiBcInRva2VuKHMpXCJ9IHdoZXJlIGEgY29tbWFuZCdzIGAgK1xuICAgIGByZXN1bHQgYmVsb25nczogJHtkZXNjcmliZVRva2Vucyh0b2tlbnMpfS5gLFxuICAgIFwiXCIsXG4gICAgXCJBIGZpbGwtaW4tbGF0ZXIgdG9rZW4gbGVmdCBpbiBwbGFjZSBvZiBhIHJlc3VsdCBjb3VudHMgYXMgYW4gdW5yZXBvcnRlZCBcIiArXG4gICAgJ3Jlc3VsdCwgbm90IGEgcGFzc2luZyBvbmUg4oCUIGl0IHJlYWRzIGFzIFwidGhlIGdhdGUgd2FzIHJ1blwiIHRvIGFueW9uZSAnICtcbiAgICBcIndobyBkb2VzIG5vdCBrbm93IHRoZSBmbGVldCdzIGludGVybmFsIHZvY2FidWxhcnksIHdoZW4gbm90aGluZyB3YXMgXCIgK1xuICAgIFwiYWN0dWFsbHkgcmVwb3J0ZWQuXCIsXG4gICAgXCJcIixcbiAgICBcIkZvciBlYWNoIHRva2VuIGFib3ZlLCByZS1ydW4gdGhlIGNvbW1hbmQgaXQgc3RhbmRzIGZvciBvbiB0aGUgYnJhbmNoJ3MgXCIgK1xuICAgIFwiZmluYWwgaGVhZCBhbmQgcmVwbGFjZSBpdCB3aXRoIHRoZSBhY3R1YWwgb3V0Y29tZTpcIixcbiAgICBcIlwiLFxuICAgIFwiLSBQYXNzZWQg4oCUIHNheSBzbywgYnJpZWZseS5cIixcbiAgICBcIi0gRmFpbGVkIOKAlCBzYXkgc28sIGFuZCBnaXZlIGl0cyBmaXJzdCBlcnJvci5cIixcbiAgICBcIi0gTm90IHJ1biBhdCBhbGwg4oCUIHNheSB0aGF0IHBsYWlubHkgcmF0aGVyIHRoYW4gbGVhdmluZyB0aGUgdG9rZW4gaW4gXCIgK1xuICAgIFwicGxhY2UuXCIsXG4gIF0uam9pbihcIlxcblwiKTtcbn1cblxuLyoqXG4gKiBCdWlsZCB0aGUgcHJvbXB0IGZvciB0aGUgc2luZ2xlIHJlcGx5LXBhdGggcmVjb3ZlcnkgdHVybiAoSXNzdWUgIzMxMjQpLlxuICpcbiAqIFRlbGxzIHRoZSBhZ2VudCBpdHMgb3duIGAucHJfcmVzcG9uc2VfbWVzc2FnZWAgc3RpbGwgY2FycmllcyB1bnJlc29sdmVkXG4gKiBwbGFjZWhvbGRlciB0b2tlbihzKSwgYW5kIGFza3MgaXQgdG8gcmV3cml0ZSBPTkxZIHRoYXQgZmlsZSB3aXRoIHRoZVxuICogYWN0dWFsIG91dGNvbWUg4oCUIG9yIGEgcGxhaW4gc3RhdGVtZW50IHRoZSBjb21tYW5kIHdhcyBub3QgcnVuIOKAlCBtYWtpbmcgbm9cbiAqIG90aGVyIGNoYW5nZS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGJ1aWxkUmVwbHlQbGFjZWhvbGRlclJldHJ5UHJvbXB0KFxuICB0b2tlbnM6IHJlYWRvbmx5IHN0cmluZ1tdLFxuKTogc3RyaW5nIHtcbiAgcmV0dXJuIGBZb3VyIFxcYC5wcl9yZXNwb25zZV9tZXNzYWdlXFxgIHN0aWxsIGNvbnRhaW5zIHVucmVzb2x2ZWQgcmVzdWx0LXBsYWNlaG9sZGVyIHRva2VuKHMpOiAke1xuICAgIGRlc2NyaWJlVG9rZW5zKHRva2VucylcbiAgfS5cblxuQSBwbGFjZWhvbGRlciBsZWZ0IHdoZXJlIGEgY29tbWFuZCdzIHJlc3VsdCBiZWxvbmdzIHJlYWRzIGFzIGEgY2xhaW0gdGhlIGNvbW1hbmQgcGFzc2VkLCB3aGVuIGluIHRydXRoIG5vdGhpbmcgd2FzIHJlcG9ydGVkIOKAlCB0aGlzIG11c3Qgbm90IHJlYWNoIHRoZSBwdWJsaWMgUFIgY29tbWVudCB1bnJlc29sdmVkLlxuXG5EbyBleGFjdGx5IHRoaXMsIGFuZCBub3RoaW5nIGVsc2U6XG5cbjEuIFJld3JpdGUgT05MWSBcXGAucHJfcmVzcG9uc2VfbWVzc2FnZVxcYCwgcmVwbGFjaW5nIGVhY2ggdG9rZW4gYWJvdmUgd2l0aCB0aGUgYWN0dWFsIG91dGNvbWUgb2YgdGhlIGNvbW1hbmQgaXQgc3RhbmRzIGZvcjogcGFzc2VkIChicmllZmx5KSwgb3IgZmFpbGVkIHdpdGggaXRzIGZpcnN0IGVycm9yLCBvciBzdGF0ZSBwbGFpbmx5IHRoZSBjb21tYW5kIHdhcyBub3QgcnVuLlxuMi4gTWFrZSBubyBvdGhlciBjaGFuZ2Ug4oCUIGRvIG5vdCB0b3VjaCBhbnkgb3RoZXIgZmlsZSwgZG8gbm90IGNyZWF0ZSBhIFBSLCBkbyBub3QgY2xvc2UgdGhlIGlzc3VlLlxuXG5JZiB5b3UgY2Fubm90IGRldGVybWluZSB0aGUgYWN0dWFsIG91dGNvbWUsIHNheSBzbyBwbGFpbmx5IGluIHRoYXQgZmlsZSByYXRoZXIgdGhhbiBsZWF2aW5nIHRoZSB0b2tlbiBpbiBwbGFjZS5gO1xufVxuXG4vKiogTWluaW1hbCBsb2dnZXIgc3VyZmFjZSB0aGUgcmVwbHktcGF0aCByZWNvdmVyeSBoZWxwZXIgbmVlZHMuICovXG5leHBvcnQgaW50ZXJmYWNlIFJlcGx5UGxhY2Vob2xkZXJSZXRyeUxvZ2dlciB7XG4gIHdhcm4obWVzc2FnZTogc3RyaW5nLCBjb250ZXh0PzogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pOiB2b2lkO1xuICBlcnJvcihtZXNzYWdlOiBzdHJpbmcsIGNvbnRleHQ/OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPik6IHZvaWQ7XG59XG5cbi8qKiBJbmplY3RlZCBlZmZlY3RzIGZvciB7QGxpbmsgcmV0cnlSZXBseVBsYWNlaG9sZGVyc09uY2V9LCBzbyBpdCBpcyB1bml0LXRlc3RhYmxlLiAqL1xuZXhwb3J0IGludGVyZmFjZSBSZXBseVBsYWNlaG9sZGVyUmV0cnlEZXBzIHtcbiAgLyoqIFJlYWQgdGhlIGZpbGUncyBjb250ZW50IHdpdGhvdXQgY29uc3VtaW5nIGl0OyBgdW5kZWZpbmVkYCBpZiBtaXNzaW5nLiAqL1xuICByZWFkRmlsZTogKHBhdGg6IHN0cmluZykgPT4gUHJvbWlzZTxzdHJpbmcgfCB1bmRlZmluZWQ+O1xuICAvKiogUmUtaW52b2tlIHRoZSBhZ2VudCBvbmNlIHdpdGggdGhlIGdpdmVuIHByb21wdC4gKi9cbiAgcnVuQWdlbnQ6IChcbiAgICBwcm9tcHQ6IHN0cmluZyxcbiAgKSA9PiBQcm9taXNlPHsgb2s6IGJvb2xlYW47IGVycm9yPzogRXJyb3IgfT47XG4gIC8qKiBPcHRpb25hbCBsb2dnZXIsIHNvIGEgcmV0cnkgKG9yIGl0cyBmYWlsdXJlKSBpcyByZXBvcnRlZCBsb3VkbHkuICovXG4gIGxvZ2dlcj86IFJlcGx5UGxhY2Vob2xkZXJSZXRyeUxvZ2dlcjtcbn1cblxuLyoqIE91dGNvbWUgb2Ygb25lIHJlcGx5LXBhdGggcGxhY2Vob2xkZXItcmVjb3ZlcnkgcGVlay4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgUmVwbHlQbGFjZWhvbGRlclJldHJ5T3V0Y29tZSB7XG4gIC8qKiBXaGV0aGVyIHRoZSBhZ2VudCB3YXMgcmUtaW52b2tlZC4gKi9cbiAgcmV0cmllZDogYm9vbGVhbjtcbiAgLyoqIFRoZSB0b2tlbnMgdGhhdCB0cmlnZ2VyZWQgdGhlIHJldHJ5IChlbXB0eSB3aGVuIGByZXRyaWVkYCBpcyBmYWxzZSkuICovXG4gIHRva2Vuczogc3RyaW5nW107XG59XG5cbi8qKlxuICogUGVlayBhdCB0aGUgcmVwbHkgZmlsZSBmb3IgdW5yZXNvbHZlZCByZXN1bHQtcGxhY2Vob2xkZXIgdG9rZW5zIGFuZCwgaWZcbiAqIGFueSBhcmUgZm91bmQsIHJlLWludm9rZSB0aGUgYWdlbnQgT05DRSB0byByZXdyaXRlIHRoZSBmaWxlIChJc3N1ZSAjMzEyNCkuXG4gKlxuICogVGhpcyBpcyB0aGUgb25lIGluLXJ1biByZWNvdmVyeSB0dXJuIG9uIHRoZSByZXBseSBwYXRoLCBtaXJyb3JpbmdcbiAqIGByZWNvdmVyRnJvbVN1bW1hcnlSdWxlQmxvY2tgIG9uIHRoZSBQUi1jcmVhdGlvbiBwYXRoOiBhIHNpbmdsZSByZXRyeSwgbm90XG4gKiBhIGxvb3AuIFRva2VucyBzdGlsbCBwcmVzZW50IGFmdGVyd2FyZHMgYXJlIGxlZnQgZm9yIHRoZSBmYWlsLWxvdWRcbiAqIGNob2tlcG9pbnQgYmFja3N0b3AgaW4gYHByX2JyYW5jaF9wcmVwYXJhdGlvbi50c2AncyBgcmVhZFByUmVzcG9uc2VNZXNzYWdlYFxuICogdG8gY2F0Y2gg4oCUIHRoaXMgaGVscGVyIGRvZXMgbm90IHJlLWNoZWNrIGFmdGVyIHRoZSByZXRyeSwgc28gYSBmYWlsZWQgb3JcbiAqIGV4aGF1c3RlZCByZWNvdmVyeSBuZXZlciBibG9ja3MgdGhlIGFscmVhZHktc3VjY2Vzc2Z1bCBmZWVkYmFjayBydW4uXG4gKlxuICogQHBhcmFtIHBhdGggLSBUaGUgYC5wcl9yZXNwb25zZV9tZXNzYWdlYCBwYXRoLCByZWFkIHdpdGhvdXQgY29uc3VtaW5nIGl0LlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gcmV0cnlSZXBseVBsYWNlaG9sZGVyc09uY2UoXG4gIHBhdGg6IHN0cmluZyxcbiAgZGVwczogUmVwbHlQbGFjZWhvbGRlclJldHJ5RGVwcyxcbik6IFByb21pc2U8UmVwbHlQbGFjZWhvbGRlclJldHJ5T3V0Y29tZT4ge1xuICBjb25zdCBjb250ZW50ID0gYXdhaXQgZGVwcy5yZWFkRmlsZShwYXRoKTtcbiAgaWYgKGNvbnRlbnQgPT09IHVuZGVmaW5lZCkgcmV0dXJuIHsgcmV0cmllZDogZmFsc2UsIHRva2VuczogW10gfTtcblxuICBjb25zdCB0b2tlbnMgPSBmaW5kUmVzdWx0UGxhY2Vob2xkZXJzKGNvbnRlbnQpO1xuICBpZiAodG9rZW5zLmxlbmd0aCA9PT0gMCkgcmV0dXJuIHsgcmV0cmllZDogZmFsc2UsIHRva2VuczogW10gfTtcblxuICBkZXBzLmxvZ2dlcj8ud2FybihcbiAgICBcIlJlcGx5IGNhcnJpZXMgdW5yZXNvbHZlZCByZXN1bHQtcGxhY2Vob2xkZXIgdG9rZW4ocykg4oCUIHJlY292ZXJpbmcgb25jZSBpbi1ydW4gKElzc3VlICMzMTI0KVwiLFxuICAgIHsgdG9rZW5zIH0sXG4gICk7XG5cbiAgY29uc3QgcmVzdWx0ID0gYXdhaXQgZGVwcy5ydW5BZ2VudChidWlsZFJlcGx5UGxhY2Vob2xkZXJSZXRyeVByb21wdCh0b2tlbnMpKTtcbiAgaWYgKCFyZXN1bHQub2spIHtcbiAgICAvLyBUaGUgY2hva2Vwb2ludCBiYWNrc3RvcCBpbiBgcmVhZFByUmVzcG9uc2VNZXNzYWdlYCBzdGlsbCBhcHBsaWVzIOKAlFxuICAgIC8vIHRoaXMgaXMgbG9nZ2VkLCBub3QgZmF0YWwsIGJlY2F1c2UgdGhlIGZlZWRiYWNrIHJ1bidzIG1haW4gd29yayBoYXNcbiAgICAvLyBhbHJlYWR5IHN1Y2NlZWRlZCBieSB0aGUgdGltZSB0aGlzIHBlZWsgcnVucy5cbiAgICBkZXBzLmxvZ2dlcj8uZXJyb3IoXG4gICAgICBgUmVzdWx0LXBsYWNlaG9sZGVyIHJlcGx5IHJlY292ZXJ5IGludm9jYXRpb24gZmFpbGVkIOKAlCB0aGUgYCArXG4gICAgICAgIGBmYWlsLWxvdWQgY2hva2Vwb2ludCBiYWNrc3RvcCB3aWxsIGFwcGx5IGluc3RlYWQ6ICR7XG4gICAgICAgICAgcmVzdWx0LmVycm9yPy5tZXNzYWdlID8/IFwidW5rbm93biBlcnJvclwiXG4gICAgICAgIH1gLFxuICAgICAgeyB0b2tlbnMgfSxcbiAgICApO1xuICB9XG5cbiAgcmV0dXJuIHsgcmV0cmllZDogdHJ1ZSwgdG9rZW5zIH07XG59XG4iXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUE7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0NBc0NDLEdBRUQsU0FBUyxnQkFBZ0IsUUFBUSwyQkFBMkI7QUFFNUQsMEVBQTBFLEdBQzFFLE1BQU0saUJBQWlCO0FBRXZCLHFFQUFxRSxHQUNyRSxNQUFNLG1CQUFtQjtBQUV6Qjs7Ozs7OztDQU9DLEdBQ0QsTUFBTSx1QkFDSjtBQUVGLHNEQUFzRCxHQUN0RCxNQUFNLGtCQUNKO0FBRUYsK0ZBQStGLEdBQy9GLE1BQU0scUJBQXFCO0FBRTNCOzs7OztDQUtDLEdBQ0QsTUFBTSwwQkFBMEI7RUFBQztFQUFLO0VBQUs7RUFBUTtFQUFPO0NBQUk7QUFFOUQsK0VBQStFLEdBQy9FLFNBQVMsZ0JBQWdCLFVBQWtCLEVBQUUsVUFBa0I7RUFDN0QsSUFBSSxTQUFTLENBQUM7RUFDZCxJQUFJLFlBQVksQ0FBQztFQUVqQixNQUFNLFFBQVEsV0FBVyxXQUFXLENBQUM7RUFDckMsSUFBSSxVQUFVLENBQUMsR0FBRztJQUNoQixTQUFTO0lBQ1QsWUFBWSxRQUFRO0VBQ3RCO0VBRUEsS0FBSyxNQUFNLE9BQU8sd0JBQXlCO0lBQ3pDLE1BQU0sS0FBSyxXQUFXLFdBQVcsQ0FBQztJQUNsQyxJQUFJLE1BQU0sY0FBYyxLQUFLLFFBQVE7TUFDbkMsU0FBUztNQUNULFlBQVksS0FBSyxJQUFJLE1BQU07SUFDN0I7RUFDRjtFQUVBLE9BQU87QUFDVDtBQVlBOzs7Ozs7Ozs7Ozs7Ozs7Q0FlQyxHQUNELFNBQVMsaUJBQWlCLElBQVk7RUFDcEMsTUFBTSxTQUFTLGlCQUFpQjtF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
// denoCacheMetadata=1554269477767337270,1839558213950592680