/**
 * Secret redaction for log output (Issue #2417).
 *
 * Self-audit finding: the worker's logger interpolated message and context
 * values verbatim into stderr (captured into worker-*.log and CI output).
 * Any secret that reached a `logger.*` call — most plausibly a tokenised git
 * clone URL inside a `git`/`gh` error string, or a logged tail of external
 * command output — would have leaked into those logs.
 *
 * `redactSecrets` is the single chokepoint that masks known secret shapes
 * before any bytes are written. It is wired into the logger's write path
 * (see `logger.ts`) so redaction is defence-in-depth: it applies regardless
 * of which caller produced the string.
 *
 * It also guards the **inbound** side (Issue #1424): the untrusted-text
 * ingestion chokepoint `sanitiseDelimiterPatterns` (see `prompt_delimiter.ts`)
 * redacts before it scrubs, so a credential quoted in an issue body, a
 * comment, a repository guidance document or the codebase map is masked
 * before it becomes part of the model's context — not only before the
 * model's own output reaches a sink.
 *
 * Design notes:
 *  - Patterns are deliberately specific (fixed prefixes, minimum lengths,
 *    structural anchors like `user:pass@host`) so ordinary log text — issue
 *    numbers, durations, file paths, prose — is never altered.
 *  - Redaction never throws: a malformed input simply returns unchanged.
 *  - Every pattern must be **linear** in the input length (Issue #3942).
 *    `redactSecrets` runs synchronously on the main thread over
 *    attacker-influenced text (model stdout, subprocess output), so a
 *    backtracking pattern stalls the whole event loop. Any quantifier over a
 *    broad character class is therefore bounded or anchored on a literal.
 *    Note the input itself is deliberately **not** truncated: the
 *    redact-before-truncate standard (SECURITY.md) requires redaction to cover
 *    the whole text, so a scan cap would silently leave the tail unmasked.
 *
 *  - Signature rules only see the secret's *original* bytes, so a credential
 *    put through `base64`, `xxd` or `rev` — or split across two `echo` calls
 *    — matched nothing (Issue #188). `redactTransformedSecrets` closes that
 *    by decoding candidate runs and re-scanning them with the same rules;
 *    see `secret_transform_redaction.ts`.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { redactTransformedSecrets } from "./secret_transform_redaction.ts";

/**
 * The `secret-assignment` rule's pattern, named so detection and replacement
 * share one literal (Issue #1727). See the rule in `RULES` for what each group
 * means and why every quantifier is bounded.
 */
