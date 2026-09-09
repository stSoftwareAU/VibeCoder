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
  /\b([A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API[_-]?KEY|APIKEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|CREDENTIAL)[A-Za-z0-9_]*)(["']?\s*[=:]\s*)(?!\s)(?!\*\*\*REDACTED)(?![{[])(?=\S{0,63}[A-Za-z0-9])("[^"]+"|'[^']+'|\S+)/gi;

/** Replacement token substituted in place of a detected secret. */
export const REDACTION_PLACEHOLDER = "***REDACTED***";

/**
 * A single redaction rule: a pattern and the replacement applied to each
 * match. The `replace` callback receives the standard `String.replace`
 * arguments so a rule can preserve a non-secret prefix (e.g. the `Bearer `
 * scheme or a `TOKEN=` key) while masking only the secret portion.
 */
interface RedactionRule {
  readonly name: string;
  readonly pattern: RegExp;
  readonly replace: (match: string, ...groups: string[]) => string;
}

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

/** A value in matching quotes: explicit assignment syntax, not prose. */
const QUOTED_VALUE = /^(?:"[^"]*"|'[^']*')$/;

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

/** Characters that end a line, so a value found past one is on a later line. */
const LINE_TERMINATOR = /[\n\r\u2028\u2029]/;

/**
 * Report whether a matched `secret-assignment` value is credential-shaped
 * (Issue #1727).
 *
 * The rule's separator — `["']?\s*[=:]\s*` — spans line breaks, so a prose
 * line ending in a credential-ish label adopted the *next* non-blank line as
 * the assignment's value. A PR body whose lead-in read
 * `… now picks a credential:` had the Mermaid fence on the following line
 * published as the placeholder, and the diagram `CODING-STANDARDS.md` requires
 * stopped rendering; the prose variant masked a sentence's first word.
 *
 * The label side of the rule is deliberately blunt and stays that way — it
 * catches real secrets. Only the value is judged, and only when the separator
 * crossed a line break. **An inline assignment is masked exactly as before**:
 * `secret_scanning: enabled`, `PASSWORD=12345` and a value wrapped in
 * backticks, or opening with `#`, `>` or `|` — all legitimate password
 * characters — are untouched by this predicate. That boundary is load-bearing:
 * judging inline values too is what let a fence-wrapped secret through.
 *
 * Across a line break the value must earn the mask: complete Markdown
 * ({@link FENCE_VALUE}, {@link IMAGE_VALUE}) never does, a quoted value always
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
 * Apply {@link isCredentialShapedValue} to one `secret-assignment` match.
 *
 * The single place the separator's shape is turned into a `sameLine` verdict,
 * so the replacement pass and {@link matchesSignatureRule} cannot drift apart
 * (Issue #1727).
 */
function assignmentIsMasked(sep: string, value: string): boolean {
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
  {
    name: "aws-secret-access-key",
    pattern:
      /((?:AKIA|ASIA)[0-9A-Z]{16}[\s\S]{0,120}?)\b(?![0-9a-f]{40}\b)([A-Za-z0-9/+=]{40})\b/g,
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
  // assignment is unaffected, so the label side stays as blunt as it was.
  {
    name: "secret-assignment",
    pattern: SECRET_ASSIGNMENT_PATTERN,
    replace: (match: string, key: string, sep: string, value: string) =>
      assignmentIsMasked(sep, value)
        ? `${key}${sep}${REDACTION_PLACEHOLDER}`
        : match,
  },
  // Space-separated CLI flag carrying a secret (Issue #3648). The
  // `secret-assignment` rule above requires an `=` or `:` separator, so a
  // flag-style secret such as `--imgbb-api-key 0123abcd…` (issue_worker.sh
  // passes exactly that shape to `pr-manager`) was matched by no rule at all:
  // the value is a bare hex blob with no provider prefix. Keep the flag name;
  // mask the following token. The value must not itself start with `-` so an
  // adjacent flag (`--token --verbose`) is never mistaken for a secret.
  //
  // Both flag-name runs are bounded (Issue #3942): unbounded `[A-Za-z0-9-]*`
  // consumed the rest of the text from every `--` position and backtracked
  // looking for the keyword, which is quadratic on a long run of hyphens. No
  // CLI flag name approaches 64 characters either side of the keyword.
  {
    name: "secret-cli-flag",
    pattern:
      /(--[A-Za-z0-9-]{0,63}(?:token|secret|password|passwd|api[_-]?key|apikey|access[_-]?key|private[_-]?key|credential)[A-Za-z0-9-]{0,63})(\s+)(?!-)(?!\*\*\*REDACTED)("[^"]+"|'[^']+'|\S+)/gi,
    replace: (_m, flag: string, sep: string) =>
      `${flag}${sep}${REDACTION_PLACEHOLDER}`,
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
    rule.pattern === SECRET_ASSIGNMENT_PATTERN
      ? detectsSecretAssignment(text)
      : text.search(rule.pattern) !== -1
  );
}

/**
 * Detect a `secret-assignment` the replacement pass would actually mask.
 *
 * The pattern alone is no longer the whole decision (Issue #1727), so a
 * pattern-only scan made `containsSecret` disagree with `redactSecrets` — it
 * reported a secret in a PR body whose only "secret" was a Mermaid fence after
 * a `credential:` lead-in. Every candidate is put through
 * `assignmentIsMasked`, the same verdict the rule's `replace` returns.
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
  const pattern = SECRET_ASSIGNMENT_PATTERN;
  const resume = pattern.lastIndex;
  pattern.lastIndex = 0;
  try {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      if (assignmentIsMasked(match[2] ?? "", match[3] ?? "")) return true;
    }
    return false;
  } finally {
    pattern.lastIndex = resume;
  }
}

/**
 * Redact known secret shapes from a string.
 *
 * Signature rules run first, then the decode-then-rescan pass
 * ({@link redactTransformedSecrets}) masks anything hidden under a reversible
 * transform — base64, hex, `rev`, or a credential split across lines.
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
    out = out.replace(
      rule.pattern,
      rule.replace as (substring: string, ...args: unknown[]) => string,
    );
  }
  return redactTransformedSecrets(
    out,
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