const SECRET_ASSIGNMENT_PATTERN =
  /\b([A-Za-z0-9_]{0,63}(?:TOKEN|SECRET|PASSWORD|PASSWD|API[_-]?KEY|APIKEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|CREDENTIAL)[A-Za-z0-9_]{0,63})(["']?[*`>]{0,3}\s*(?::|(?<!>)=)(?:[*_]{1,3}(?=\s))?\s*)(?!\s)(?!["']?\*\*\*REDACTED)(?![{[])(?!\$\{\{)(?!(?:true|false|null|none|yes|no|on|off|read|write|inherit)(?![A-Za-z0-9_\-./+=@]))(?!(?:-?\d{1,20}(?:\.\d{1,20})?(?:[eE][+-]?\d{1,4})?|true|false|null)\s{0,32}[,}\]])((?=\S{0,63}[A-Za-z0-9])(?:"(?:[^"\\]|\\[^]){1,4096}"|'(?:[^'\\]|\\[^]|''|'\\''){1,4096}'|"[^"]+"|'[^']+'|[^\s"]+)|"(?=[^"]{0,255}[A-Za-z0-9])(?:(?:[^"\\]|\\[^]){1,4096}"|[^"]+"|[^"\n\r\u2028\u2029]+)|'(?=[^']{0,255}[A-Za-z0-9])(?:(?:[^'\\]|\\[^]|''|'\\''){1,4096}'|[^']+'))/gi;

/** Replacement token substituted in place of a detected secret. */
export const REDACTION_PLACEHOLDER = "***REDACTED***";

/**
 * A credential flag's value as the `secret-cli-flag` rule reads it, shared by
 * that rule, `CLI_FLAG_AT` and `CLI_FLAG_RULE_G` so the walk and rule share
 * the initial value extent (Issue #5435). The quoted branches accept
 * an escaped quote of their own kind as `SECRET_ASSIGNMENT_PATTERN` does
 * (Issue #5327): a backslash pair in either quote kind, and in single quotes a
 * doubled `''` or the shell `'\''` idiom. Each escape-aware branch is bounded
 * at 4,096 characters or escapes and the alternatives are told apart by their
 * first two characters, so it stays linear (Issue #3942). A longer value, or
 * one whose escape never closes (`"C:\dir\"`), falls back to the old branches
 * that end at the first quote. If a later flag opens its quoted value at
 * the apparent closing quote, throughFollowingFlag masks the overlap. The CLI
 * replacement then preserves a trailing credential flag name with a value so
 * the next scan masks that value too.
 */
const CLI_FLAG_VALUE = String
  .raw`(?:"(?:[^"\\]|\\[^]){1,4096}"|'(?:[^'\\]|\\[^]|''|'\\''){1,4096}'|"[^"]+"|'[^']+'|\S+)`;

/**
 * A single redaction rule: a pattern and the replacement applied to each
 * match. The `replace` callback receives the standard `String.replace`
 * arguments so a rule can preserve a non-secret prefix (e.g. the `Bearer `
 * scheme or a `TOKEN=` key) while masking only the secret portion.
 *
 * A rule whose verdict on one match depends on the matches around it supplies
 * a whole-text `apply` and its matching `detect` instead (Issue #5310): the
 * `secret-assignment` rule, whose walk gives an outer candidate up for the
 * credential label inside it. One implementation serves both, so
 * `redactSecrets` and `containsSecret` cannot disagree.
 */
type RedactionRule =
  | {
    readonly name: string;
    readonly pattern: RegExp;
    readonly replace: (match: string, ...groups: string[]) => string;
  }
  | {
    readonly name: string;
    readonly apply: (text: string) => string;
    readonly detect: (text: string) => boolean;
  };

/**
 * The complete Markdown a cross-line assignment value can be, and no
 * credential ever is (Issue #1727).
 *
 * Both alternatives match the **whole** value, and both are consulted only
 * when the separator crossed a line break. Neither restriction is cosmetic —
 * an earlier pass had this as a *prefix* test applied on any line, and that
 * turned the chokepoint off: `SECRET: ```<40-char AWS key>``` ` and
 * `API_KEY=![<key>` were published verbatim, because a value merely *opening*
 * with a fence or an image was excluded whatever followed it. A fence line
 * carries at most a language tag; an inline image closes its own brackets; a
 * credential does neither.
 *
 * Every alternative is anchored at both ends with no nested quantifier, so
 * the test is linear in the value length (the Issue #3942 linearity rule).
 */
const FENCE_VALUE = /^(?:`{3,}|~{3,})[A-Za-z0-9_+#-]*$/;

/** A complete inline image — `![alt](path)` — as the whole value. */
const IMAGE_VALUE = /^!\[[^\][]*\]\([^()]*\)$/;

/**
 * A value in matching quotes: explicit assignment syntax, not prose. It accepts
 * the same escaped quotes as the pattern (Issue #5327), so a masked escaped
 * value keeps its quotes around the placeholder.
 */
const QUOTED_VALUE =
  /^(?:"(?:[^"\\]|\\[^]){0,4096}"|'(?:[^'\\]|\\[^]|''|'\\''){0,4096}'|"[^"]*"|'[^']*')$/;

/**
 * A single word with no digit, symbol or internal capital — the shape of an
 * English sentence's first word.
 *
 * The length is **bounded**, and that bound is the rule (Issue #1727): an
 * unbounded `[a-z]*` let a lower-case passphrase such as
 * `correcthorsebatterystaple` pass as "a plain word" however long it ran,
 * which is a credential shape, not a prose shape. Fifteen characters covers
 * the words English sentences actually open with.
 */
const PLAIN_WORD = /^[A-Za-z][a-z]{0,14}$/;

/** Emphasis markers wrapping a value: at most `***`, so the strip is linear. */
const LEADING_EMPHASIS = /^[*_]{1,3}/;

/** The closing half of {@link LEADING_EMPHASIS}, bounded for the same reason. */
const TRAILING_EMPHASIS = /[*_]{1,3}$/;

/**
 * Shortest cross-line value still treated as a credential.
 *
 * Eight characters is shorter than anything a credential generator emits, and
 * long enough to spare what prose actually opens a line with — `The`, `A`,
 * `When`, `(see`, `It's`, `1.`, and an inline-code span such as `` `inline ``,
 * whose value stops at the first space. A floor of six was tried and put back:
 * it masked the opening of every sentence that began with a code span, which
 * is the same class of defect as the fence this issue is about.
 *
 * The floor applies only across a line break, so an inline `PASSWORD=12345` is
 * unaffected. A credential shorter than eight characters sitting alone on the
 * line *after* its label is the accepted cost, and it is the cost the issue
 * asked for ("minimum length"). A credential that short still carrying a
 * provider prefix is masked by its own signature rule regardless.
 */
const MIN_CROSS_LINE_LENGTH = 8;

/**
 * A bare mapping key — `DEPLOY_TOKEN:` — captured as the value of a parent key
 * that ended its line (`secrets:`). Across a line break that is YAML
 * structure, the parent's first child, never a credential. Bounded and
 * anchored, so it is constant work per candidate (the Issue #3942 linearity
 * rule).
 *
 * A credential-labelled child key (`API_TOKEN:`) whose own value is masked
 * never reaches this test: `walkAssignments` gives the parent up for the child
 * (Issue #5310), so the scan reaches the child and judges the child's value.
 */
const MAPPING_KEY_VALUE = /^[A-Za-z0-9_.-]{1,128}:$/;

/** Characters that end a line, so a value found past one is on a later line. */
const LINE_TERMINATOR = /[\n\r\u2028\u2029]/;

/**
 * The separator of a prose heading: a bare colon then spaces, on one line
 * (Issue #5253). No quote, no `=` and no line break, so only `Name: text` reads
 * as a heading. Up to three Markdown emphasis, code-span or `>` markers before
 * the colon and up to three emphasis (`*` or `_`) markers after it are
 * rendering, not text, so `**TokenBudget:** text` and
 * `**TokenBudget**: text` read as headings too (Issue #5326).
 */
const PROSE_HEADING_SEPARATOR = /^[*`>]{0,3}:[*_]{0,3}[ \t]{1,32}$/;

/**
 * A Capitalised word or a PascalCase run of them, letters only: the shape of a
 * product name used as a heading, such as `TokenBudget` (Issue #5253).
 * Bounded on both counts, so it is linear (the Issue #3942 rule).
 */
const PROSE_HEADING_KEY = /^(?:[A-Z][a-z]{1,31}){1,8}$/;

/**
 * A key that ends in a credential word, whatever its case: `GithubToken`,
 * `ApiKey`, `ClientSecret`, `SecretValue`, and equally `Userpassword`,
 * `Accesskey` or `Authtoken` (Issue #5253). The key's ending decides, not its
 * last capitalised word, so a lower-case suffix cannot hide the credential
 * word. Anchored at the end and a fixed alternation, so it is linear.
 */
const CREDENTIAL_KEY_ENDING =
  /(?:tokens?|secrets?|passwords?|passwd|keys?|credentials?|values?)$/i;

/**
 * A key ending in the plural of a credential word: `Tokens`, `Secrets`,
 * `Passwords`. Under Markdown emphasis it labels a count or a list, as in the
 * run-stats line `- **Tokens:** input 27 · output 11` (the worker's run-stats comment line, pinned in
 * `worker/deno/tests/secret_redaction_test.ts`), not one
 * credential (Issue #5326), provided a further token follows the value on the
 * line ({@link PLURAL_CONTINUATION}). A singular `GithubToken` is not matched,
 * and neither is an unmarked `Tokens: input 27`.
 */
const PLURAL_CREDENTIAL_KEY_ENDING =
  /(?:tokens|secrets|passwords|keys|credentials|values)$/i;

/**
 * Text after a marked plural heading's value: spaces then any further
 * non-space token on the same line (Issue #5326), so a number or a `·` counts.
 * Bounded, so it is linear.
 */
const PLURAL_CONTINUATION = /^[ \t]{1,32}\S/;

/** A Markdown marker in a separator: the heading is rendered (Issue #5326). */
const SEPARATOR_MARKER = /[*_`>]/;

/**
 * Text after a prose heading's value: spaces then a further word on the same
 * line (Issue #5253). A heading leads into a sentence; a `Key: word` that ends
 * its line is a field, so it stays masked. Bounded, so it is linear.
 */
const PROSE_CONTINUATION = /^[ \t]{1,32}[A-Za-z]/;

/** How much text after a value {@link PROSE_CONTINUATION} needs to see. */
const PROSE_CONTINUATION_SPAN = 33;

/**
 * Report whether a matched `secret-assignment` value is credential-shaped
 * (Issue #1727).
 *
 * The rule's separator spans line breaks (it ends in `\s*`), so a prose
 * line ending in a credential-ish label adopted the *next* non-blank line as
 * the assignment's value. A PR body whose lead-in read
 * `… now picks a credential:` had the Mermaid fence on the following line
 * published as the placeholder, and the diagram `CODING-STANDARDS.md` requires
 * stopped rendering; the prose variant masked a sentence's first word.
 *
 * The label side of the rule is deliberately blunt and stays that way — it
 * catches real secrets. The one exception is a prose heading (Issue #5253),
 * whose key is read only by {@link isProseHeading}. Apart from that check, only
 * the value is judged, and only when the separator crossed a line break.
 * **An inline assignment is masked exactly as before**, bar a prose heading:
 * `secret_scanning: enabled`, `PASSWORD=12345` and a value wrapped in
 * backticks, or opening with `#`, `>` or `|` — all legitimate password
 * characters — are untouched by this predicate. That boundary is load-bearing:
 * judging inline values too is what let a fence-wrapped secret through. The
 * one inline exception, a prose heading (Issue #5253), is decided before this
 * predicate by {@link isProseHeading}.
 *
 * Across a line break the value must earn the mask: complete Markdown
 * ({@link FENCE_VALUE}, {@link IMAGE_VALUE}) and a child mapping key
 * ({@link MAPPING_KEY_VALUE}) never do, a quoted value always
 * does, and anything else needs {@link MIN_CROSS_LINE_LENGTH} characters and a
 * shape that is not a {@link PLAIN_WORD}.
 *
 * Exported for direct boundary tests; {@link assignmentIsMasked} is its only
 * caller in this module.
 *
 * @param value - The value the `secret-assignment` rule captured.
 * @param sameLine - True when the separator did not cross a line break.
 * @returns True when the value should be replaced with the placeholder.
 */
export function isCredentialShapedValue(
  value: string,
  sameLine: boolean,
): boolean {
  if (sameLine) return true;
  if (FENCE_VALUE.test(value) || IMAGE_VALUE.test(value)) return false;
  if (MAPPING_KEY_VALUE.test(value)) return false;
  if (QUOTED_VALUE.test(value)) return true;
  if (value.length < MIN_CROSS_LINE_LENGTH) return false;
  // Emphasis markers belong to the rendering, not to the value inside them.
  // The length floor above is measured on the whole value, so stripping them
  // cannot drop a long value under it.
  const scalar = value.replace(LEADING_EMPHASIS, "").replace(
    TRAILING_EMPHASIS,
    "",
  );
  return !PLAIN_WORD.test(scalar);
}

/**
 * Report whether an assignment is a product name used as a prose heading
 * (Issue #5253), so the rule must not mask the word after its colon.
 *
 * A heading such as `TokenBudget: run the agreed trial` names a product, and
 * its name does not end in a credential word. A credential field's name does
 * (`GithubToken`, `Password`, `Userpassword`), and those stay masked whatever
 * the value, with one exception: under Markdown markers a key ending in a
 * plural credential noun (`**Tokens:** input 27 · output 11`, Issue #5326) is
 * a heading for a count or list, and needs a further non-space token after the
 * value ({@link PLURAL_CONTINUATION}), so `**Passwords:** sunshine` ending its
 * line stays masked. Otherwise all four must hold: a bare colon, a Capitalised
 * key not ending in a credential word, a plain single word as the value, and a
 * further word after it on the same line (`following` is the text after the
 * value). So a value
 * with a digit, symbol, quote or over 15 letters is still masked under any key,
 * as is a `Key: word` that ends its line (`SecretString: hunter`), and so are
 * `=`, quoted keys, `_` keys and lower-camel identifiers.
 */
function isProseHeading(
  key: string,
  sep: string,
  value: string,
  following: string,
): boolean {
  if (!PROSE_HEADING_SEPARATOR.test(sep)) return false;
  if (!PROSE_HEADING_KEY.test(key)) return false;
  // A plural credential noun under Markdown markers is a heading for a count
  // or a list (the worker's run-stats comment line `- **Tokens:** input 27`): a number or symbol,
  // not only a word, may follow the plain word, but something must.
  const markedPlural = SEPARATOR_MARKER.test(sep) &&
    PLURAL_CREDENTIAL_KEY_ENDING.test(key);
  if (CREDENTIAL_KEY_ENDING.test(key) && !markedPlural) return false;
  if (!PLAIN_WORD.test(value)) return false;
  return markedPlural
    ? PLURAL_CONTINUATION.test(following)
    : PROSE_CONTINUATION.test(following);
}

/** The bounded run of `text` after a match ending at `end` (Issue #5253). */
function textAfter(text: string, end: number): string {
  return text.slice(end, end + PROSE_CONTINUATION_SPAN);
}

/**
 * Apply {@link isCredentialShapedValue} to one `secret-assignment` match.
 *
 * The single place the separator's shape is turned into a `sameLine` verdict,
 * so the replacement pass and {@link matchesSignatureRule} cannot drift apart
 * (Issue #1727). A prose heading is not an assignment at all, so
 * {@link isProseHeading} exempts it first (Issue #5253); `following` is the
 * text after the value, cut to {@link PROSE_CONTINUATION_SPAN} by
 * {@link textAfter}.
 */
function assignmentIsMasked(
  key: string,
  sep: string,
  value: string,
  following: string,
): boolean {
  if (isProseHeading(key, sep, value, following)) return false;
  return isCredentialShapedValue(value, !LINE_TERMINATOR.test(sep));
}

/** Shortest wrap width the PEM-body fallback treats as a "long" line. */
const PEM_BODY_LINE_MIN = 40;

/**
 * Longest wrap width the PEM-body fallback will scan. A ReDoS ceiling,
 * not a PEM convention: real wrapping sits at 48–76.
 */
const PEM_BODY_LINE_MAX = 128;

/** One physical line inside a candidate PEM-body run. */
interface PemBodyLine {
  readonly raw: string;
  readonly payloadLen: number;
  readonly hasPadding: boolean;
  readonly newline: string;
  readonly isBase64: boolean;
}

/**
 * Split `text` into physical lines, keeping each line's ending so a
 * reconstructed span is byte-identical to the input when nothing is
 * redacted.
 */
function splitLinesKeepEndings(text: string): string[] {
  const lines: string[] = [];
  const re = /[^\r\n]*\r?\n|[^\r\n]+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    lines.push(m[0]);
  }
  return lines;
}

/** Classify a physical line as a (possibly padded) base64 payload. */
function parsePemBodyLine(raw: string): PemBodyLine {
  let newline = "";
  let content = raw;
  if (raw.endsWith("\r\n")) {
    newline = "\r\n";
    content = raw.slice(0, -2);
  } else if (raw.endsWith("\n")) {
    newline = "\n";
    content = raw.slice(0, -1);
  }
  const m = /^([A-Za-z0-9+/]+)(={0,2})$/.exec(content);
  if (!m) {
    return {
      raw,
      payloadLen: 0,
      hasPadding: false,
      newline,
      isBase64: false,
    };
  }
  const payload = m[1] ?? "";
  const padding = m[2] ?? "";
  return {
    raw,
    payloadLen: payload.length,
    hasPadding: padding.length > 0,
    newline,
    isBase64: payload.length > 0,
  };
}

/**
 * Redact uniform PEM-shaped runs inside a candidate span (Issue #196).
 *
 * A run is two or more consecutive base64 lines of the same width
 * `W` (40–128) followed by a final line of width 1..W with optional
 * `=` / `==` padding. Ragged (non-uniform) long lines are left intact,
 * including any uniform sub-run that does not meet that shape.
 */
function redactUniformPemBodyRuns(text: string): string {
  const parsed = splitLinesKeepEndings(text).map(parsePemBodyLine);
  if (parsed.length === 0) return text;

  const out: string[] = [];
  let i = 0;
  while (i < parsed.length) {
    const start = parsed[i];
    if (
      !start ||
      !start.isBase64 ||
      start.hasPadding ||
      start.payloadLen < PEM_BODY_LINE_MIN ||
      start.payloadLen > PEM_BODY_LINE_MAX ||
      start.newline === ""
    ) {
      out.push(start?.raw ?? "");
      i++;
      continue;
    }

    const width = start.payloadLen;
    let j = i + 1;
    while (j < parsed.length) {
      const next = parsed[j];
      if (
        !next ||
        !next.isBase64 ||
        next.hasPadding ||
        next.payloadLen !== width ||
        next.newline === ""
      ) {
        break;
      }
      j++;
    }
    const fullCount = j - i;
    const last = parsed[j];
    const lastIsPartial = !!last && last.isBase64 &&
      last.payloadLen >= 1 &&
      last.payloadLen <= width &&
      last.payloadLen <= PEM_BODY_LINE_MAX;

    if (fullCount >= 2 && lastIsPartial && last) {
      // The pattern does not consume a newline after the final payload,
      // so keep that ending (if any) visible after the placeholder.
      out.push(REDACTION_PLACEHOLDER + last.newline);
      i = j + 1;
      continue;
    }
    if (fullCount >= 3) {
      const tail = parsed[j - 1];
      out.push(REDACTION_PLACEHOLDER + (tail?.newline ?? ""));
      i = j;
      continue;
    }

    out.push(start.raw);
    i++;
  }
  return out.join("");
}

/**
 * Ordered redaction rules. URL-credential rules run before the bare-token
 * rules so the host/path of a tokenised URL stays visible after the embedded
 * token is masked.
 */
const RULES: readonly RedactionRule[] = [
  // Multi-line PEM private-key block (Issue #3203). Highest-value secret:
  // the GitHub App private key mints installation tokens for every repo the
  // App can reach. Masked whole (BEGIN..END, any key type) BEFORE the other
  // rules so a pasted PEM never survives the chokepoint — e.g. into a public
  // issue comment via the question-answer path.
  {
    name: "pem-private-key",
    // The END marker is optional (Issue #3707): a tail cut mid-key, or a log
    // line that only echoed the head of the file, left the body unmasked
    // because the rule demanded both markers. Without an END the match runs
    // to the end of the text.
    pattern:
      /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
    replace: () => REDACTION_PLACEHOLDER,
  },
  // Bare PEM body with no markers at all (Issue #3707 / #196). A key can
  // reach a log sink stripped of its header — a truncated tail, a `grep` of
  // the file, a JSON-escaped value split across lines. The signal is two or
  // more consecutive *long uniform* base64 lines plus a final (possibly
  // padded) line — not a hard-coded wrap width. PEM is wrapped at 64, 76
  // (MIME), 72, 48 and other widths; ordinary base64 in logs is a single
  // short line, so patch blobs, hashes, ragged lines and prose stay intact.
  //
  // Line width is bounded (Issue #3942): an unbounded `{40,}` on a 500 kB
  // single-line blob backtracks from every start position. 128 is well
  // above any wrap in circulation. Uniformity is asserted in the replace
  // callback so the pattern itself stays linear and cannot ReDoS on a
  // backreference-style "same length" construction.
  {
    name: "pem-body-block",
    pattern: /(?:[A-Za-z0-9+/]{40,128}\r?\n){2,}[A-Za-z0-9+/]{1,128}={0,2}/g,
    replace: (match: string) => redactUniformPemBodyRuns(match),
  },
  // Credentials embedded in a URL: scheme://user:secret@host/path.
  // Keep scheme, the username, and host/path; mask only the password/token.
  //
  // The scheme run is bounded (Issue #3942). Unbounded, `[a-z0-9+.-]*` was
  // greedy, unanchored and — under `/i` — covered the whole ASCII alphanumeric
  // class, so every start position in a long alphanumeric run consumed the
  // remainder and backtracked looking for `://`: quadratic, and enough to
  // freeze the single-threaded worker on ~500 kB of model output. No real
  // URL scheme approaches 64 characters.
  {
    name: "url-userinfo",
    pattern: /([a-z][a-z0-9+.-]{0,63}:\/\/)([^/\s:@]+):([^/\s@]+)@/gi,
    replace: (_m, scheme: string, user: string) =>
      `${scheme}${user}:${REDACTION_PLACEHOLDER}@`,
  },
  // GitHub fine-grained personal access token.
  {
    name: "github-fine-grained-pat",
    pattern: /github_pat_[A-Za-z0-9_]{20,}/g,
    replace: () => REDACTION_PLACEHOLDER,
  },
  // GitHub classic tokens: ghp_ / gho_ / ghu_ / ghs_ / ghr_ + >=36 base62.
  {
    name: "github-token",
    pattern: /gh[pousr]_[A-Za-z0-9]{36,}/g,
    replace: () => REDACTION_PLACEHOLDER,
  },
  // Anthropic API key.
  {
    name: "anthropic-key",
    pattern: /sk-ant-[A-Za-z0-9_-]{20,}/g,
    replace: () => REDACTION_PLACEHOLDER,
  },
  // OpenAI / Codex API key (Issue #36). `OPENAI_API_KEY` and `CODEX_API_KEY`
  // are live secrets handed to the Codex child (see `codex_env.ts`), but until
  // this rule existed a bare key was masked only when it happened to sit in a
  // recognised structure — an env assignment, a `--api-key` flag or a Bearer
  // header. The shape that actually leaks has no structure at all: a CLI
  // echoing the rejected key into stderr, or an exception message carrying it
  // into a stack frame. Covers the classic `sk-` form and the project-scoped
  // `sk-proj-` variant (plus `sk-svcacct-` / `sk-admin-`, same charset).
  //
  // Ordering matters: this rule runs *after* `anthropic-key`, which owns the
  // overlapping `sk-ant-` prefix. By the time this pattern sees the text an
  // Anthropic key is already the placeholder — which contains no `sk-` — so
  // each key yields exactly one substitution and placeholders never nest.
  //
  // Bounded at both ends (Issue #3942). The 20-character minimum and the `\b`
  // anchor keep ordinary hyphenated prose (`task-sk-notes`) from matching; the
  // 512 ceiling keeps the quantifier explicitly bounded and is roughly three
  // times the longest real `sk-proj-` key, so no genuine key is split.
  {
    name: "openai-key",
    pattern: /\bsk-[A-Za-z0-9_-]{20,512}/g,
    replace: () => REDACTION_PLACEHOLDER,
  },
  // Google / Gemini API key (Issue #36). `GEMINI_API_KEY` / `GOOGLE_API_KEY`
  // reach the Gemini child (see `gemini_env.ts`) and leak in the same bare
  // shape as the OpenAI key above. Google's format is a fixed 39 characters —
  // the `AIzaSy` prefix plus 33 charset characters — so the quantifier is an
  // exact count and is bounded by construction. The fixed length is also what
  // keeps the rule off ordinary text: a shorter `AIzaSy…` fragment is left
  // alone.
  {
    name: "google-api-key",
    pattern: /\bAIzaSy[A-Za-z0-9_-]{33}/g,
    replace: () => REDACTION_PLACEHOLDER,
  },
  // Google OAuth access token (Issue #5339). The worker provisions a Google
  // account login (`oauth_creds.json`) into the home the Gemini child reads,
  // and a failing child can echo the bearer token. Access tokens carry the
  // fixed `ya29.` prefix followed by a URL-safe body; the body is bounded
  // ({20,2048}) so a long run cannot rescan, and the 20-character floor plus
  // the leading word boundary keep the rule off prose such as a short `ya29.` fragment.
  {
    name: "google-oauth-access-token",
    pattern: /\bya29\.[A-Za-z0-9_.-]{20,2048}/g,
    replace: () => REDACTION_PLACEHOLDER,
  },
  // Google OAuth refresh token (Issue #5339). Refresh tokens start `1//0`
  // and run on in URL-safe characters. `1//0` is short and slash-heavy, so
  // the lookbehind refuses a start inside a longer word or path (a URL
  // `…/1//0…` or `a1//0…`), the body is bounded ({20,512}) and the 20-character
  // floor leaves short fragments such as `1//0abc` alone.
  {
    name: "google-oauth-refresh-token",
    pattern: /(?<![A-Za-z0-9_\/-])1\/\/0[A-Za-z0-9_-]{20,512}/g,
    replace: () => REDACTION_PLACEHOLDER,
  },
  // AWS secret access key, anchored to the access-key id that precedes it.
  //
  // The id has a fixed shape and is matched on its own below; the SECRET has
  // none — it is 40 characters of base64 alphabet, the same shape as any
  // hash or blob — so matching it bare would redact ordinary text. What is
  // reliable is the pair: AWS hands the two out together, and every leak
  // shape carries them together too. The credentials CSV AWS itself issues
  // is the canonical one:
  //
  //     User name,Access key ID,Secret access key
  //     svc,AKIAIOSFODNN7EXAMPLE,wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY
  //
  // The `AWS_SECRET_ACCESS_KEY=…` and `"aws_secret_access_key": "…"` forms
  // are already covered by `secret-assignment` below; this rule is for the
  // secret standing on its own beside its id.
  //
  // MUST precede `aws-access-key-id`: that rule replaces the anchor with the
  // placeholder, and an anchor that is gone matches nothing.
  //
  // The window is bounded (the Issue #3942 linearity rule) and the value is
  // excluded from being pure lowercase hex — a git commit SHA is exactly 40
  // hex characters and appears beside redacted material constantly.
  //
  // Issue #3857: in JSON-encoded or escaped text the secret follows a literal
  // `\n`, `\r` or `\t`, so the escape letter abuts it and `\b` never fires.
  // Only those three escapes are accepted, so a word glued to 40 characters
  // is still not a match.
  //
  // Issue #4103: `\b` also fails beside `/` and `+`, which are secret
  // characters but not word characters, so a secret starting or ending in one
  // was left verbatim. Lookarounds over the secret alphabet replace `\b`. The
  // context class omits `=` to preserve `id=secret` and `secret=…`. The
  // old `\b` fired beside `=` only next to a word character. Two guards
  // keep separator lines after an id from being mistaken for secrets: one
  // rejects a leading `=`, the other a candidate made only of `/`, `+` and `=`
  // (a `+====+` border, a `//====` banner, a run of 40 `/`). Real secrets
  // always contain an alphanumeric. Every lookaround is constant width (the
  // Issue #3942 linearity rule), and the escape alternative stays because the
  // escape letter is itself an alphabet character.
  //
  // `_` is in both context classes because `\b` treated it as a word
  // character, so a secret glued to `_` stays unmasked as it did for letters
  // and digits. The hex guard needs no inner `\b`: a hex candidate with a
  // class character after it is rejected by the hex guard or the trailing
  // guard alike, so `(?![0-9a-f]{40})` alone gives the same outcome.
  {
    name: "aws-secret-access-key",
    pattern:
      /((?:AKIA|ASIA)[0-9A-Z]{16}[\s\S]{0,120}?)(?:(?<![A-Za-z0-9/+_])|(?<=\\[nrt]))(?![0-9a-f]{40})(?![/+=]{40})(?!=)([A-Za-z0-9/+=]{40})(?![A-Za-z0-9/+_])/g,
    replace: (_m, lead: string) => `${lead}${REDACTION_PLACEHOLDER}`,
  },
  // AWS access key id.
  {
    name: "aws-access-key-id",
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    replace: () => REDACTION_PLACEHOLDER,
  },
  // Bearer token in an Authorization header or similar. Keep the scheme.
  {
    name: "bearer-token",
    pattern: /\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
    replace: (_m, scheme: string) => `${scheme} ${REDACTION_PLACEHOLDER}`,
  },
  // Basic auth credential in an Authorization header (Issue #3427). The value
  // is a base64 blob of `user:token`, so it is matched by no other rule. Keep
  // the scheme; mask the encoded credential. The `{16,}` base64 minimum and
  // the `+/=` character class keep it from matching a plain word such as the
  // prose "Basic authentication".
  {
    name: "basic-auth",
    pattern: /\b(Basic)\s+[A-Za-z0-9+/]{16,}={0,2}/g,
    replace: (_m, scheme: string) => `${scheme} ${REDACTION_PLACEHOLDER}`,
  },
  // Environment-style assignment of a clearly-secret key. Keep the key name
  // and the separator; mask the value. The key must contain a secret-ish
  // word so ordinary `key=value` pairs (e.g. repo=org/repo) are left alone.
  //
  // The separator group tolerates a closing quote and surrounding whitespace
  // (Issue #3707) so the JSON form `"token": "abc"` — the shape of `gh api`
  // output and of `.credentials.json` — matches as well as `TOKEN=abc`.
  //
  // The value must also contain an alphanumeric character (Issue #4004). Every
  // real credential does; a run of pure punctuation does not. Without that
  // requirement the markdown label `- **Tokens:** input 27 …` in the run-stats
  // comment read as key `Tokens`, separator `:` and value `**` — the bold
  // closer — so the placeholder was substituted over the emphasis markers and
  // broke the rendering of every stats comment. The lookahead run is bounded
  // (the Issue #3942 linearity rule): a credential always carries an
  // alphanumeric well inside its first 64 characters, so the bounded scan costs
  // constant time per candidate match.
  //
  // A quoted value is judged inside its quotes (Issue #5329). A letter or
  // digit within its first 256 characters makes it a credential, so a value
  // opening with a space or a symbol-only word, such as `PASSWORD=" hunter2"`
  // or `API_KEY='#! s3cr3t'`, is masked. A double-quoted value with no closing
  // quote is masked to the end of its line. An unterminated single-quoted value
  // is still read as a bare run, as before.
  //
  // A value that opens a JSON object or array is structure, not a credential
  // (Issue #1254). `{"secret_scanning":{"status":"enabled"}}` — the body the
  // repo-hardening path PUTs to enable secret scanning — matched the `\S+`
  // branch, which swallowed the brace and everything after it and left
  // truncated, invalid JSON. Excluding `{` and `[` costs no coverage: a
  // credential never starts with either, and a secret nested inside the object
  // is still masked by this rule's own pass over the inner `"key": "value"`.
  //
  // The separator's `\s*` runs spans line breaks, so a prose line ending in a
  // credential label adopted the *next* line as its value (Issue #1727) — a
  // Mermaid fence was published as the placeholder and the diagram stopped
  // rendering. `isCredentialShapedValue` judges the value before the
  // substitution: Markdown structure is never a credential, and a value the
  // separator reached across a line break must look like one. An inline
  // assignment is unaffected, except a prose heading (Issue #5253, below); the
  // label side stays blunt apart from that check.
  //
  // A product name used as a prose heading is not an assignment (Issue #5253).
  // The PR title for Issue #4959, a product-name heading, had the word after its
  // colon published as the placeholder. When the key is a Capitalised product
  // name that does not end in a credential word (`TokenBudget`, though
  // `GithubToken` and `Userpassword` do), the separator is a bare colon and
  // spaces, the value is one plain word, and a further word follows it on the
  // same line, the mask is lifted by `isProseHeading`. `=`, quoted keys, `_`
  // keys, lower-camel identifiers, a `Key: word` ending its line and any value
  // with a digit, symbol or quote stay masked. One exception to "a key ending in
  // a credential word stays masked": under Markdown markers a plural credential
  // noun (`**Tokens:** input 27 · output 11`, the worker's run-stats comment line)
  // heads a count or list, so it is exempt when a plain word is followed by any
  // further token on the line (Issue #5326); `**Passwords:** sunshine` ending
  // its line stays masked.
  //
  // A bare switch is configuration, not a credential. The
  // `github-actions-audit` idle task filed fourteen issues whose whole
  // instruction was "add `persist-credentials: false`": the key contains
  // CREDENTIAL, so the setting was published as the placeholder, and the
  // bare-value branch took the closing backtick and the full stop with it.
  // `true`, `false`, `null`, `none`, `yes`, `no`, `on` and `off` standing
  // alone as the value are left alone, and so are `read` and `write`: the
  // GitHub Actions permission levels, which every `best-practices` wrapper
  // published as "`id-token: ***REDACTED***`" on 2026-09-24 because the key
  // contains TOKEN (`none`, the third level, was already a switch word).
  // `inherit` (`secrets: inherit`) is workflow syntax of the same kind, and a
  // value opening a `${{ … }}` expression names a secret rather than holding
  // it; the `github-actions-audit` prompt carries both. The
  // inner lookahead requires the word
  // to end there, so `PASSWORD=false-Flag-9f8e` and `API_KEY=no1Secret` are
  // still masked. Both lookaheads are fixed-width alternations — constant
  // work per candidate (the Issue #3942 linearity rule).
  //
  // A label wrapped in Markdown is still a label (Issue #5326). The PR and
  // issue bodies the worker publishes are Markdown, and `**PASSWORD**: <value>`,
  // `**PASSWORD:** <value>`, `` `API_KEY`=<value> `` and `<PASSWORD>: <value>`
  // put emphasis, code-span or angle-bracket markers between the key and its
  // separator, so the rule never matched and the value was published. The
  // separator now allows up to three `*`, backtick or `>` markers before the
  // `:` or `=`, and up to three emphasis (`*` or `_`) markers after it
  // when whitespace follows (so `PASSWORD=**abc**` keeps its value whole and the
  // placeholder never splits a value). Every quantifier is bounded and the
  // adjacent pieces use disjoint classes (the linearity rule in the module header). `=` may not follow
  // `>` directly, so a `>=` comparison (`max_tokens>=limit`) never matches. The
  // accepted limits: a code span that includes the colon (`` `PASSWORD:` value
  // ``) is not matched, because that is how prose names a key (a corpus run
  // over the archived PR summaries showed a backtick after the separator
  // masking the next prose word), so only emphasis is read after the
  // separator; and `<TOKEN>=value`, a `>` straight before `=`, is not matched
  // for that reason. The prose-heading exemption (Issue #5253) and the nested
  // label check (Issue #5310) read the markers as rendering too.
  //
  // A credential label in the value of the label before it is judged as a
  // label, not masked as that value (Issue #5310). In
  // `credentials: DEPLOY_TOKEN = <value>` the bare-value branch stops at
  // whitespace, so the outer match masked only `DEPLOY_TOKEN`, the scan
  // resumed after it, and the real value was published. Issue #5310 left the
  // pattern unchanged; `walkAssignments` makes the decision where the value is
  // judged — see there. That holds within the limits `trailingLabel` and
  // `innerAssignment` apply: the inner separator and value start within
  // `INNER_ASSIGNMENT_SPAN` (256) characters of the outer value's end, a
  // double-quoted inner value that opens with a line break, or holds no letter
  // or digit inside the window, closes within `INNER_QUOTED_MAX` (4,096)
  // characters, the label is at most `INNER_LABEL_MAX` (128) characters, and
  // the embedded-quote case (`DEPLOY_TOKEN='a'b'c <value>'`) is not covered.
  // Past them the base behaviour applies.
  //
  // A quoted value may hold an escaped quote of its own kind (Issue #5327): a
  // backslash pair in either quote kind, and in single quotes a doubled `''` or
  // the shell `'\''` idiom. The quoted branches read through it, so the whole
  // literal is masked; before, they stopped at the escaped quote, masked the
  // leading part and published the rest. Each escape-aware branch is bounded at
  // 4,096 characters or escapes, and the alternatives are told apart by their
  // first two characters, so the pattern stays linear (the linearity rule in
  // the module header). A longer value, or one whose escape never closes
  // (`"C:\dir\"`), falls back to the old branches that end at the first quote,
  // which is the base behaviour. A backslash is read as an escape in single
  // quotes too, although the shell treats it as literal there; that can mask
  // past a Windows path's trailing backslash up to the next quote, which errs
  // towards masking.
  //
  // A bare value that starts at, or contains, the closing quote of a credential
  // flag's quoted value can keep that quote in front of the placeholder (Issues
  // #5363 and #5456). In `--password 'alpha beta TOKEN='tail` the `TOKEN=` value
  // opens at that quote; masking the quote with the value left `secret-cli-flag`
  // no closing quote, so it masked only `'alpha` and published `beta`. A bare
  // value that contains that quote, as in
  // `--token 'alpha beta credentials: TOKEN='tail`, keeps it when no later quote
  // of that kind survives, or that quote lies past another flag whose value
  // starts outside every mask. The walk keeps the outer label's whole-value mask,
  // and the quote goes in front of the placeholder, so
  // `credentials: TOKEN='tail` becomes `credentials: '***REDACTED***` and the
  // flag rule pairs the quotes. Otherwise the quote is masked with the value
  // and the flag rule pairs with the later quote and masks through it (the
  // Issue #5310 round 13 cases pin that outcome). The quote is kept only when
  // the flag's opening quote lies outside every mask of the walk. A credential
  // label or flag name glued after a kept quote, as in
  // `credentials: x'password: <value>`, stays inside the mask, which is
  // extended through the value it labels (see `maskLeads`).
  //
  // A quoted value whose closing quote is where `secret-cli-flag` opens a
  // credential flag's value is masked through that flag's value (Issue #5457):
  // an unclosed single-quoted value running onto the next line's
  // `--password '...'`, a double-quoted Windows path ending in a backslash, or
  // a quoted message ending in `token:` with text glued to its closing quote.
  // Masking only up to that quote hid the flag's name and published its value.
  //
  // JSON structure survives the mask (Issue #4169's transcript tee is the
  // sink that showed it). Every stream-json line the agent emits carries a
  // `"usage":{"input_tokens":50,...}` block — a key that merely *contains*
  // TOKEN followed by a number — and the `init` line carries
  // `"apiKeySource":"none"`. The bare-value branch was `\S+`, and compact JSON
  // has no whitespace, so the number *and everything after it to the end of
  // the line* became the placeholder; the quoted branch dropped the quotes it
  // matched, leaving a bare word where JSON needs a string. Both left the
  // archived transcript unparsable past its first assistant message, and the
  // per-message usage figures were gone. Three bounded refinements:
  //   - a JSON scalar — a number, `true`, `false` or `null` — followed by the
  //     `,`, `}` or `]` that ends a JSON member is structure, not a credential
  //     (a count under a `*_tokens` key is the everyday case). The scalar's
  //     runs are bounded and the trailing whitespace run is bounded, so the
  //     lookahead is constant work per candidate (Issue #3942). An inline
  //     `PASSWORD=12345` with nothing after it is still masked as before.
  //   - the bare-value branch stops at a double quote, so a real assignment
  //     inside a JSON string — `"text":"export TOKEN=abc"}` — is masked
  //     without eating the string's closing quote and the members after it.
  //   - a value matched *with* its quotes keeps them around the placeholder,
  //     so `"password":"hunter2"` becomes `"password":"***REDACTED***"` and
  //     still parses. The already-redacted lookahead tolerates that opening
  //     quote, so the pass stays idempotent and `containsSecret` stays false
  //     on its own output.
  //   - the key's runs of key characters either side of the credential keyword
  //     are bounded at 63 characters each, as `secret-cli-flag` bounds its
  //     flag-name runs (Issue #5373). Unbounded, the engine retried every
  //     keyword position in a long run that no separator follows and rescanned
  //     the rest of the run each time, which was quadratic (the linearity rule
  //     in the module header), and the decode pass's joined lines reach the
  //     same shape. The accepted limit: a key with more than 63 key characters
  //     before or after its keyword is not matched.
  {
    name: "secret-assignment",
    apply: redactAssignments,
    detect: detectsSecretAssignment,
  },
  // Space-separated CLI flag carrying a secret (Issue #3648). The
  // `secret-assignment` rule above requires an `=` or `:` separator, so a
  // flag-style secret such as `--imgbb-api-key 0123abcd…` (issue_worker.sh
  // passes exactly that shape to `pr-manager`) was matched by no rule at all:
  // the value is a bare hex blob with no provider prefix. Keep the flag name;
  // mask the following token. The value must not itself start with `-` so an
  // adjacent flag (`--token --verbose`) is never mistaken for a secret.
  //
  // A credential flag with a value that an earlier label would capture as its
  // value (`token: --token <value>`, on the same line or the next) is left to
  // this rule by the assignment rule (Issue #5330). So is one whose name ends an
  // earlier label's value after other text (`password: token=--token <value>`).
  // The assignment masks overlapping nested flag values together (Issue #5608).
  // Without that outer mask, keep a trailing credential flag name with a value
  // for this rule's next match, rather than hiding it with the first value.
  //
  // A quoted flag value may hold an escaped quote of its own kind and is masked
  // whole (Issue #5435): before, the value ended at that quote and the rest
  // was published. See `CLI_FLAG_VALUE`.
  //
  // Both flag-name runs are bounded (Issue #3942): unbounded `[A-Za-z0-9-]*`
  // consumed the rest of the text from every `--` position and backtracked
  // looking for the keyword, which is quadratic on a long run of hyphens. No
  // CLI flag name approaches 64 characters either side of the keyword.
  {
    name: "secret-cli-flag",
    apply: redactCliFlags,
    detect: (text) => text.search(CLI_FLAG_RULE_G) !== -1,
  },
  // Bare 32-hex credential — the ImgBB API key shape (Issue #1387). The two
  // rules above catch that key only while it keeps its wrapper: an
  // `--imgbb-api-key <key>` flag or a `VIBE_IMGBB_API_KEY=<key>` assignment.
  // Stripped of both — an upload client echoing the rejected key into an
  // error string, or the key sitting in an `?key=` query parameter — it is a
  // bare hex blob with no provider prefix, and no rule matched it at all.
  // `export_scrub_gate.ts` has treated this exact shape as a credential since
  // it was written; this closes the same gap on the redaction chokepoint.
  //
  // Scoped by length and neighbours so ordinary text survives: exactly 32
  // hex characters with no alphanumeric either side. A 40-hex git SHA, a
  // 64-hex sha256 digest and a dashed UUID all fail that test, and the worker
  // logs those constantly. The fixed `{32}` count is linear by construction
  // (Issue #3942) — there is no quantifier to backtrack over.
  //
  // Case-insensitive (Issue #1605): the rule exists for a credential that
  // has lost every structural clue, and a client that normalises hex to
  // uppercase before interpolating it into a URL or an error string strips
  // the case clue along with the wrapper. The lowercase-only shape let an
  // uppercase rendering of the same key through every rule in this file.
  //
  // Runs last, so a key inside a recognised structure is masked by the
  // structural rule that owns it and this one only sees what is left.
  {
    name: "hex32-credential",
    pattern: /(?<![0-9A-Za-z])[0-9a-f]{32}(?![0-9A-Za-z])/gi,
    replace: () => REDACTION_PLACEHOLDER,
  },
];

/**
 * Report whether `text` matches any signature rule, without rewriting it.
 * This is the scan the decode-then-rescan pass applies to each decoded
 * candidate (Issue #188).
 *
 * Detection goes through `String.prototype.search` rather than
 * `RegExp.prototype.test`: every rule pattern is global, and `test()` would
 * advance and carry `lastIndex` across calls, making the result depend on the
 * previous input. `search` saves and restores `lastIndex`, so the literal rule
 * patterns can be reused as-is. Cloning them through `new RegExp(...)` would
 * do the same job but trips semgrep's `detect-non-literal-regexp` rule, and a
 * dynamically-built regex is the wrong primitive here anyway — the patterns
 * are all hardcoded literals.
 *
 * The `secret-assignment` rule is the one exception: its match is not the
 * whole decision, so it is detected through `detectsSecretAssignment`
 * instead (Issue #1727).
 */
function matchesSignatureRule(text: string): boolean {
  return RULES.some((rule) =>
    "detect" in rule ? rule.detect(text) : text.search(rule.pattern) !== -1
  );
}

/**
 * Detect a `secret-assignment` the replacement pass would actually mask.
 *
 * The pattern alone is no longer the whole decision (Issue #1727), so a
 * pattern-only scan made `containsSecret` disagree with `redactSecrets` — it
 * reported a secret in a PR body whose only "secret" was a Mermaid fence after
 * a `credential:` lead-in. Every candidate is put through
 * `assignmentIsMasked`, the same verdict `redactAssignments` applies.
 *
 * Running *every* rule through `replace` and comparing would answer this too,
 * and it was tried — but it silently narrowed the other rules:
 * `pem-body-block`'s callback legitimately returns its input unchanged for a
 * non-uniform line width, and that had been a detection. The other rules
 * therefore keep their pattern scan; only this one consults its value
 * predicate.
 *
 * `lastIndex` is saved and restored around the walk. The pattern is global and
 * shared with the replacement pass, so a leaked offset would make the next
 * scan depend on this one.
 */
function detectsSecretAssignment(text: string): boolean {
  return walkAssignments(text).some((a) => a.masked);
}

/** One `secret-assignment` candidate and the verdict on it. */
interface AssignmentVerdict {
  readonly index: number;
  readonly end: number;
  readonly key: string;
  readonly sep: string;
  readonly value: string;
  readonly masked: boolean;
}

/**
 * How far past the outer value an inner label's assignment is searched
 * (Issue #5310). A ReDoS ceiling (Issue #3942), not a syntax rule: it bounds
 * the extra scan each candidate costs.
 */
const INNER_ASSIGNMENT_SPAN = 256;

/** Run the shared pattern once from `from`, saving and restoring `lastIndex`. */
function execAssignmentAt(
  text: string,
  from: number,
): RegExpExecArray | null {
  const pattern = SECRET_ASSIGNMENT_PATTERN;
  const resume = pattern.lastIndex;
  pattern.lastIndex = from;
  try {
    const match = pattern.exec(text);
    if (!match) return null;
    const end = pattern.lastIndex;
    const value = match[3]!;
    // Only the quoted fallback that reads beyond the first word widened
    // the assignment span. Keep the established inner-label walk for the
    // original first-word matches.
    const through = /^["']/.test(value) && !/^\S{0,63}[A-Za-z0-9]/.test(value)
      ? throughFollowingFlag(text, end - value.length, end)
      : end;
    if (through > end) {
      match[3] = text.slice(end - value.length, through);
      match[0] = text.slice(match.index, through);
    }
    return match;
  } finally {
    pattern.lastIndex = resume;
  }
}

/**
 * Judge one pattern match with {@link assignmentIsMasked}. A value that is a
 * credential flag with a value after it is not masked; see
 * {@link credentialFlagTakesValueAt}. A value that ends in a credential flag's
 * name with a value after it (`password: token=--token <value>`,
 * `password: abc--token <value>`) ends before the flag's name, see
 * {@link flagSafeAssignmentEnd}, which masks through overlapping flag values.
 */
function verdictOf(text: string, match: RegExpExecArray): AssignmentVerdict {
  const matchEnd = match.index + match[0].length;
  const key = match[1] ?? "";
  const sep = match[2] ?? "";
  const matchedValue = match[3] ?? "";
  const valueStart = matchEnd - matchedValue.length;
  const end = flagSafeAssignmentEnd(text, valueStart, matchEnd);
  return {
    index: match.index,
    end,
    key,
    sep,
    value: text.slice(valueStart, end),
    // Issue #5330: a credential flag with a value is left to `secret-cli-flag`.
    masked: !credentialFlagTakesValueAt(text, valueStart) &&
      // Shortening the mask must not reclassify a credential prefix as prose.
      assignmentIsMasked(key, sep, matchedValue, textAfter(text, matchEnd)),
  };
}

/**
 * Every `secret-assignment` candidate in `text`, in order, with its verdict —
 * the one walk both {@link redactAssignments} and
 * {@link detectsSecretAssignment} use, so they cannot disagree.
 *
 * Issue #5310: the value a label captured can itself be a credential label —
 * `credentials: DEPLOY_TOKEN = <value>`, `credentials: "app.DEPLOY-TOKEN" =
 * <value>`. Masking that run masked the inner label and published the inner
 * value, because the scan resumed after the run. So when the value ends in a
 * credential label (see {@link trailingLabel}) whose assignment runs past the
 * value's end and is itself masked, the walk resumes at the inner label, whose
 * own match masks its value.
 *
 * The outer candidate is given up unmasked only when its whole value is that
 * label (see {@link isLabelOnly}). When real text sits before the label —
 * `password: hunter2,token: <value>`, `TOKEN=abc123;SECRET='d9 e8'` — the
 * outer value is still judged and masked whole, as before; the inner label's
 * key and separator then sit inside that mask, so only the part of the inner
 * value past the outer value's end is masked again. Otherwise the outer value
 * is judged and masked exactly as before — an inner label with no value, a
 * switch word or a cross-line value judged as prose never costs the outer
 * mask.
 */
function walkAssignments(text: string): AssignmentVerdict[] {
  // A nested walk (the decode-then-rescan check runs one on a joined run)
  // gets its own memo, and the outer walk's is put back after it, so the
  // memo always belongs to one walk (PR #5322 review round 12).
  const outer = { ...INNER_MEMO };
  INNER_MEMO.text = text;
  INNER_MEMO.results = new Map();
  INNER_MEMO.quotes = null;
  INNER_MEMO.unclosedFlags = new Map();
  INNER_MEMO.masks = [];
  INNER_MEMO.maskThrough = new Map();
  INNER_MEMO.flagValueStarts = null;
  try {
    return walkAssignmentsMemoised(text);
  } finally {
    Object.assign(INNER_MEMO, outer);
  }
}

/** {@link walkAssignments} with its {@link INNER_MEMO} in place. */
function walkAssignmentsMemoised(text: string): AssignmentVerdict[] {
  const verdicts: AssignmentVerdict[] = [];
  let from = 0;
  // Where the last outer mask kept for an inner label ends; a later verdict
  // starting before it only masks what lies past it.
  let floor = 0;
  let match: RegExpExecArray | null;
  while ((match = execAssignmentAt(text, from)) !== null) {
    const through = INNER_MEMO.maskThrough.get(match.index);
    if (through !== undefined) {
      // An inner value masked through a flag's value past its closing quote
      // (see mainReadsPastInnerValue): one mask, and the walk resumes after it.
      const verdict = verdictOf(text, match);
      const valueStart = verdict.end - verdict.value.length;
      const kept = pastFloor(text, {
        ...verdict,
        end: through,
        value: text.slice(valueStart, through),
        masked: true,
      }, floor);
      if (kept) {
        verdicts.push(kept);
        INNER_MEMO.masks.push({
          start: kept.end - kept.value.length,
          end: through,
        });
      }
      // Main's scan resumed inside the quoted value, so read on from there:
      // a match that starts inside the mask is masked only past it.
      floor = Math.max(floor, through);
      from = valueStart > match.index ? valueStart : match.index + 1;
      continue;
    }
    const outer = verdictOf(text, match);
    const valueStart = outer.end - outer.value.length;
    // Issue #5457: a quoted value whose closing quote opens a credential
    // flag's value is masked through that value (see flagValueThroughQuote).
    const flagEnd = outer.masked ? flagValueThroughQuote(text, outer) : -1;
    if (flagEnd !== -1) {
      const kept = pastFloor(text, {
        ...outer,
        end: flagEnd,
        value: text.slice(valueStart, flagEnd),
      }, floor);
      if (kept) {
        verdicts.push(kept);
        INNER_MEMO.masks.push({
          start: kept.end - kept.value.length,
          end: flagEnd,
        });
      }
      floor = Math.max(floor, flagEnd);
      from = valueStart;
      continue;
    }
    const inner = innerAssignment(text, valueStart, outer.end, 0, outer.masked);
    if (
      inner && !inner.keepsOuter && !quotedRunOn(text, outer) &&
      isLabelOnly(text, valueStart, inner.labelStart)
    ) {
      from = inner.resume;
      continue;
    }
    const kept = pastFloor(text, outer, floor);
    if (kept) {
      verdicts.push(kept);
      if (kept.masked && kept.value !== "") {
        INNER_MEMO.masks.push({
          start: kept.end - kept.value.length,
          end: kept.end,
        });
      }
    }
    if (inner) {
      floor = outer.end;
      from = inner.resume;
      continue;
    }
    from = outer.end > outer.index ? outer.end : outer.index + 1;
  }
  return verdicts;
}

/**
 * Whether the outer value from `valueStart` holds nothing before the inner
 * label at `labelStart` but an optional opening quote and label characters
 * (Issue #5310) — `DEPLOY_TOKEN`, `"app.DEPLOY-TOKEN`. Anything else there
 * (`hunter2,`, `abc123;`, `ab#`) is text the outer value masks.
 */
function isLabelOnly(
  text: string,
  valueStart: number,
  labelStart: number,
): boolean {
  return LABEL_PREFIX.test(text.slice(valueStart, labelStart));
}

/**
 * What may precede an inner label for the outer value to be just the label: an
 * optional quote and up to three Markdown `*`, backtick or `<` markers (Issue
 * #5326), then label characters. A
 * leading `-`, or `--` anywhere, is not label text: `credentials: --token =
 * <value>` and `credentials: x--token = <value>` hold a CLI flag, and given up
 * unmasked they would leave `--token = ***REDACTED***` for the
 * `secret-cli-flag` rule to rewrite, so a second call would mask `--token`
 * (PR #5322 review rounds 5 and 6).
 */
const LABEL_PREFIX = /^["']?[*`<]{0,3}(?!-)(?![^]*--)[A-Za-z0-9_.-]*$/;

/**
 * Whether the outer value is a closed quoted run that the text runs straight
 * on from (Issue #5310, PR #5322 review round 5): `credentials:
 * 'DEPLOY_TOKEN='<value>`. Masking the inner value would join the run and the
 * placeholder into one bare outer value, which the next call masks whole, so
 * the outer value keeps its mask now. The quoted run is matched with its
 * quotes, so the decision needs no further walk however often the shape
 * repeats.
 */
function quotedRunOn(text: string, outer: AssignmentVerdict): boolean {
  return QUOTED_VALUE.test(outer.value) && outer.end < text.length &&
    !/\s/.test(text.charAt(outer.end));
}

/**
 * `verdict` cut to the part past `floor`, the end of an outer mask it starts
 * inside (Issue #5310), or `null` when nothing is left. Its key and separator
 * then lie inside that mask, so only the value's remainder is masked again.
 */
function pastFloor(
  text: string,
  verdict: AssignmentVerdict,
  floor: number,
): AssignmentVerdict | null {
  if (verdict.index >= floor) return verdict;
  const start = Math.max(verdict.end - verdict.value.length, floor);
  if (start >= verdict.end) return null;
  return {
    index: start,
    end: verdict.end,
    key: "",
    sep: "",
    value: text.slice(start, verdict.end),
    masked: verdict.masked,
  };
}

/**
 * Longest inner label {@link trailingLabel} accepts (Issue #5310). A ReDoS
 * ceiling (Issue #3942), not a syntax rule: the pattern's key group is
 * quadratic on a long run of credential keywords, so a run longer than this
 * is never re-scanned as a key and keeps the base mask.
 */
const INNER_LABEL_MAX = 128;

/** One character of the pattern's key group. */
const KEY_CHAR = /^[A-Za-z0-9_]$/;

/** What may sit between an inner label and the outer value's end. */
const LABEL_SUFFIX_CHAR = /^["'=:]$/;

/** A credential keyword in a key-shaped run (Issue #5310). */
const CREDENTIAL_KEYWORD =
  /TOKEN|SECRET|PASSWORD|PASSWD|API[_-]?KEY|APIKEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|CREDENTIAL/i;

/**
 * The start of the pattern's separator group, right after a key: an optional
 * quote, up to three Markdown `*`, backtick or `>` markers (Issue #5326), then
 * `:` or an `=` that does not follow `>` (that is the `>=` comparison).
 */
const SEPARATOR_START = /^["']?[*`>]{0,3}\s*(?::|(?<!>)=)/;

/**
 * How far past {@link INNER_ASSIGNMENT_SPAN} the already-masked check reads:
 * an opening quote and the whole placeholder (Issue #5310).
 */
const MASKED_REACH = REDACTION_PLACEHOLDER.length + 1;

/**
 * The pattern's separator (with the Markdown markers {@link SEPARATOR_START}
 * allows, and the emphasis markers the pattern allows after it) then the placeholder: a
 * value already masked.
 */
const MASKED_SEPARATOR =
  /^["']?[*`>]{0,3}\s*(?::|(?<!>)=)(?:[*_]{1,3}(?=\s))?\s*["']?\*\*\*REDACTED\*\*\*/;

/**
 * The credential label that ends the value `[start, end)`, or `null` (Issue
 * #5310). The label is the shape the pattern's key group matches: a run of
 * key characters holding a credential keyword, followed by nothing but up to
 * two closing characters (a quote, or the `=`/`:` the value swallowed). That
 * is the only place an inner assignment that runs past the value can start —
 * the value's own run stops where the inner separator's whitespace or quote
 * begins. The one exception is a single-quoted inner value holding a space,
 * `DEPLOY_TOKEN='a b'`: the bare value takes `'a` with it, so the label is
 * also looked for just before one of the value's last three `'`, within
 * {@link INNER_ASSIGNMENT_SPAN}. Three, not two: on a second pass the label of
 * `token'='d9 e8'` sits before the third-last quote of
 * `token'='***REDACTED***'`, and that pass must find the label the first found
 * (PR #5322 review round 5). A keyword elsewhere in the value is not a
 * label, and a run longer than {@link INNER_LABEL_MAX} is not looked at.
 * Constant work per candidate.
 */
function trailingLabel(
  text: string,
  start: number,
  end: number,
):
  | { readonly start: number; readonly end: number; readonly viaQuote: boolean }
  | null {
  const atEnd = labelEndingAt(text, start, end);
  if (atEnd) return { ...atEnd, viaQuote: false };
  const from = Math.max(start, end - INNER_ASSIGNMENT_SPAN);
  const tail = text.slice(from, end);
  // The last quote, or one of the two before it when the value closed its own
  // quote or its label carries one (`token'='***REDACTED***'`).
  // (`DEPLOY_TOKEN='***REDACTED***'`, a second pass over the first's output).
  let quote = tail.lastIndexOf("'");
  for (let tries = 0; tries < 3 && quote > 0; tries++) {
    const label = labelEndingAt(text, start, from + quote + 1);
    if (label) return { ...label, viaQuote: true };
    quote = tail.lastIndexOf("'", quote - 1);
  }
  return null;
}

/**
 * Longest whitespace run either side of the separator that
 * {@link spacedSuffixStart} walks over (PR #5322 review round 7). The
 * pattern's separator group takes any `\s*`, line breaks included; this is
 * the same span bound the walk already puts on an inner assignment
 * ({@link INNER_ASSIGNMENT_SPAN}), so the extra work per candidate stays
 * constant (Issue #3942).
 */
const SPACED_SUFFIX_RUN = 256;

/**
 * Where a separator with whitespace in it, then the closing quote of the
 * value, starts when it ends the value at `end` (PR #5322 review rounds 6 and
 * 7): `'API_TOKEN = '`, `'API_TOKEN ='`, `'API_TOKEN:\n  '`. Walks back over
 * the closing quote, at most {@link SPACED_SUFFIX_RUN} whitespace characters,
 * the `=` or `:`, at most as many again, and an optional quote; -1 when the
 * value does not end so, or the run holds no whitespace (the unspaced form is
 * read by {@link labelEndingAt} directly). Linear in the bound, never a
 * regular-expression scan.
 */
function spacedSuffixStart(text: string, start: number, end: number): number {
  let at = end - 1;
  if (at < start || (text[at] !== "'" && text[at] !== '"')) return -1;
  const isSpace = (ch: string | undefined) => ch !== undefined && /\s/.test(ch);
  let spaces = 0;
  let run = 0;
  while (at - 1 >= start && run < SPACED_SUFFIX_RUN && isSpace(text[at - 1])) {
    at--;
    run++;
  }
  spaces += run;
  if (at - 1 < start || (text[at - 1] !== "=" && text[at - 1] !== ":")) {
    return -1;
  }
  at--;
  run = 0;
  while (at - 1 >= start && run < SPACED_SUFFIX_RUN && isSpace(text[at - 1])) {
    at--;
    run++;
  }
  spaces += run;
  if (at - 1 >= start && (text[at - 1] === "'" || text[at - 1] === '"')) at--;
  return spaces > 0 ? at : -1;
}

/**
 * The keyword halves the pattern's key group joins with a `-`: `API-KEY`,
 * `ACCESS-KEY`, `PRIVATE-KEY` (PR #5322 review round 6). The hyphen is the
 * only non-key character a key may hold, and only between these halves.
 */
const HYPHEN_KEYWORD_HEAD = /(?:API|ACCESS|PRIVATE)$/i;
const HYPHEN_KEYWORD_TAIL = /^KEY/i;

/**
 * Where the key ending at `keyEnd` starts, walking back over the key
 * characters and the one `-` a hyphenated keyword holds, or -1 past
 * {@link INNER_LABEL_MAX}. In `x-api-key` the key is `api-key`, as the
 * pattern's `\b` and key group read it.
 */
function keyStartBefore(text: string, start: number, keyEnd: number): number {
  let keyStart = keyEnd;
  let hyphens = 0;
  for (;;) {
    if (keyStart > start && KEY_CHAR.test(text.charAt(keyStart - 1))) {
      if (keyEnd - keyStart >= INNER_LABEL_MAX) return -1;
      keyStart--;
      continue;
    }
    if (
      hyphens === 0 && keyStart - 1 > start &&
      text.charAt(keyStart - 1) === "-" &&
      HYPHEN_KEYWORD_TAIL.test(text.slice(keyStart, keyStart + 3)) &&
      HYPHEN_KEYWORD_HEAD.test(
        text.slice(Math.max(start, keyStart - 8), keyStart - 1),
      )
    ) {
      hyphens++;
      keyStart--;
      continue;
    }
    return keyStart;
  }
}

/** The label {@link trailingLabel} describes, ending exactly at `end`. */
function labelEndingAt(
  text: string,
  start: number,
  end: number,
): { readonly start: number; readonly end: number } | null {
  let keyEnd = end;
  while (
    keyEnd > start && end - keyEnd < 2 &&
    LABEL_SUFFIX_CHAR.test(text.charAt(keyEnd - 1))
  ) keyEnd--;
  const label = keyLabel(text, start, keyEnd);
  if (label) return label;
  // A quoted value whose own run ends in a label and a spaced separator:
  // `'API_TOKEN = '`, `'API_TOKEN =\n'` (PR #5322 review rounds 6 and 7).
  const suffix = spacedSuffixStart(text, start, end);
  if (suffix !== -1) return keyLabel(text, start, suffix);
  // A label wrapped in Markdown markers: `**DEPLOY_TOKEN**:`,
  // `**DEPLOY_TOKEN:**` (Issue #5326). A short slice keeps the match bounded.
  const tail = text.slice(Math.max(start, end - MARKED_SUFFIX_SLICE), end);
  const marked = MARKED_LABEL_SUFFIX.exec(tail)?.[0] ?? "";
  if (!MARKER_CHAR.test(marked)) return null;
  return keyLabel(text, start, end - marked.length);
}

/** How many trailing characters {@link MARKED_LABEL_SUFFIX} is applied to. */
const MARKED_SUFFIX_SLICE = 8;

/**
 * What may sit between an inner label and the outer value's end when the label
 * is wrapped in Markdown markers (Issue #5326): an optional quote, up to three
 * emphasis, backtick or `>` markers, an optional separator, up to three
 * emphasis (`*` or `_`) markers. Anchored at the end of a slice of at most
 * {@link MARKED_SUFFIX_SLICE} characters.
 */
const MARKED_LABEL_SUFFIX = /["']?[*`>]{0,3}[=:]?[*_]{0,3}$/;

/**
 * A Markdown marker: the suffix is accepted only if it holds one. A bare `_`
 * is a key character, so it counts only straight after a separator.
 */
const MARKER_CHAR = /[*`>]|[=:]_/;

/** The credential key ending at `keyEnd`, or `null`. */
function keyLabel(
  text: string,
  start: number,
  keyEnd: number,
): { readonly start: number; readonly end: number } | null {
  const keyStart = keyStartBefore(text, start, keyEnd);
  if (keyStart === -1 || keyStart === keyEnd) return null;
  if (!CREDENTIAL_KEYWORD.test(text.slice(keyStart, keyEnd))) return null;
  return { start: keyStart, end: keyEnd };
}

/**
 * The inner label ending the value `[start, end)` opens, when
 * it runs past `end`, or `null` (Issue #5310). Only that label is tried (see
 * {@link trailingLabel}); the search past the value is cut to
 * {@link INNER_ASSIGNMENT_SPAN}, so each candidate costs bounded extra work.
 * The full text is then matched from the label, so the verdict is the one the
 * walk itself will reach there.
 *
 * A label whose value is already the placeholder — the first pass's own
 * output, `api_key: ***REDACTED***` — also counts, so a second pass changes
 * nothing. The pattern refuses a redacted value, so without this the second
 * pass would mask the label — but only when the placeholder reaches the outer
 * value's end (bar a closing quote); text after it keeps the outer mask.
 */
function innerAssignment(
  text: string,
  start: number,
  end: number,
  depth = 0,
  outerMasked = true,
): InnerLabel | null {
  // One answer per value within a walk (see INNER_MEMO): a long chain looks
  // ahead once per link, not once per link per candidate.
  const memo = INNER_MEMO.text === text ? INNER_MEMO.results : null;
  const key = `${start}:${end}:${outerMasked ? 1 : 0}`;
  const hit = memo?.get(key);
  if (hit !== undefined) return hit;
  const result = innerAssignmentUncached(text, start, end, depth, outerMasked);
  memo?.set(key, result);
  return result;
}

/**
 * Answers of {@link innerAssignment} for the text being walked. A chain's
 * look-ahead asks about each later link, and the walk then asks about the
 * same link again, so without it a long chain cost the look-ahead's depth per
 * link (PR #5322 review round 11; Issue #3942 linearity). The first answer
 * for a value stands for the rest of the walk, so a link refused at the end
 * of one candidate's look-ahead is refused for every candidate, which keeps
 * main's result for a chain longer than the look-ahead.
 */
const INNER_MEMO: {
  text: string | null;
  results: Map<string, InnerLabel | null>;
  quotes: QuoteIndex | null;
  unclosedFlags: Map<number, boolean>;
  masks: Array<{ start: number; end: number }>;
  maskThrough: Map<number, number>;
  flagValueStarts: Set<number> | null;
} = {
  text: null,
  results: new Map(),
  quotes: null,
  unclosedFlags: new Map(),
  masks: [],
  maskThrough: new Map(),
  flagValueStarts: null,
};

/** Sorted positions of each quote kind in a text, read once per walk. */
interface QuoteIndex {
  single: number[];
  double: number[];
}

/**
 * The {@link QuoteIndex} of `text`: the walk's own, built on first use, or a
 * fresh one when `text` is not the text being walked.
 */
function quoteIndex(text: string): QuoteIndex {
  if (INNER_MEMO.text === text && INNER_MEMO.quotes !== null) {
    return INNER_MEMO.quotes;
  }
  const index: QuoteIndex = { single: [], double: [] };
  for (const m of text.matchAll(/['"]/g)) {
    (m[0] === "'" ? index.single : index.double).push(m.index);
  }
  if (INNER_MEMO.text === text) INNER_MEMO.quotes = index;
  return index;
}

/** Index of the first entry of the sorted `list` at or after `at`. */
function firstAtOrAfter(list: number[], at: number): number {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((list[mid] ?? 0) < at) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Position of the last `quote` before `before` in `text`, or -1. */
function quoteBefore(text: string, quote: string, before: number): number {
  const index = quoteIndex(text);
  const list = quote === "'" ? index.single : index.double;
  return list[firstAtOrAfter(list, before) - 1] ?? -1;
}

/** Position of the first `quote` at or after `from` in `text`, or -1. */
function quoteFrom(text: string, quote: string, from: number): number {
  const index = quoteIndex(text);
  const list = quote === "'" ? index.single : index.double;
  return list[firstAtOrAfter(list, from)] ?? -1;
}

/** {@link innerAssignment} without the per-walk memo. */
function innerAssignmentUncached(
  text: string,
  start: number,
  end: number,
  depth: number,
  outerMasked: boolean,
): InnerLabel | null {
  const label = trailingLabel(text, start, end);
  if (!label) return null;
  const window = text.slice(label.start, end + INNER_ASSIGNMENT_SPAN);
  const afterKey = window.slice(label.end - label.start);
  // The first pass masks an inner value whose first character lies inside the
  // window, so its placeholder (after an optional opening quote) can run past
  // the window's end. The already-masked check reads that far, so a second
  // pass sees the whole placeholder wherever the first could write one.
  const masked = MASKED_SEPARATOR.exec(
    text.slice(label.end, end + INNER_ASSIGNMENT_SPAN + MASKED_REACH),
  );
  if (masked) {
    // The placeholder must reach the value's end (bar a closing quote); text
    // after it belongs to the outer value, which stays masked whole.
    const rest = text.slice(label.end + masked[0].length, end);
    return rest === "" || rest === "'" || rest === '"'
      ? { labelStart: label.start, resume: end, keepsOuter: false }
      : null;
  }
  if (!SEPARATOR_START.test(afterKey)) return null;
  const probe = execAssignmentAt(window, 0);
  if (
    (!probe || probe.index !== 0) &&
    !closesWithinReach(text, label.end, afterKey)
  ) return null;
  const match = execAssignmentAt(text, label.start);
  if (!match || match.index !== label.start) return null;
  const verdict = verdictOf(text, match);
  if (!(verdict.end > end && verdict.masked)) return null;
  // Keep main's result whenever main's own scan would read past the inner
  // value (PR #5322 review round 8). Main masked the inner label as the outer
  // value and resumed right after it, so a `secret-assignment` match or a
  // credential flag that starts inside what is now the inner value, and runs
  // past its end, was main's to mask: `DEPLOY_TOKEN = 'token:x'<value>`,
  // `DEPLOY_TOKEN = '--token '<value>`, `DEPLOY_TOKEN = --token <value>`,
  // `DEPLOY_TOKEN: API_TOKEN=\nhunter2`. Reading the inner label there would
  // mask the inner value whole and publish that text, so no inner label is
  // read. One check, with no whitespace or length bound of its own: wherever
  // main's scan reaches past the inner value, main's result stands.
  const pastInner = mainReadsPastInnerValue(
    text,
    verdict,
    depth,
    outerMasked ? end : -1,
    start,
  );
  if (pastInner === true) return null;
  if (typeof pastInner === "number") {
    INNER_MEMO.maskThrough.set(label.start, pastInner);
    return { labelStart: label.start, resume: label.start, keepsOuter: false };
  }
  // A single-quoted inner value holding a space, found before one of the
  // value's quotes, that runs straight into more text (`DEPLOY_TOKEN='a b'.`):
  // its mask removes the space, so a second pass reads the label, placeholder
  // and that text as one outer value and masks it whole. Keep the outer mask
  // now, so the first pass already gives that output and a second changes
  // nothing.
  // The same holds when the outer bare value stopped at a `"` inside the inner
  // quoted value (PR #5322 review round 9: `DEPLOY_TOKEN='"abc"'--token
  // <value>`): the mask removes that `"`, so a second walk would read the
  // label, placeholder and the text after it as one outer value. Keeping the
  // outer mask makes the first walk final and leaves a flag after the quote
  // visible to the `secret-cli-flag` rule.
  const innerStart = verdict.end - verdict.value.length;
  const stoppedInside = text.charAt(end) === '"' && end > innerStart &&
    end < verdict.end;
  const runsOn = (label.viaQuote || stoppedInside) &&
    verdict.end < text.length && !/\s/.test(text.charAt(verdict.end));
  return { labelStart: label.start, resume: label.start, keepsOuter: runsOn };
}

/**
 * Whether the inner value after the label ending at `labelEnd` opens with `"`
 * inside the window but closes past it, within {@link INNER_QUOTED_MAX}
 * (Issue #5310). Since Issue #5329 the pattern also reads a double-quoted value
 * with no closing quote to the end of its line, so the window probe reads a
 * long value cut off by the window as unterminated and the full-text match
 * masks it. The probe still fails on one that opens with a line break or holds
 * no letter or digit inside the window (`DEPLOY_TOKEN = "\n<300 characters>"`),
 * and that value would be published; the full-text match then decides. The
 * search for the closing quote is capped, so each candidate costs bounded extra
 * work (the Issue #3942 linearity rule).
 */
function closesWithinReach(
  text: string,
  labelEnd: number,
  afterKey: string,
): boolean {
  const sep = OPEN_DOUBLE_QUOTE.exec(afterKey);
  if (!sep) return false;
  const open = labelEnd + sep[0].length - 1;
  // A value of INNER_QUOTED_MAX characters closes at that offset.
  const close = text.slice(open + 1, open + 2 + INNER_QUOTED_MAX).indexOf('"');
  // Closed inside the window: the probe already judged it.
  return close !== -1 && open + 1 + close >= labelEnd + afterKey.length;
}

/**
 * A credential flag and its value at one position (sticky), as the
 * `secret-cli-flag` rule reads them,
 * without that rule's refusal of an already-masked value: on a second pass the
 * placeholder after a flag must read the same as the value did on the first
 * (PR #5322 review round 8). The flag-name runs are bounded as in that rule
 * (Issue #3942).
 */
const CLI_FLAG_AT = new RegExp(
  String
    .raw`(--[A-Za-z0-9-]{0,63}(?:token|secret|password|passwd|api[_-]?key|apikey|access[_-]?key|private[_-]?key|credential)[A-Za-z0-9-]{0,63}\s+)(?!-)${CLI_FLAG_VALUE}`,
  "iy",
);

/**
 * Whether main's scan, resuming right after the inner label it masked as the
 * outer value, would mask text past the end of `inner`'s value (PR #5322
 * review round 8): a masked `secret-assignment` match, or a credential flag
 * and its value, that starts inside the inner value and ends past it, other
 * than the label that ends the inner value, which the walk reads next; or a
 * run from the inner value wrapped onto the next line that the
 * decode-then-rescan pass would mask, read after the assignment rule's own
 * masks ({@link maskedValueStart}). Every search reads only the inner
 * value, then each match from where it starts inside it, so the work per
 * candidate is bounded by the inner value and what it reaches.
 */
function mainReadsPastInnerValue(
  text: string,
  inner: AssignmentVerdict,
  depth: number,
  maskedUntil: number,
  outerStart: number,
): boolean | number {
  const start = inner.end - inner.value.length;
  // A flag inside a quoted inner value whose own value takes the closing
  // quote (`DEPLOY_TOKEN: 'deploy --token '<value>'`): main's result masks the
  // flag's value from that quote on and leaves the quote's opening run
  // unclosed, which a second walk reads differently. When nothing else
  // below keeps main's result, the inner value is masked through the flag's
  // value instead, so the first walk's output is final (PR #5322 review
  // round 13). When something else does, main's result stands: its other
  // masks past the inner value are main's to make. The walk then never reads
  // a label ending the inner value as the next chain link, so that label is
  // probed like any other key. Read once, first, as it is the costliest read
  // here; flags too many to read keep main's result (Issue #3942 linearity;
  // PR #5322 review round 15).
  const through = quotedValueFlagEnd(text, inner, start);
  if (through === TOO_MANY_FLAGS) return true;
  // A credential flag whose quoted value opens before the outer value and
  // reaches a quote in the outer or inner value
  // (`--token 'alpha credentials: DEPLOY_TOKEN = 'tail`,
  // `--password 'x secrets: DEPLOY_TOKEN': y`): the `secret-cli-flag` rule
  // pairs the quotes of the text the walk leaves, and main masked the outer
  // value where the walk masks the inner one, so the walk would change which
  // quote closes the flag's value and the rule would mask only its first word
  // (PR #5322 review round 13). Main's result stands then; this comes before
  // the masked-through flag below, whose mask would take that quote too.
  if (
    flagQuoteReaches(
      text,
      outerStart,
      inner,
      through === -1,
    )
  ) return true;
  // An inner value already holding the placeholder after other text
  // (`,***REDACTED***`) is a first pass's output where main's result stood, so
  // a second pass keeps main's result too and changes nothing (PR #5322 review
  // round 9).
  if (inner.value.includes(REDACTION_PLACEHOLDER)) return true;
  // A label that ends the inner value is exempt only when the walk's next
  // step really reads it as an inner label and masks its value (a chain,
  // `credentials: secret: DEPLOY_TOKEN = <value>`). When that step is refused,
  // its match counts like any other, so the chain gets main's result. The
  // look-ahead is bounded by MAX_CHAIN_LOOKAHEAD; past it the chain is not
  // exempt.
  const label = trailingLabel(text, start, inner.end);
  const chained = label !== null && depth < MAX_CHAIN_LOOKAHEAD &&
      innerAssignment(text, start, inner.end, depth + 1, true) !== null
    ? label.start
    : -1;
  // Every `secret-assignment` key that starts inside the inner value, found
  // by its credential keyword in the inner value alone and matched from its
  // start, so no search leaves the inner value. At most MAX_INNER_PROBES keys
  // are read; past that main's result stands (Issue #3942 linearity).
  const value = text.slice(start, inner.end);
  // `matchAll` steps a copy of the regex: the loop's body can re-enter the
  // walk (through `verdictOf`), which must not move this loop's position
  // (PR #5322 review round 16).
  let probes = 0;
  let lastKey = -1;
  for (const k of value.matchAll(CREDENTIAL_KEYWORD_ALL)) {
    const keyStart = keyStartBefore(text, start, start + k.index);
    if (
      keyStart === -1 || keyStart === lastKey ||
      (through === -1 && keyStart === chained)
    ) {
      continue;
    }
    lastKey = keyStart;
    if (++probes > MAX_INNER_PROBES) return true;
    SECRET_ASSIGNMENT_AT.lastIndex = keyStart;
    const match = SECRET_ASSIGNMENT_AT.exec(text);
    if (match === null) continue;
    const verdict = verdictOf(text, match);
    // Masked or not: main's scan resumes after this match either way, so a
    // match that reaches past the inner value changes what main reads next
    // (PR #5322 review round 11).
    if (verdict.end > inner.end) return true;
  }
  // Every credential flag whose `--` starts inside the inner value, read with
  // its whitespace and value from there, so a flag after any amount of
  // whitespace still counts.
  for (
    let at = value.indexOf("--");
    at !== -1;
    at = value.indexOf("--", at + 1)
  ) {
    CLI_FLAG_AT.lastIndex = start + at;
    const flag = CLI_FLAG_AT.exec(text);
    if (
      through === -1 && flag !== null && start + at + flag[0].length > inner.end
    ) return true;
  }
  // The decode-then-rescan pass joins a run that wraps onto the next line
  // (`API_TOKEN=` then `hunter2`) and masks it when the joined text is a
  // secret. Read the runs as that pass reads them on main: from where a run
  // through the inner label can start, walked back over the candidate
  // characters and line breaks (at most WRAP_LOOKBACK of them), so a run that
  // begins at the separator's `=` or on the label's line counts (PR #5322
  // review round 10). When a wrapped run the pass would mask reaches past the
  // inner value, or covers the inner label, main's result stands.
  // Which text the decode pass sees around the inner label depends on what
  // stays visible (PR #5322 review round 11). When the inner value is itself a
  // chained label the walk keeps visible, head's own pass sees the label line
  // joined to it (`app.token=` then `DEPLOY_TOKEN = …`), so a run may start on
  // the label's line and a run covering the label counts. Otherwise the inner
  // value is masked in head's output, and on main the outer value (the inner
  // label, up to `maskedUntil`) was masked when its verdict was, so a run can
  // start no earlier than the end of that mask, and only a run reaching past
  // the inner value counts (`DEPLOY_TOKEN=` then `<value>` keeps the value
  // masked).
  const labelVisible = chained !== -1;
  const floor = labelVisible ? 0 : Math.max(maskedUntil, 0);
  let windowStart = Math.max(inner.index, floor);
  for (
    let steps = 0;
    windowStart > floor && steps < WRAP_LOOKBACK &&
    WRAP_WINDOW_CHAR.test(text[windowStart - 1] ?? "");
    steps++
  ) windowStart--;
  // Run starts are found in the window and the inner value alone; each run is
  // then read from its start over at most WRAP_RUN_MAX characters, and a run
  // longer than that keeps main's result, so the work per candidate stays
  // bounded (Issue #3942).
  const window = text.slice(windowStart, inner.end + 4);
  // `matchAll` steps a copy of the regex. The loop's body decodes the run
  // and walks the decoded text, which reaches this check again; a shared
  // `lastIndex` was reset there, and the loop found the same run without end
  // (PR #5322 review round 16).
  for (const found of window.matchAll(WRAPPED_RUN_G)) {
    if (windowStart + found.index >= inner.end) break;
    const runStart = windowStart + found.index;
    const reach = text.slice(runStart, runStart + WRAP_RUN_MAX + 1);
    WRAPPED_RUN_AT.lastIndex = 0;
    const run = WRAPPED_RUN_AT.exec(reach);
    WRAPPED_RUN_AT.lastIndex = 0;
    if (run === null) continue;
    // Main's decode pass runs after its assignment rule, so it sees the run
    // cut at the first value that rule masks after the inner value (PR #5322
    // review round 15). A run too long to read whole keeps main's result.
    // The rules after it (`secret-cli-flag`, `hex32-credential`) also run
    // before that pass, so the run is cut at the first value they mask too
    // (`<value>\nmd5=<32 hex>`, `<value>\n--password\nUSER=bob`; PR #5322
    // review round 16).
    const long = run[0].length > WRAP_RUN_MAX;
    const seen = long ? run[0] : run[0].slice(
      0,
      laterRuleCut(
        text,
        Math.max(runStart, inner.end),
        maskedValueStart(text, inner.end, runStart + run[0].length),
      ) - runStart,
    );
    const runEnd = runStart + seen.length;
    if (runEnd <= inner.index) continue;
    if (
      !(runEnd > inner.end || (labelVisible && runStart < start)) ||
      !/\n/.test(seen)
    ) {
      continue;
    }
    if (long) return true;
    if (
      redactTransformedSecrets(
        seen,
        matchesSignatureRule,
        REDACTION_PLACEHOLDER,
      ) !==
        seen
    ) return true;
  }
  // A second pass over a first pass's output where a flag after an unclosed
  // quote kept main's result (`'deploy --token ***REDACTED***`): the inner
  // value is now the bare `'deploy`, so read the flag after it as the first
  // pass read it inside the quote (PR #5322 review round 10). An inner value
  // that is itself a chained label (`'api_key: ***REDACTED***`) was read as
  // the chain's next link on the first pass too, so a masked flag after it
  // was masked on its own and the chain is read again (PR #5322 review round
  // 13).
  const opener = inner.value[0];
  if (
    chained === -1 && (opener === "'" || opener === '"') &&
    inner.value.indexOf(opener, 1) === -1 &&
    unclosedRunHasMaskedFlag(text, inner.end, opener)
  ) return true;
  return through !== -1 ? through : false;
}

/**
 * Where the first value the rules after `secret-assignment` mask, inside
 * `[from, to)`, begins; `to` when there is none. Main's decode-then-rescan
 * pass runs after every rule, so a run it joins ends before such a value: a
 * credential flag's value (the flag's name stays visible) or a 32-hex run
 * (PR #5322 review round 16). `from` is no earlier than the end of the inner
 * value: text before it lies in the outer or inner value, which the
 * assignment rule masks before these rules run. Each rule is read over `[from, to)` and at most
 * {@link LATER_RULE_CONTEXT} characters before it, so a flag named just
 * before the run still counts; the run is at most {@link WRAP_RUN_MAX} long,
 * so the work per run stays bounded (Issue #3942).
 */
function laterRuleCut(text: string, from: number, to: number): number {
  if (to <= from) return to;
  const base = Math.max(0, from - LATER_RULE_CONTEXT);
  const slice = text.slice(base, to);
  let cut = to;
  for (const m of slice.matchAll(CLI_FLAG_RULE_G)) {
    const valueStart = base + m.index + (m[1]?.length ?? 0);
    if (valueStart >= to) break;
    if (valueStart + (m[0].length - (m[1]?.length ?? 0)) > from) {
      cut = Math.min(cut, Math.max(valueStart, from));
      break;
    }
  }
  for (const m of slice.matchAll(HEX32_CREDENTIAL_G)) {
    const at = base + m.index;
    if (at >= cut) break;
    if (at + m[0].length > from) {
      cut = Math.max(at, from);
      break;
    }
  }
  return cut;
}

/** How far before a run {@link laterRuleCut} reads for a flag's name. */
const LATER_RULE_CONTEXT = 256;

/** The `hex32-credential` rule's pattern, for {@link laterRuleCut}. */
const HEX32_CREDENTIAL_G = /(?<![0-9A-Za-z])[0-9a-f]{32}(?![0-9A-Za-z])/gi;

/**
 * Where the first `secret-assignment` value this walk masks, whose key starts
 * in `[from, to)`, begins; `to` when there is none. Main's decode-then-rescan
 * pass reads the text after that rule's masks, so a run it joins ends at the
 * separator before such a value (`API_KEY=`), not at the value (PR #5322
 * review round 15). A match whose verdict is not masked (`API_KEY=true`) stays
 * in the run. At most {@link MAX_INNER_PROBES} keys are read; past that the
 * run is read whole.
 */
function maskedValueStart(text: string, from: number, to: number): number {
  const span = text.slice(from, to);
  let probes = 0;
  let lastKey = -1;
  for (const k of span.matchAll(CREDENTIAL_KEYWORD_ALL)) {
    const keyStart = keyStartBefore(text, from, from + k.index);
    if (keyStart === -1 || keyStart === lastKey) continue;
    lastKey = keyStart;
    if (++probes > MAX_INNER_PROBES) return to;
    SECRET_ASSIGNMENT_AT.lastIndex = keyStart;
    const match = SECRET_ASSIGNMENT_AT.exec(text);
    if (match === null) continue;
    const verdict = verdictOf(text, match);
    if (verdict.masked) return verdict.end - verdict.value.length;
  }
  return to;
}

/**
 * Where the value of the first credential flag inside the quoted `inner`
 * value ends, when that value takes the closing quote (it ends on or past
 * it, so the `secret-cli-flag` rule would remove the quote), moved on past
 * any flag value the mask would cut; -1 when the inner value is not a closed
 * quoted value, no flag inside it reaches the quote, or a credential keyword
 * lies between the quote and that end; {@link TOO_MANY_FLAGS} when more than
 * {@link MAX_FLAG_VISITS} `--` runs would be read.
 */
function quotedValueFlagEnd(
  text: string,
  inner: AssignmentVerdict,
  start: number,
): number {
  const quote = inner.value[0];
  if (
    (quote !== "'" && quote !== '"') || inner.value.length < 2 ||
    !inner.value.endsWith(quote)
  ) return -1;
  const value = inner.value;
  for (
    let at = value.indexOf("--"), visited = 1;
    at !== -1;
    at = value.indexOf("--", at + 1), visited++
  ) {
    if (visited > MAX_FLAG_VISITS) return TOO_MANY_FLAGS;
    CLI_FLAG_AT.lastIndex = start + at;
    const flag = CLI_FLAG_AT.exec(text);
    if (flag !== null && start + at + flag[0].length >= inner.end) {
      const through = flagsThrough(text, start, start + at + flag[0].length);
      if (through === TOO_MANY_FLAGS) return TOO_MANY_FLAGS;
      // A credential keyword past the inner value may start a match main
      // masks before the flag rule runs, which moves the flag value's closing
      // quote on main; the mask cannot follow that, so main's result stands.
      return CREDENTIAL_KEYWORD_ANY.test(text.slice(inner.end, through))
        ? -1
        : through;
    }
  }
  return -1;
}

/**
 * What {@link quotedValueFlagEnd} and {@link flagsThrough} return when more
 * than {@link MAX_FLAG_VISITS} `--` runs would be read: main's result stands.
 */
const TOO_MANY_FLAGS = -2;

/**
 * Most `--` runs one {@link quotedValueFlagEnd} call reads, so a chain of
 * flags that each reach past the last cannot make every candidate rescan the
 * rest of the text (Issue #3942 linearity; PR #5322 review round 15).
 */
const MAX_FLAG_VISITS = 64;

/** {@link CREDENTIAL_KEYWORD} as a plain test, without the global flag. */
const CREDENTIAL_KEYWORD_ANY = new RegExp(CREDENTIAL_KEYWORD.source, "i");

/**
 * `end`, moved on past the value of every credential flag that starts before
 * it (from `start`) and runs past it, so a mask from `start` to the result
 * never takes a flag's name and leaves its value. Each `--` is read once, and
 * at most {@link MAX_FLAG_VISITS} are read: past that it returns
 * {@link TOO_MANY_FLAGS} instead of an end, and the caller keeps main's result.
 */
function flagsThrough(text: string, start: number, end: number): number {
  let through = end;
  for (
    let at = text.indexOf("--", start), visited = 1;
    at !== -1 && at < through;
    at = text.indexOf("--", at + 1), visited++
  ) {
    if (visited > MAX_FLAG_VISITS) return TOO_MANY_FLAGS;
    CLI_FLAG_AT.lastIndex = at;
    const flag = CLI_FLAG_AT.exec(text);
    if (flag !== null && at + flag[0].length > through) {
      through = at + flag[0].length;
    }
  }
  return through;
}

/**
 * Whether the text after an inner value that opens with `opener` and never
 * closes it, up to the next `opener` (or the end of the text), holds a
 * credential flag whose value starts with the placeholder: the first pass found that
 * flag inside the quoted run and kept main's result, so the second keeps it
 * too (PR #5322 review rounds 10, 12 and 13). Every character but `opener`,
 * an earlier placeholder included, may sit inside the original quoted run,
 * and the run has no length bound, because the first pass read the flag
 * wherever it stood. Distinct openers read disjoint runs, and each run is
 * read once per walk, so the work stays linear (Issue #3942).
 */
function unclosedRunHasMaskedFlag(
  text: string,
  from: number,
  opener: string,
): boolean {
  const memo = INNER_MEMO.text === text ? INNER_MEMO.unclosedFlags : null;
  const hit = memo?.get(from);
  if (hit !== undefined) return hit;
  const close = quoteFrom(text, opener, from);
  const run = text.slice(from, close === -1 ? text.length : close);
  let found = false;
  for (let at = run.indexOf("--"); at !== -1; at = run.indexOf("--", at + 1)) {
    CLI_FLAG_AT.lastIndex = from + at;
    const flag = CLI_FLAG_AT.exec(text);
    // The flag's value starts with the placeholder; text may run on after it
    // (`--token ***REDACTED***;`), as the flag rule's `\S+` took it on the
    // first call (PR #5322 review round 14).
    if (
      flag !== null &&
      flag[0].replace(/^\S+\s+/, "").startsWith(REDACTION_PLACEHOLDER)
    ) {
      found = true;
      break;
    }
  }
  memo?.set(from, found);
  return found;
}

/**
 * Whether a credential flag's quoted value, as the `secret-cli-flag` rule
 * reads it after the walk, opens before `outerStart` and closes at a quote
 * the walk's mask would remove: one in the outer value (main masked it, the
 * walk keeps it) or inside the inner value's mask (PR #5322 review rounds 13
 * and 14). For each quote kind, the last quote of that kind before
 * `outerStart` that no earlier mask of this walk covers must be where the
 * rule opens a flag's value (a quote that closes an earlier flag's value,
 * as in `--token 'x --password '`, does not count), and the next quote of
 * that kind must lie in that span. A closed quoted inner value keeps both its
 * quotes when masked (`keepsQuotes`: it is not masked through a flag), so
 * its opening quote does not count. More than
 * {@link MAX_MASK_HOPS} masks to skip keeps main's result (Issue #3942).
 */
function flagQuoteReaches(
  text: string,
  outerStart: number,
  inner: AssignmentVerdict,
  keepsQuotes: boolean,
): boolean {
  const start = inner.end - inner.value.length;
  const opener = inner.value[0];
  const closedQuoted = keepsQuotes && (opener === "'" || opener === '"') &&
    inner.value.length > 1 && inner.value.endsWith(opener);
  const maskStart = closedQuoted ? start + 1 : start;
  const maskEnd = closedQuoted ? inner.end - 1 : inner.end;
  for (const quote of ["'", '"']) {
    const next = quoteFrom(text, quote, outerStart);
    if (
      next === -1 ||
      !(next < start || (next >= maskStart && next < maskEnd))
    ) continue;
    let open = quoteBefore(text, quote, outerStart);
    for (let hops = 0; open !== -1; hops++) {
      const mask = maskCovering(open);
      if (mask === null) break;
      if (hops >= MAX_MASK_HOPS) return true;
      open = quoteBefore(text, quote, mask.start);
    }
    if (open !== -1 && next > open + 1 && flagValueStartsAt(text, open)) {
      return true;
    }
  }
  return false;
}

/**
 * An upper bound on a credential flag's name: `--`, up to 63 name characters
 * either side of the credential keyword, and the keyword itself. Assignment
 * and CLI mask boundary checks read at most this much of the value's tail,
 * whatever its length (the linearity rule in the module header).
 */
const FLAG_NAME_SPAN = 150;

/** A credential flag's name ending the text it is tested on (Issue #5608). */
const FLAG_NAME_AT_END =
  /--[A-Za-z0-9-]{0,63}(?:token|secret|password|passwd|api[_-]?key|apikey|access[_-]?key|private[_-]?key|credential)[A-Za-z0-9-]{0,63}$/i;

/**
 * End a `secret-assignment` value before a credential flag's name when the
 * name ends it after other text and a value follows the flag (Issue #5608):
 * `password: token=--token <value>`, `password: abc--token <value>`. The
 * value then ends before the flag's name, which is left for the
 * `secret-cli-flag` rule to keep while it masks the flag's value; masking the
 * name with the outer value hid the flag from that rule and published the
 * value. A flag at the value's start is {@link credentialFlagTakesValueAt}'s
 * (Issue #5330). Only the value's last {@link FLAG_NAME_SPAN} characters are
 * read. A flag whose complete value extent ends in another credential flag's
 * name with a value after it is not cut: retain the outer assignment's mask
 * through both values rather than exposing its inner text. Extend
 * through successive overlapping flags. Each extension reads a bounded name
 * tail and advances through the next value with {@link CLI_FLAG_AT} and
 * {@link cliFlagEnd}, including shared-quote overlaps; the value reads are
 * disjoint, so the work stays linear. Otherwise keep `end`.
 */
function flagSafeAssignmentEnd(
  text: string,
  valueStart: number,
  end: number,
): number {
  const at = flagNameEndingAt(text, valueStart, end);
  if (at <= valueStart || !credentialFlagTakesValueAt(text, at)) return end;
  CLI_FLAG_AT.lastIndex = at;
  const flag = CLI_FLAG_AT.exec(text);
  CLI_FLAG_AT.lastIndex = 0;
  if (flag === null) return end;
  let through = cliFlagEnd(text, flag);
  let from = end;
  let overlaps = false;
  while (true) {
    const nested = flagNameEndingAt(text, from, through);
    if (nested === -1 || !credentialFlagTakesValueAt(text, nested)) break;
    CLI_FLAG_AT.lastIndex = nested;
    const next = CLI_FLAG_AT.exec(text);
    CLI_FLAG_AT.lastIndex = 0;
    if (next === null) break;
    from = through;
    through = cliFlagEnd(text, next);
    overlaps = true;
  }
  return overlaps ? through : at;
}

/**
 * Where a credential flag's name ending `text` at `end` starts, no earlier than
 * `start`, or -1 if none. Reads at most {@link FLAG_NAME_SPAN} characters.
 */
function flagNameEndingAt(text: string, start: number, end: number): number {
  const from = Math.max(start, end - FLAG_NAME_SPAN);
  const name = text.slice(from, end).match(FLAG_NAME_AT_END);
  return name ? from + name.index! : -1;
}

/**
 * A credential flag with a value after it, read where a `secret-assignment`
 * value starts (Issue #5330): the `secret-cli-flag` rule's flag name and
 * whitespace, then a value that rule takes or has already masked. A bare `=` or
 * `:` after the flag is an assignment separator (Issue #5310 shapes such as
 * `credentials: --token = <value>`), not a value. Sticky, so it reads only at
 * the given offset.
 */
const CLI_FLAG_WITH_VALUE_AT =
  /--[A-Za-z0-9-]{0,63}(?:token|secret|password|passwd|api[_-]?key|apikey|access[_-]?key|private[_-]?key|credential)[A-Za-z0-9-]{0,63}\s+(?!-|[=:](?:\s|$))\S/iy;

/**
 * Whether a credential flag with a value starts at `at` (Issue #5330). Such a
 * flag is left for the `secret-cli-flag` rule, which keeps its name and masks
 * its value; masking the name instead hid the flag from that rule and
 * published the value.
 */
function credentialFlagTakesValueAt(text: string, at: number): boolean {
  const pattern = CLI_FLAG_WITH_VALUE_AT;
  pattern.lastIndex = at;
  try {
    return pattern.test(text);
  } finally {
    pattern.lastIndex = 0;
  }
}

/**
 * The `secret-cli-flag` rule's pattern, read once over the walk's text to
 * find where it opens each flag's value.
 */
const CLI_FLAG_RULE_G = new RegExp(
  String
    .raw`(--[A-Za-z0-9-]{0,63}(?:token|secret|password|passwd|api[_-]?key|apikey|access[_-]?key|private[_-]?key|credential)[A-Za-z0-9-]{0,63}\s+)(?!-)(?!\*\*\*REDACTED)${CLI_FLAG_VALUE}`,
  "gi",
);

/** A quote can close one apparent value and open another credential flag's
 * value. Mask their union, including successive overlaps. Each extension
 * advances past the shared quote; only the bounded flag name and its own
 * whitespace are read backwards.
 */
function throughFollowingFlag(
  text: string,
  start: number,
  end: number,
): number {
  while (end < text.length) {
    const open = end - 1;
    if (text[open] !== '"' && text[open] !== "'") break;
    let nameEnd = open;
    while (nameEnd > start && /\s/.test(text[nameEnd - 1]!)) nameEnd--;
    if (nameEnd === open) break;
    const flagStart = flagNameEndingAt(text, start, nameEnd);
    if (flagStart === -1) break;
    if (flagStart <= start || !/\s/.test(text[flagStart - 1]!)) break;
    CLI_FLAG_AT.lastIndex = flagStart;
    const flag = CLI_FLAG_AT.exec(text);
    if (!flag || CLI_FLAG_AT.lastIndex <= end) break;
    start = open;
    end = CLI_FLAG_AT.lastIndex;
  }
  return end;
}

/**
 * Keep a trailing credential flag name with a value for the next match. Only
 * the bounded name tail is revisited; shared-quote overlaps are read first.
 */
function redactCliFlags(text: string): string {
  const pattern = CLI_FLAG_RULE_G;
  pattern.lastIndex = 0;
  let out = "";
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const prefix = match[1]!;
    const start = match.index + prefix.length;
    out += text.slice(last, start) + REDACTION_PLACEHOLDER;
    last = cliFlagEnd(text, match);
    const next = flagNameEndingAt(text, start, last);
    if (next > start && credentialFlagTakesValueAt(text, next)) last = next;
    pattern.lastIndex = last;
  }
  return out + text.slice(last);
}

/** The complete CLI value extent, before replacement preserves a trailing name. */
function cliFlagEnd(text: string, match: RegExpExecArray): number {
  const prefixLength = match[1]!.length;
  const start = match.index + prefixLength;
  const quote = text[start];
  const end = match.index + match[0].length;
  // The escape-aware reader widened the old first-quote match only
  // when another quote of the same kind precedes its closing quote.
  return (quote === '"' || quote === "'") && text[end - 1] === quote &&
      match[0].indexOf(quote, prefixLength + 1) < match[0].length - 1
    ? throughFollowingFlag(text, start, end)
    : end;
}

/**
 * Whether the `secret-cli-flag` rule, reading `text` from the start, opens a
 * flag's value at `at`. The rule's matches are read once per walk.
 */
function flagValueStartsAt(text: string, at: number): boolean {
  let starts = INNER_MEMO.text === text ? INNER_MEMO.flagValueStarts : null;
  if (starts === null) {
    starts = new Set();
    for (const m of text.matchAll(CLI_FLAG_RULE_G)) {
      starts.add(m.index + (m[1]?.length ?? 0));
    }
    if (INNER_MEMO.text === text) INNER_MEMO.flagValueStarts = starts;
  }
  return starts.has(at);
}

/**
 * The `secret-cli-flag` rule's value alternatives, read at one offset.
 */
const CLI_FLAG_VALUE_AT = /"[^"]+"|'[^']+'|\S+/y;

/**
 * Issue #5457: where a credential flag's value ends when `verdict` is a closed
 * quoted value whose closing quote is where the `secret-cli-flag` rule opens
 * that flag's value outside a JSON member boundary, else -1. The
 * walk masks the value through the flag's value, so the flag's name is not
 * hidden from the rule. The read is bounded
 * by the flag rule's own value match, so the walk stays linear (the linearity
 * rule in the module header).
 */
function flagValueThroughQuote(
  text: string,
  verdict: AssignmentVerdict,
): number {
  const value = verdict.value;
  const quote = value[0];
  if (
    (quote !== "'" && quote !== '"') || value.length < 2 ||
    !value.endsWith(quote) ||
    verdict.end === text.length ||
    (quote === '"' && text[verdict.index - 1] === '"' &&
      /^"\s*:/.test(verdict.sep) && /^[\s,:\]}]/.test(text[verdict.end]!)) ||
    !flagValueStartsAt(text, verdict.end - 1)
  ) return -1;
  try {
    CLI_FLAG_VALUE_AT.lastIndex = verdict.end - 1;
    const match = CLI_FLAG_VALUE_AT.exec(text);
    return match ? verdict.end - 1 + match[0].length : -1;
  } finally {
    CLI_FLAG_VALUE_AT.lastIndex = 0;
  }
}

/** Most earlier masks {@link flagQuoteReaches} skips back over. */
const MAX_MASK_HOPS = 16;

/** The mask of this walk covering `at`, or null (masks are kept in order). */
function maskCovering(at: number): { start: number; end: number } | null {
  const masks = INNER_MEMO.masks;
  let lo = 0;
  let hi = masks.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((masks[mid]?.end ?? 0) <= at) lo = mid + 1;
    else hi = mid;
  }
  const mask = masks[lo];
  return mask !== undefined && mask.start <= at ? mask : null;
}

/** How many chain links {@link mainReadsPastInnerValue} looks ahead. */
const MAX_CHAIN_LOOKAHEAD = 16;

/**
 * How many `secret-assignment` matches inside one inner value
 * {@link mainReadsPastInnerValue} reads before keeping main's result (Issue
 * #3942 linearity).
 */
const MAX_INNER_PROBES = 8;

/**
 * A run the decode-then-rescan pass reads as one candidate, optionally
 * wrapped onto following lines (`secret_transform_redaction.ts`'s candidate
 * pattern), matched at one position. Linear: the classes cannot match a line
 * break.
 */
const WRAPPED_RUN_AT = /[A-Za-z0-9+/=_-]{4,}(?:\r?\n[A-Za-z0-9+/=_-]{4,})*/y;

/** A candidate character or line break, walked back over to find a run's start. */
const WRAP_WINDOW_CHAR = /^[A-Za-z0-9+/=_\r\n-]$/;

/** How far back {@link mainReadsPastInnerValue} looks for a run's start. */
const WRAP_LOOKBACK = 1024;

/** Longest wrapped run {@link mainReadsPastInnerValue} reads before keeping main's result. */
const WRAP_RUN_MAX = 4096;

/** The decode-then-rescan pass's candidate runs (global). */
const WRAPPED_RUN_G = /[A-Za-z0-9+/=_-]{4,}(?:\r?\n[A-Za-z0-9+/=_-]{4,})*/g;

/** Every credential keyword in a string (global; reset before each use). */
const CREDENTIAL_KEYWORD_ALL = new RegExp(CREDENTIAL_KEYWORD.source, "gi");

/** The `secret-assignment` pattern matched at one position (sticky). */
const SECRET_ASSIGNMENT_AT = new RegExp(SECRET_ASSIGNMENT_PATTERN.source, "iy");

/**
 * The pattern's separator (Markdown markers before it and emphasis markers after it, as in
 * {@link SEPARATOR_START} and the pattern), then the opening `"` of a
 * double-quoted value.
 */
const OPEN_DOUBLE_QUOTE =
  /^["']?[*`>]{0,3}\s*(?::|(?<!>)=)(?:[*_]{1,3}(?=\s))?\s*"/;

/**
 * Longest double-quoted inner value, past the window, that
 * {@link closesWithinReach} looks for the end of (Issue #5310). A ReDoS
 * ceiling (Issue #3942), not a syntax rule: a longer value that the probe
 * cannot read (one that opens with a line break or holds no letter or digit
 * inside the window) keeps the base behaviour (Issue #5329).
 */
const INNER_QUOTED_MAX = 4096;

/**
 * An inner credential label {@link innerAssignment} found (Issue #5310): where
 * it starts, and where the walk resumes — at the label, whose own match masks
 * its value, or past the outer value when that value is already the
 * placeholder.
 */
interface InnerLabel {
  readonly labelStart: number;
  readonly resume: number;
  /** The outer value stays masked even when it is only the label. */
  readonly keepsOuter: boolean;
}

/**
 * Mask every `secret-assignment` value {@link walkAssignments} judges masked
 * (Issue #5310). The walk itself decides each shape so that its output is
 * final: a second walk over it masks nothing, `redactSecrets` is idempotent on
 * this rule and `containsSecret` is false on its output. One known shape is
 * not yet final (PR #5322 review round 14): a single-quoted value of glued
 * labels that the walk reads as the next chain link (`'app.token=password:`),
 * whose closing quote a later flag takes. A second walk masks that value too;
 * nothing is published. The decode pass that follows can mask a run a label's
 * value was glued to, so {@link redactSecrets} walks the assignments once
 * more after it (PR #5322 review round 17). The shapes where a
 * mask changes how the next walk reads the text around it are decided in the
 * walk — {@link quotedRunOn}, `keepsOuter`, the leading-`-` rule in
 * {@link LABEL_PREFIX} and the placeholder reach of {@link innerAssignment}.
 *
 * The output is then walked again, up to {@link MAX_ASSIGNMENT_PASSES} times
 * in all, until a walk changes nothing. That is a bounded backstop for a shape
 * the walk does not yet decide, not the guarantee: a backstop can be outrun by
 * repeating such a shape more often than the cap.
 */
function redactAssignments(text: string): string {
  let out = text;
  for (let pass = 0; pass < MAX_ASSIGNMENT_PASSES; pass++) {
    const next = redactAssignmentsOnce(out);
    if (next === out) break;
    out = next;
  }
  return out;
}

/**
 * How many walks {@link redactAssignments} runs at most (Issue #5310): the
 * first, and up to three backstop walks. Text with nothing to mask costs one
 * walk and text with a secret two; the cap bounds the work on hostile input.
 */
const MAX_ASSIGNMENT_PASSES = 4;

/**
 * One walk of {@link walkAssignments}, masking what it judges masked. A bare
 * value that starts at, or contains, a credential flag's closing quote may keep
 * that quote in front of the placeholder; {@link maskLeads} says when (Issues
 * #5363 and #5456). Masking the quote with the value left the `secret-cli-flag`
 * rule no closing quote to pair, so it masked only the flag's opening word and
 * published the rest.
 */
function redactAssignmentsOnce(text: string): string {
  const masked = walkAssignments(text).filter((a) => a.masked);
  const leads = maskLeads(text, masked, flagClosingQuotes(text, masked));
  let out = "";
  let last = 0;
  masked.forEach((a, i) => {
    const { lead, end, covered } = leads[i] as MaskLead;
    // A mask an earlier glued value's extension covers is part of that mask
    // and writes nothing of its own (PR #5607 review round 3).
    if (covered) return;
    const quote = QUOTED_VALUE.test(a.value) ? a.value.charAt(0) : "";
    out += text.slice(last, a.index) +
      `${a.key}${a.sep}${lead}${REDACTION_PLACEHOLDER}${quote}`;
    last = end;
  });
  return out + text.slice(last);
}

/**
 * The text written in front of each mask's placeholder, in the order of
 * `masked`. For a quoted value that is the value's own opening quote. A bare
 * value that starts at a credential flag's closing quote keeps that quote
 * (Issue #5363). A bare value that contains one keeps it when no later quote of
 * that kind survives, or that quote lies past another flag whose value starts
 * outside every mask (Issue #5456). Otherwise the flag rule pairs with the later
 * quote and masks through it, as the Issue #5310 round 13 tests pin.
 *
 * A kept quote ends the flag's value, so the mask's text after it is no longer
 * that value. When that text ends in a credential label or flag name glued
 * after the quote, as in `credentials: x'password: <value>` or
 * `credentials: x'--password <value>`, the mask is extended through the value
 * that name labels, so the name stays masked and its value is masked in place
 * (Issue #5456). Nothing masked is ever written back: the result only masks
 * more than a mask ending at the verdict's own end (PR #5607 review).
 */
function maskLeads(
  text: string,
  masked: readonly AssignmentVerdict[],
  flags: ReturnType<typeof flagClosingQuotes>,
): MaskLead[] {
  const { closes, starts } = flags;
  const leads: MaskLead[] = new Array(masked.length);
  const later = { "'": Infinity, '"': Infinity };
  const note = (s: string, at: number) => {
    for (const q of ["'", '"'] as const) {
      const index = s.indexOf(q);
      if (index !== -1) later[q] = at + index;
    }
  };
  // Scan each unmasked gap once per quote kind, from the last mask backwards;
  // the quote and flag pointers also move only backwards.
  let from = text.length;
  let c = closes.length - 1;
  let f = starts.length - 1;
  let nextFlag = Infinity;
  // The surviving quotes from each mask's start onwards, for an extension that
  // covers later masks to resume from.
  const survivors: Array<{ "'": number; '"': number }> = new Array(
    masked.length,
  );
  // The surviving quotes from each mask's end onwards, so a covering extension
  // that ends where a covered mask ends reuses them instead of re-reading the
  // same gap once per mask of a chain (PR #5607 review round 5).
  const afterEnd: Array<{ "'": number; '"': number }> = new Array(
    masked.length,
  );
  for (let i = masked.length - 1; i >= 0; i--) {
    const a = masked[i] as AssignmentVerdict;
    const before = { ...later };
    note(text.slice(a.end, from), a.end);
    afterEnd[i] = { ...later };
    while (f >= 0 && (starts[f] ?? -1) >= a.end) {
      nextFlag = starts[f--] as number;
    }
    const quoted = QUOTED_VALUE.test(a.value);
    const quote = quoted ? a.value.charAt(0) : "";
    const start = a.end - a.value.length;
    while (c >= 0 && (closes[c] ?? 0) >= a.end) c--;
    const close = c >= 0 ? closes[c] ?? -1 : -1;
    let lead = quote;
    if (!quoted && close >= start) {
      const q = text.charAt(close) as "'" | '"';
      // Pairing with a quote past another flag would hide that flag's name
      // from its rule and could publish the rest of its value instead.
      if (close === start || later[q] === Infinity || nextFlag < later[q]) {
        lead = q;
      }
    }
    const glued = lead !== quote
      ? gluedName(text, close + 1, a.end, starts[f])
      : null;
    let end = glued ? gluedValueEnd(text, glued, a.end, from) : a.end;
    let next = i + 1;
    if (end !== a.end && end > from) {
      // A quoted value can close past later masks that lie inside it; the
      // extension takes them over, through any further extension of theirs.
      // A mask already extended over later masks has them marked, and its end
      // reaches past them, so the walk jumps to its `next` instead of
      // revisiting them: each mask is a jump target once, which keeps the
      // pass linear on a chain of glued values (PR #5607 review round 4).
      let j = i + 1;
      let reuse = -1;
      while (
        j < masked.length && (masked[j] as AssignmentVerdict).index < end
      ) {
        const covered = leads[j] as MaskLead;
        if (covered.end >= end) {
          end = covered.end;
          reuse = j;
        }
        leads[j] = { ...covered, covered: true };
        j = covered.next;
      }
      next = j;
      const nextStart = j < masked.length
        ? (masked[j] as AssignmentVerdict).index
        : text.length;
      if (reuse !== -1) {
        // `end` is where a covered mask ends and `j` is that mask's `next`, so
        // the quotes after `end` are the ones it already worked out.
        const known = afterEnd[reuse] as { "'": number; '"': number };
        later["'"] = known["'"];
        later['"'] = known['"'];
      } else {
        const resume = j < masked.length ? survivors[j] : undefined;
        later["'"] = resume?.["'"] ?? Infinity;
        later['"'] = resume?.['"'] ?? Infinity;
        note(text.slice(end, nextStart), end);
      }
      afterEnd[i] = { ...later };
    } else if (end !== a.end) {
      // The extended mask hides the quotes it now covers, so only those past
      // it survive for the earlier masks' pairing decisions.
      later["'"] = before["'"];
      later['"'] = before['"'];
      note(text.slice(end, from), end);
      afterEnd[i] = { ...later };
    }
    leads[i] = { lead, end, next };
    // Emitted quotes lie within this mask, before any later unmasked flag.
    note(`${lead}${quote}`, start);
    note(`${a.key}${a.sep}`, a.index);
    survivors[i] = { ...later };
    from = a.index;
  }
  return leads;
}

/** What {@link maskLeads} writes around one mask's placeholder. */
interface MaskLead {
  /** The quote written in front of the placeholder, or `""`. */
  readonly lead: string;
  /**
   * Where the mask ends: the verdict's own end, or past the value of a
   * credential label or flag name glued after a kept quote (Issue #5456).
   */
  readonly end: number;
  /**
   * Set when an earlier mask's glued-value extension covers this mask, which
   * then writes nothing (PR #5607 review round 3).
   */
  readonly covered?: boolean;
  /** The index of the first mask this mask's extension does not cover. */
  readonly next: number;
}

/**
 * The end of the value that a glued credential label or flag name labels, or
 * `end` (the verdict's own end) when there is none to mask (PR #5607 review).
 * The extent is read with the grammar that would read the name if it were not
 * inside the mask: the assignment walk for a label (so punctuation, hyphens,
 * escaped quotes and multiline quoted values are its own), and the
 * `secret-cli-flag` pattern for a flag. Only a credential flag that starts
 * inside that extent and whose own value runs past it ends the extension early,
 * at the flag's `--`, so the flag rule still sees its name and masks its value.
 * `limit` is the start of the next mask, which the extension never passes; the
 * reads cover only the text up to it, so the pass stays linear.
 */
function gluedValueEnd(
  text: string,
  name: GluedName,
  end: number,
  limit: number,
): number {
  // A label's quoted value can hold a later mask (an inner assignment), so it
  // is read through its real closing quote, not cut at that mask (PR #5607
  // review round 3); the extension then takes the covered masks over.
  const reach = name.kind === "label"
    ? Math.max(limit, quotedValueReach(text, end))
    : limit;
  const region = text.slice(name.start, reach);
  let extent = 0;
  if (name.kind === "flag") {
    const m = execFlagRuleAt(region, 0);
    if (m !== null && m.index === 0) extent = m[0].length;
  } else {
    const verdict = walkAssignments(region)[0];
    if (verdict !== undefined && verdict.index === 0 && verdict.masked) {
      extent = verdict.end;
    }
  }
  let valueEnd = name.start + extent;
  if (valueEnd <= end) return end;
  // A credential flag inside the extent whose value runs past it keeps its
  // name visible, so its rule masks that value instead.
  const tail = text.slice(end, reach);
  for (let at = 0; at < valueEnd - end;) {
    const m = execFlagRuleAt(tail, at);
    if (m === null || end + m.index >= valueEnd) break;
    if (end + m.index + m[0].length > valueEnd) {
      valueEnd = end + m.index;
      break;
    }
    at = m.index + m[0].length;
  }
  return Math.max(end, Math.min(valueEnd, reach));
}

/**
 * Where a quoted value that opens after `from` (past any white space) stops
 * being read, or `from` when no quote opens there (PR #5607 review round 3).
 * That is just past the first closing quote the assignment pattern's escaped
 * forms accept (a backslash escape, and `''` or `'\''` in single quotes), or,
 * for a value that never closes, the end of its line, where the pattern's
 * unclosed fallback stops. It only bounds the text the walk reads; the walk
 * still decides the extent. A plain loop with no regex keeps the scan linear:
 * the next unescaped quote of the same kind ends it, so the scans of different
 * glued values do not overlap.
 */
function quotedValueReach(text: string, from: number): number {
  let open = from;
  while (open < text.length && /\s/.test(text.charAt(open))) open++;
  const quote = text.charAt(open);
  if (quote !== "'" && quote !== '"') return from;
  for (let i = open + 1; i < text.length; i++) {
    const ch = text.charAt(i);
    if (ch === "\\") {
      i++;
    } else if (ch === quote) {
      if (quote === "'" && text.charAt(i + 1) === "'") i++;
      else if (quote === "'" && text.startsWith("\\''", i + 1)) i += 3;
      else return i + 1;
    }
  }
  for (let i = open + 1; i < text.length; i++) {
    if ("\n\r\u2028\u2029".includes(text.charAt(i))) return i;
  }
  return text.length;
}

/** Run {@link CLI_FLAG_RULE_G} once from `from`, restoring `lastIndex`. */
function execFlagRuleAt(text: string, from: number): RegExpExecArray | null {
  const resume = CLI_FLAG_RULE_G.lastIndex;
  CLI_FLAG_RULE_G.lastIndex = from;
  try {
    return CLI_FLAG_RULE_G.exec(text);
  } finally {
    CLI_FLAG_RULE_G.lastIndex = resume;
  }
}

/**
 * The credential label or flag name that the bare mask text from `from` to
 * `end` ends in, or `""` (Issue #5456). `flag` is the start of the last
 * credential flag before `end` whose value begins outside every mask; a flag
 * name inside the text has its value past `end`. A label counts only when it
 * ends in a `:` or `=` separator, and is read by {@link labelEndingAt}, whose
 * scan is bounded, so the pass stays linear.
 */
function gluedName(
  text: string,
  from: number,
  end: number,
  flag: number | undefined,
): GluedName | null {
  if (from >= end) return null;
  if (flag !== undefined && flag >= from && flag < end) {
    return { start: flag, kind: "flag" };
  }
  // Only a label with a separator has its value past `end`; a bare word that
  // merely ends in a key such as `password` is mask text and stays masked.
  if (!/[:=]/.test(text.slice(Math.max(from, end - 2), end))) return null;
  const label = labelEndingAt(text, from, end);
  return label ? { start: label.start, kind: "label" } : null;
}

/** A credential name glued after a kept quote (see {@link gluedName}). */
interface GluedName {
  /** Where the label's key or the flag's `--` starts. */
  readonly start: number;
  /** A `key:`/`key=` label, read by the walk, or a flag, read by its rule. */
  readonly kind: "label" | "flag";
}

/**
 * Closing quotes of credential flag values and starts of credential flags
 * whose values begin outside every assignment mask (Issues #5363 and #5456).
 * Both arrays are in ascending text order. The non-overlapping masks are also
 * in text order, so one pointer walks them and the flag pattern is read once.
 * An opener inside a mask is excluded: the walk already reads that flag's
 * extent, as the Issue #5310 round 13 tests pin. Bare flag values contribute a
 * flag start too, so their quotes cannot take an earlier flag's closing role.
 */
function flagClosingQuotes(
  text: string,
  masked: readonly AssignmentVerdict[],
): { closes: number[]; starts: number[] } {
  const closes: number[] = [];
  const starts: number[] = [];
  let i = 0;
  for (const m of text.matchAll(CLI_FLAG_RULE_G)) {
    const open = m.index + (m[1]?.length ?? 0);
    while (i < masked.length && (masked[i]?.end ?? 0) <= open) i++;
    const mask = masked[i];
    if (mask !== undefined && mask.end - mask.value.length <= open) continue;
    starts.push(m.index);
    const value = m[0].slice(m[1]?.length ?? 0);
    const quote = value.charAt(0);
    if (
      (quote !== "'" && quote !== '"') || value.length < 2 ||
      !value.endsWith(quote)
    ) continue;
    closes.push(m.index + m[0].length - 1);
  }
  return { closes, starts };
}

/**
 * Redact known secret shapes from a string.
 *
 * Signature rules run first, then the decode-then-rescan pass
 * ({@link redactTransformedSecrets}) masks anything hidden under a reversible
 * transform — base64, hex, `rev`, or a credential split across lines. A last
 * assignment walk then reads what that pass left of a label's value.
 *
 * @param text - Arbitrary text destined for a log sink.
 * @returns The text with any detected secrets replaced by
 *          {@link REDACTION_PLACEHOLDER}. Non-secret content is unchanged.
 */
export function redactSecrets(text: string): string {
  if (!text) return text;
  let out = text;
  for (const rule of RULES) {
    // Each rule's pattern is global; replace handles every match in the line.
    out = "apply" in rule ? rule.apply(out) : out.replace(
      rule.pattern,
      rule.replace as (substring: string, ...args: unknown[]) => string,
    );
  }
  const decoded = redactTransformedSecrets(
    out,
    matchesSignatureRule,
    REDACTION_PLACEHOLDER,
  );
  // The decode pass can mask the run a label's value was glued to
  // (`credentials:app.password<base64>`), which the walk had read as the
  // inner value: what stays of the outer value is then a plain value of its
  // label. Walk the assignments once more so the output is final (PR #5322
  // review round 17).
  const walked = redactAssignments(decoded);
  return walked === decoded ? decoded : redactTransformedSecrets(
    walked,
    matchesSignatureRule,
    REDACTION_PLACEHOLDER,
  );
}

/**
 * Report whether the given text contains at least one detectable secret.
 *
 * Useful for tests and for security-event logging that wants to note "a
 * secret was redacted" without echoing the secret itself.
 *
 * @param text - Text to inspect.
 * @returns true if redaction would change the text.
 */
export function containsSecret(text: string): boolean {
  if (!text) return false;
  return redactSecrets(text) !== text;
}
