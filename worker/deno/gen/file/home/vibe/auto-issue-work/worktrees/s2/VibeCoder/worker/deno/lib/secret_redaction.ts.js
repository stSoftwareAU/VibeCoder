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
 */ import { redactTransformedSecrets } from "./secret_transform_redaction.ts";
/**
 * The `secret-assignment` rule's pattern, named so detection and replacement
 * share one literal (Issue #1727). See the rule in `RULES` for what each group
 * means and why every quantifier is bounded.
 */ const SECRET_ASSIGNMENT_PATTERN = /\b([A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API[_-]?KEY|APIKEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|CREDENTIAL)[A-Za-z0-9_]*)(["']?\s*[=:]\s*)(?!\s)(?!["']?\*\*\*REDACTED)(?![{[])(?!\$\{\{)(?!(?:true|false|null|none|yes|no|on|off|read|write|inherit)(?![A-Za-z0-9_\-./+=@]))(?!(?:-?\d{1,20}(?:\.\d{1,20})?(?:[eE][+-]?\d{1,4})?|true|false|null)\s{0,32}[,}\]])(?=\S{0,63}[A-Za-z0-9])("[^"]+"|'[^']+'|[^\s"]+)/gi;
/** Replacement token substituted in place of a detected secret. */ export const REDACTION_PLACEHOLDER = "***REDACTED***";
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
 */ const FENCE_VALUE = /^(?:`{3,}|~{3,})[A-Za-z0-9_+#-]*$/;
/** A complete inline image — `![alt](path)` — as the whole value. */ const IMAGE_VALUE = /^!\[[^\][]*\]\([^()]*\)$/;
/** A value in matching quotes: explicit assignment syntax, not prose. */ const QUOTED_VALUE = /^(?:"[^"]*"|'[^']*')$/;
/**
 * A single word with no digit, symbol or internal capital — the shape of an
 * English sentence's first word.
 *
 * The length is **bounded**, and that bound is the rule (Issue #1727): an
 * unbounded `[a-z]*` let a lower-case passphrase such as
 * `correcthorsebatterystaple` pass as "a plain word" however long it ran,
 * which is a credential shape, not a prose shape. Fifteen characters covers
 * the words English sentences actually open with.
 */ const PLAIN_WORD = /^[A-Za-z][a-z]{0,14}$/;
/** Emphasis markers wrapping a value: at most `***`, so the strip is linear. */ const LEADING_EMPHASIS = /^[*_]{1,3}/;
/** The closing half of {@link LEADING_EMPHASIS}, bounded for the same reason. */ const TRAILING_EMPHASIS = /[*_]{1,3}$/;
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
 */ const MIN_CROSS_LINE_LENGTH = 8;
/**
 * A bare mapping key — `DEPLOY_TOKEN:` — captured as the value of a parent key
 * that ended its line (`secrets:`). Across a line break that is YAML
 * structure, the parent's first child, never a credential. Bounded and
 * anchored, so it is constant work per candidate (the Issue #3942 linearity
 * rule).
 */ const MAPPING_KEY_VALUE = /^[A-Za-z0-9_.-]{1,128}:$/;
/** Characters that end a line, so a value found past one is on a later line. */ const LINE_TERMINATOR = /[\n\r\u2028\u2029]/;
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
 */ export function isCredentialShapedValue(value, sameLine) {
  if (sameLine) return true;
  if (FENCE_VALUE.test(value) || IMAGE_VALUE.test(value)) return false;
  if (MAPPING_KEY_VALUE.test(value)) return false;
  if (QUOTED_VALUE.test(value)) return true;
  if (value.length < MIN_CROSS_LINE_LENGTH) return false;
  // Emphasis markers belong to the rendering, not to the value inside them.
  // The length floor above is measured on the whole value, so stripping them
  // cannot drop a long value under it.
  const scalar = value.replace(LEADING_EMPHASIS, "").replace(TRAILING_EMPHASIS, "");
  return !PLAIN_WORD.test(scalar);
}
/**
 * Apply {@link isCredentialShapedValue} to one `secret-assignment` match.
 *
 * The single place the separator's shape is turned into a `sameLine` verdict,
 * so the replacement pass and {@link matchesSignatureRule} cannot drift apart
 * (Issue #1727).
 */ function assignmentIsMasked(sep, value) {
  return isCredentialShapedValue(value, !LINE_TERMINATOR.test(sep));
}
/** Shortest wrap width the PEM-body fallback treats as a "long" line. */ const PEM_BODY_LINE_MIN = 40;
/**
 * Longest wrap width the PEM-body fallback will scan. A ReDoS ceiling,
 * not a PEM convention: real wrapping sits at 48–76.
 */ const PEM_BODY_LINE_MAX = 128;
/**
 * Split `text` into physical lines, keeping each line's ending so a
 * reconstructed span is byte-identical to the input when nothing is
 * redacted.
 */ function splitLinesKeepEndings(text) {
  const lines = [];
  const re = /[^\r\n]*\r?\n|[^\r\n]+/g;
  let m;
  while((m = re.exec(text)) !== null){
    lines.push(m[0]);
  }
  return lines;
}
/** Classify a physical line as a (possibly padded) base64 payload. */ function parsePemBodyLine(raw) {
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
      isBase64: false
    };
  }
  const payload = m[1] ?? "";
  const padding = m[2] ?? "";
  return {
    raw,
    payloadLen: payload.length,
    hasPadding: padding.length > 0,
    newline,
    isBase64: payload.length > 0
  };
}
/**
 * Redact uniform PEM-shaped runs inside a candidate span (Issue #196).
 *
 * A run is two or more consecutive base64 lines of the same width
 * `W` (40–128) followed by a final line of width 1..W with optional
 * `=` / `==` padding. Ragged (non-uniform) long lines are left intact,
 * including any uniform sub-run that does not meet that shape.
 */ function redactUniformPemBodyRuns(text) {
  const parsed = splitLinesKeepEndings(text).map(parsePemBodyLine);
  if (parsed.length === 0) return text;
  const out = [];
  let i = 0;
  while(i < parsed.length){
    const start = parsed[i];
    if (!start || !start.isBase64 || start.hasPadding || start.payloadLen < PEM_BODY_LINE_MIN || start.payloadLen > PEM_BODY_LINE_MAX || start.newline === "") {
      out.push(start?.raw ?? "");
      i++;
      continue;
    }
    const width = start.payloadLen;
    let j = i + 1;
    while(j < parsed.length){
      const next = parsed[j];
      if (!next || !next.isBase64 || next.hasPadding || next.payloadLen !== width || next.newline === "") {
        break;
      }
      j++;
    }
    const fullCount = j - i;
    const last = parsed[j];
    const lastIsPartial = !!last && last.isBase64 && last.payloadLen >= 1 && last.payloadLen <= width && last.payloadLen <= PEM_BODY_LINE_MAX;
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
 */ const RULES = [
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
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
    replace: ()=>REDACTION_PLACEHOLDER
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
    replace: (match)=>redactUniformPemBodyRuns(match)
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
    replace: (_m, scheme, user)=>`${scheme}${user}:${REDACTION_PLACEHOLDER}@`
  },
  // GitHub fine-grained personal access token.
  {
    name: "github-fine-grained-pat",
    pattern: /github_pat_[A-Za-z0-9_]{20,}/g,
    replace: ()=>REDACTION_PLACEHOLDER
  },
  // GitHub classic tokens: ghp_ / gho_ / ghu_ / ghs_ / ghr_ + >=36 base62.
  {
    name: "github-token",
    pattern: /gh[pousr]_[A-Za-z0-9]{36,}/g,
    replace: ()=>REDACTION_PLACEHOLDER
  },
  // Anthropic API key.
  {
    name: "anthropic-key",
    pattern: /sk-ant-[A-Za-z0-9_-]{20,}/g,
    replace: ()=>REDACTION_PLACEHOLDER
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
    replace: ()=>REDACTION_PLACEHOLDER
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
    replace: ()=>REDACTION_PLACEHOLDER
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
    pattern: /((?:AKIA|ASIA)[0-9A-Z]{16}[\s\S]{0,120}?)\b(?![0-9a-f]{40}\b)([A-Za-z0-9/+=]{40})\b/g,
    replace: (_m, lead)=>`${lead}${REDACTION_PLACEHOLDER}`
  },
  // AWS access key id.
  {
    name: "aws-access-key-id",
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    replace: ()=>REDACTION_PLACEHOLDER
  },
  // Bearer token in an Authorization header or similar. Keep the scheme.
  {
    name: "bearer-token",
    pattern: /\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
    replace: (_m, scheme)=>`${scheme} ${REDACTION_PLACEHOLDER}`
  },
  // Basic auth credential in an Authorization header (Issue #3427). The value
  // is a base64 blob of `user:token`, so it is matched by no other rule. Keep
  // the scheme; mask the encoded credential. The `{16,}` base64 minimum and
  // the `+/=` character class keep it from matching a plain word such as the
  // prose "Basic authentication".
  {
    name: "basic-auth",
    pattern: /\b(Basic)\s+[A-Za-z0-9+/]{16,}={0,2}/g,
    replace: (_m, scheme)=>`${scheme} ${REDACTION_PLACEHOLDER}`
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
  {
    name: "secret-assignment",
    pattern: SECRET_ASSIGNMENT_PATTERN,
    replace: (match, key, sep, value)=>{
      if (!assignmentIsMasked(sep, value)) return match;
      const quote = QUOTED_VALUE.test(value) ? value.charAt(0) : "";
      return `${key}${sep}${quote}${REDACTION_PLACEHOLDER}${quote}`;
    }
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
    pattern: /(--[A-Za-z0-9-]{0,63}(?:token|secret|password|passwd|api[_-]?key|apikey|access[_-]?key|private[_-]?key|credential)[A-Za-z0-9-]{0,63})(\s+)(?!-)(?!\*\*\*REDACTED)("[^"]+"|'[^']+'|\S+)/gi,
    replace: (_m, flag, sep)=>`${flag}${sep}${REDACTION_PLACEHOLDER}`
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
    replace: ()=>REDACTION_PLACEHOLDER
  }
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
 */ function matchesSignatureRule(text) {
  return RULES.some((rule)=>rule.pattern === SECRET_ASSIGNMENT_PATTERN ? detectsSecretAssignment(text) : text.search(rule.pattern) !== -1);
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
 */ function detectsSecretAssignment(text) {
  const pattern = SECRET_ASSIGNMENT_PATTERN;
  const resume = pattern.lastIndex;
  pattern.lastIndex = 0;
  try {
    let match;
    while((match = pattern.exec(text)) !== null){
      if (assignmentIsMasked(match[2] ?? "", match[3] ?? "")) return true;
    }
    return false;
  } finally{
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
 */ export function redactSecrets(text) {
  if (!text) return text;
  let out = text;
  for (const rule of RULES){
    // Each rule's pattern is global; replace handles every match in the line.
    out = out.replace(rule.pattern, rule.replace);
  }
  return redactTransformedSecrets(out, matchesSignatureRule, REDACTION_PLACEHOLDER);
}
/**
 * Report whether the given text contains at least one detectable secret.
 *
 * Useful for tests and for security-event logging that wants to note "a
 * secret was redacted" without echoing the secret itself.
 *
 * @param text - Text to inspect.
 * @returns true if redaction would change the text.
 */ export function containsSecret(text) {
  if (!text) return false;
  return redactSecrets(text) !== text;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9zZWNyZXRfcmVkYWN0aW9uLnRzIl0sInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogU2VjcmV0IHJlZGFjdGlvbiBmb3IgbG9nIG91dHB1dCAoSXNzdWUgIzI0MTcpLlxuICpcbiAqIFNlbGYtYXVkaXQgZmluZGluZzogdGhlIHdvcmtlcidzIGxvZ2dlciBpbnRlcnBvbGF0ZWQgbWVzc2FnZSBhbmQgY29udGV4dFxuICogdmFsdWVzIHZlcmJhdGltIGludG8gc3RkZXJyIChjYXB0dXJlZCBpbnRvIHdvcmtlci0qLmxvZyBhbmQgQ0kgb3V0cHV0KS5cbiAqIEFueSBzZWNyZXQgdGhhdCByZWFjaGVkIGEgYGxvZ2dlci4qYCBjYWxsIOKAlCBtb3N0IHBsYXVzaWJseSBhIHRva2VuaXNlZCBnaXRcbiAqIGNsb25lIFVSTCBpbnNpZGUgYSBgZ2l0YC9gZ2hgIGVycm9yIHN0cmluZywgb3IgYSBsb2dnZWQgdGFpbCBvZiBleHRlcm5hbFxuICogY29tbWFuZCBvdXRwdXQg4oCUIHdvdWxkIGhhdmUgbGVha2VkIGludG8gdGhvc2UgbG9ncy5cbiAqXG4gKiBgcmVkYWN0U2VjcmV0c2AgaXMgdGhlIHNpbmdsZSBjaG9rZXBvaW50IHRoYXQgbWFza3Mga25vd24gc2VjcmV0IHNoYXBlc1xuICogYmVmb3JlIGFueSBieXRlcyBhcmUgd3JpdHRlbi4gSXQgaXMgd2lyZWQgaW50byB0aGUgbG9nZ2VyJ3Mgd3JpdGUgcGF0aFxuICogKHNlZSBgbG9nZ2VyLnRzYCkgc28gcmVkYWN0aW9uIGlzIGRlZmVuY2UtaW4tZGVwdGg6IGl0IGFwcGxpZXMgcmVnYXJkbGVzc1xuICogb2Ygd2hpY2ggY2FsbGVyIHByb2R1Y2VkIHRoZSBzdHJpbmcuXG4gKlxuICogSXQgYWxzbyBndWFyZHMgdGhlICoqaW5ib3VuZCoqIHNpZGUgKElzc3VlICMxNDI0KTogdGhlIHVudHJ1c3RlZC10ZXh0XG4gKiBpbmdlc3Rpb24gY2hva2Vwb2ludCBgc2FuaXRpc2VEZWxpbWl0ZXJQYXR0ZXJuc2AgKHNlZSBgcHJvbXB0X2RlbGltaXRlci50c2ApXG4gKiByZWRhY3RzIGJlZm9yZSBpdCBzY3J1YnMsIHNvIGEgY3JlZGVudGlhbCBxdW90ZWQgaW4gYW4gaXNzdWUgYm9keSwgYVxuICogY29tbWVudCwgYSByZXBvc2l0b3J5IGd1aWRhbmNlIGRvY3VtZW50IG9yIHRoZSBjb2RlYmFzZSBtYXAgaXMgbWFza2VkXG4gKiBiZWZvcmUgaXQgYmVjb21lcyBwYXJ0IG9mIHRoZSBtb2RlbCdzIGNvbnRleHQg4oCUIG5vdCBvbmx5IGJlZm9yZSB0aGVcbiAqIG1vZGVsJ3Mgb3duIG91dHB1dCByZWFjaGVzIGEgc2luay5cbiAqXG4gKiBEZXNpZ24gbm90ZXM6XG4gKiAgLSBQYXR0ZXJucyBhcmUgZGVsaWJlcmF0ZWx5IHNwZWNpZmljIChmaXhlZCBwcmVmaXhlcywgbWluaW11bSBsZW5ndGhzLFxuICogICAgc3RydWN0dXJhbCBhbmNob3JzIGxpa2UgYHVzZXI6cGFzc0Bob3N0YCkgc28gb3JkaW5hcnkgbG9nIHRleHQg4oCUIGlzc3VlXG4gKiAgICBudW1iZXJzLCBkdXJhdGlvbnMsIGZpbGUgcGF0aHMsIHByb3NlIOKAlCBpcyBuZXZlciBhbHRlcmVkLlxuICogIC0gUmVkYWN0aW9uIG5ldmVyIHRocm93czogYSBtYWxmb3JtZWQgaW5wdXQgc2ltcGx5IHJldHVybnMgdW5jaGFuZ2VkLlxuICogIC0gRXZlcnkgcGF0dGVybiBtdXN0IGJlICoqbGluZWFyKiogaW4gdGhlIGlucHV0IGxlbmd0aCAoSXNzdWUgIzM5NDIpLlxuICogICAgYHJlZGFjdFNlY3JldHNgIHJ1bnMgc3luY2hyb25vdXNseSBvbiB0aGUgbWFpbiB0aHJlYWQgb3ZlclxuICogICAgYXR0YWNrZXItaW5mbHVlbmNlZCB0ZXh0IChtb2RlbCBzdGRvdXQsIHN1YnByb2Nlc3Mgb3V0cHV0KSwgc28gYVxuICogICAgYmFja3RyYWNraW5nIHBhdHRlcm4gc3RhbGxzIHRoZSB3aG9sZSBldmVudCBsb29wLiBBbnkgcXVhbnRpZmllciBvdmVyIGFcbiAqICAgIGJyb2FkIGNoYXJhY3RlciBjbGFzcyBpcyB0aGVyZWZvcmUgYm91bmRlZCBvciBhbmNob3JlZCBvbiBhIGxpdGVyYWwuXG4gKiAgICBOb3RlIHRoZSBpbnB1dCBpdHNlbGYgaXMgZGVsaWJlcmF0ZWx5ICoqbm90KiogdHJ1bmNhdGVkOiB0aGVcbiAqICAgIHJlZGFjdC1iZWZvcmUtdHJ1bmNhdGUgc3RhbmRhcmQgKFNFQ1VSSVRZLm1kKSByZXF1aXJlcyByZWRhY3Rpb24gdG8gY292ZXJcbiAqICAgIHRoZSB3aG9sZSB0ZXh0LCBzbyBhIHNjYW4gY2FwIHdvdWxkIHNpbGVudGx5IGxlYXZlIHRoZSB0YWlsIHVubWFza2VkLlxuICpcbiAqICAtIFNpZ25hdHVyZSBydWxlcyBvbmx5IHNlZSB0aGUgc2VjcmV0J3MgKm9yaWdpbmFsKiBieXRlcywgc28gYSBjcmVkZW50aWFsXG4gKiAgICBwdXQgdGhyb3VnaCBgYmFzZTY0YCwgYHh4ZGAgb3IgYHJldmAg4oCUIG9yIHNwbGl0IGFjcm9zcyB0d28gYGVjaG9gIGNhbGxzXG4gKiAgICDigJQgbWF0Y2hlZCBub3RoaW5nIChJc3N1ZSAjMTg4KS4gYHJlZGFjdFRyYW5zZm9ybWVkU2VjcmV0c2AgY2xvc2VzIHRoYXRcbiAqICAgIGJ5IGRlY29kaW5nIGNhbmRpZGF0ZSBydW5zIGFuZCByZS1zY2FubmluZyB0aGVtIHdpdGggdGhlIHNhbWUgcnVsZXM7XG4gKiAgICBzZWUgYHNlY3JldF90cmFuc2Zvcm1fcmVkYWN0aW9uLnRzYC5cbiAqXG4gKiBVc2VzIEF1c3RyYWxpYW4gRW5nbGlzaCB0aHJvdWdob3V0IChiZWhhdmlvdXIsIGNvbG91ciwgb3JnYW5pc2F0aW9uLCBldGMuKS5cbiAqL1xuXG5pbXBvcnQgeyByZWRhY3RUcmFuc2Zvcm1lZFNlY3JldHMgfSBmcm9tIFwiLi9zZWNyZXRfdHJhbnNmb3JtX3JlZGFjdGlvbi50c1wiO1xuXG4vKipcbiAqIFRoZSBgc2VjcmV0LWFzc2lnbm1lbnRgIHJ1bGUncyBwYXR0ZXJuLCBuYW1lZCBzbyBkZXRlY3Rpb24gYW5kIHJlcGxhY2VtZW50XG4gKiBzaGFyZSBvbmUgbGl0ZXJhbCAoSXNzdWUgIzE3MjcpLiBTZWUgdGhlIHJ1bGUgaW4gYFJVTEVTYCBmb3Igd2hhdCBlYWNoIGdyb3VwXG4gKiBtZWFucyBhbmQgd2h5IGV2ZXJ5IHF1YW50aWZpZXIgaXMgYm91bmRlZC5cbiAqL1xuY29uc3QgU0VDUkVUX0FTU0lHTk1FTlRfUEFUVEVSTiA9XG4gIC9cXGIoW0EtWmEtejAtOV9dKig/OlRPS0VOfFNFQ1JFVHxQQVNTV09SRHxQQVNTV0R8QVBJW18tXT9LRVl8QVBJS0VZfEFDQ0VTU1tfLV0/S0VZfFBSSVZBVEVbXy1dP0tFWXxDUkVERU5USUFMKVtBLVphLXowLTlfXSopKFtcIiddP1xccypbPTpdXFxzKikoPyFcXHMpKD8hW1wiJ10/XFwqXFwqXFwqUkVEQUNURUQpKD8hW3tbXSkoPyFcXCRcXHtcXHspKD8hKD86dHJ1ZXxmYWxzZXxudWxsfG5vbmV8eWVzfG5vfG9ufG9mZnxyZWFkfHdyaXRlfGluaGVyaXQpKD8hW0EtWmEtejAtOV9cXC0uLys9QF0pKSg/ISg/Oi0/XFxkezEsMjB9KD86XFwuXFxkezEsMjB9KT8oPzpbZUVdWystXT9cXGR7MSw0fSk/fHRydWV8ZmFsc2V8bnVsbClcXHN7MCwzMn1bLH1cXF1dKSg/PVxcU3swLDYzfVtBLVphLXowLTldKShcIlteXCJdK1wifCdbXiddKyd8W15cXHNcIl0rKS9naTtcblxuLyoqIFJlcGxhY2VtZW50IHRva2VuIHN1YnN0aXR1dGVkIGluIHBsYWNlIG9mIGEgZGV0ZWN0ZWQgc2VjcmV0LiAqL1xuZXhwb3J0IGNvbnN0IFJFREFDVElPTl9QTEFDRUhPTERFUiA9IFwiKioqUkVEQUNURUQqKipcIjtcblxuLyoqXG4gKiBBIHNpbmdsZSByZWRhY3Rpb24gcnVsZTogYSBwYXR0ZXJuIGFuZCB0aGUgcmVwbGFjZW1lbnQgYXBwbGllZCB0byBlYWNoXG4gKiBtYXRjaC4gVGhlIGByZXBsYWNlYCBjYWxsYmFjayByZWNlaXZlcyB0aGUgc3RhbmRhcmQgYFN0cmluZy5yZXBsYWNlYFxuICogYXJndW1lbnRzIHNvIGEgcnVsZSBjYW4gcHJlc2VydmUgYSBub24tc2VjcmV0IHByZWZpeCAoZS5nLiB0aGUgYEJlYXJlciBgXG4gKiBzY2hlbWUgb3IgYSBgVE9LRU49YCBrZXkpIHdoaWxlIG1hc2tpbmcgb25seSB0aGUgc2VjcmV0IHBvcnRpb24uXG4gKi9cbmludGVyZmFjZSBSZWRhY3Rpb25SdWxlIHtcbiAgcmVhZG9ubHkgbmFtZTogc3RyaW5nO1xuICByZWFkb25seSBwYXR0ZXJuOiBSZWdFeHA7XG4gIHJlYWRvbmx5IHJlcGxhY2U6IChtYXRjaDogc3RyaW5nLCAuLi5ncm91cHM6IHN0cmluZ1tdKSA9PiBzdHJpbmc7XG59XG5cbi8qKlxuICogVGhlIGNvbXBsZXRlIE1hcmtkb3duIGEgY3Jvc3MtbGluZSBhc3NpZ25tZW50IHZhbHVlIGNhbiBiZSwgYW5kIG5vXG4gKiBjcmVkZW50aWFsIGV2ZXIgaXMgKElzc3VlICMxNzI3KS5cbiAqXG4gKiBCb3RoIGFsdGVybmF0aXZlcyBtYXRjaCB0aGUgKip3aG9sZSoqIHZhbHVlLCBhbmQgYm90aCBhcmUgY29uc3VsdGVkIG9ubHlcbiAqIHdoZW4gdGhlIHNlcGFyYXRvciBjcm9zc2VkIGEgbGluZSBicmVhay4gTmVpdGhlciByZXN0cmljdGlvbiBpcyBjb3NtZXRpYyDigJRcbiAqIGFuIGVhcmxpZXIgcGFzcyBoYWQgdGhpcyBhcyBhICpwcmVmaXgqIHRlc3QgYXBwbGllZCBvbiBhbnkgbGluZSwgYW5kIHRoYXRcbiAqIHR1cm5lZCB0aGUgY2hva2Vwb2ludCBvZmY6IGBTRUNSRVQ6IGBgYDw0MC1jaGFyIEFXUyBrZXk+YGBgIGAgYW5kXG4gKiBgQVBJX0tFWT0hWzxrZXk+YCB3ZXJlIHB1Ymxpc2hlZCB2ZXJiYXRpbSwgYmVjYXVzZSBhIHZhbHVlIG1lcmVseSAqb3BlbmluZypcbiAqIHdpdGggYSBmZW5jZSBvciBhbiBpbWFnZSB3YXMgZXhjbHVkZWQgd2hhdGV2ZXIgZm9sbG93ZWQgaXQuIEEgZmVuY2UgbGluZVxuICogY2FycmllcyBhdCBtb3N0IGEgbGFuZ3VhZ2UgdGFnOyBhbiBpbmxpbmUgaW1hZ2UgY2xvc2VzIGl0cyBvd24gYnJhY2tldHM7IGFcbiAqIGNyZWRlbnRpYWwgZG9lcyBuZWl0aGVyLlxuICpcbiAqIEV2ZXJ5IGFsdGVybmF0aXZlIGlzIGFuY2hvcmVkIGF0IGJvdGggZW5kcyB3aXRoIG5vIG5lc3RlZCBxdWFudGlmaWVyLCBzb1xuICogdGhlIHRlc3QgaXMgbGluZWFyIGluIHRoZSB2YWx1ZSBsZW5ndGggKHRoZSBJc3N1ZSAjMzk0MiBsaW5lYXJpdHkgcnVsZSkuXG4gKi9cbmNvbnN0IEZFTkNFX1ZBTFVFID0gL14oPzpgezMsfXx+ezMsfSlbQS1aYS16MC05XysjLV0qJC87XG5cbi8qKiBBIGNvbXBsZXRlIGlubGluZSBpbWFnZSDigJQgYCFbYWx0XShwYXRoKWAg4oCUIGFzIHRoZSB3aG9sZSB2YWx1ZS4gKi9cbmNvbnN0IElNQUdFX1ZBTFVFID0gL14hXFxbW15cXF1bXSpcXF1cXChbXigpXSpcXCkkLztcblxuLyoqIEEgdmFsdWUgaW4gbWF0Y2hpbmcgcXVvdGVzOiBleHBsaWNpdCBhc3NpZ25tZW50IHN5bnRheCwgbm90IHByb3NlLiAqL1xuY29uc3QgUVVPVEVEX1ZBTFVFID0gL14oPzpcIlteXCJdKlwifCdbXiddKicpJC87XG5cbi8qKlxuICogQSBzaW5nbGUgd29yZCB3aXRoIG5vIGRpZ2l0LCBzeW1ib2wgb3IgaW50ZXJuYWwgY2FwaXRhbCDigJQgdGhlIHNoYXBlIG9mIGFuXG4gKiBFbmdsaXNoIHNlbnRlbmNlJ3MgZmlyc3Qgd29yZC5cbiAqXG4gKiBUaGUgbGVuZ3RoIGlzICoqYm91bmRlZCoqLCBhbmQgdGhhdCBib3VuZCBpcyB0aGUgcnVsZSAoSXNzdWUgIzE3MjcpOiBhblxuICogdW5ib3VuZGVkIGBbYS16XSpgIGxldCBhIGxvd2VyLWNhc2UgcGFzc3BocmFzZSBzdWNoIGFzXG4gKiBgY29ycmVjdGhvcnNlYmF0dGVyeXN0YXBsZWAgcGFzcyBhcyBcImEgcGxhaW4gd29yZFwiIGhvd2V2ZXIgbG9uZyBpdCByYW4sXG4gKiB3aGljaCBpcyBhIGNyZWRlbnRpYWwgc2hhcGUsIG5vdCBhIHByb3NlIHNoYXBlLiBGaWZ0ZWVuIGNoYXJhY3RlcnMgY292ZXJzXG4gKiB0aGUgd29yZHMgRW5nbGlzaCBzZW50ZW5jZXMgYWN0dWFsbHkgb3BlbiB3aXRoLlxuICovXG5jb25zdCBQTEFJTl9XT1JEID0gL15bQS1aYS16XVthLXpdezAsMTR9JC87XG5cbi8qKiBFbXBoYXNpcyBtYXJrZXJzIHdyYXBwaW5nIGEgdmFsdWU6IGF0IG1vc3QgYCoqKmAsIHNvIHRoZSBzdHJpcCBpcyBsaW5lYXIuICovXG5jb25zdCBMRUFESU5HX0VNUEhBU0lTID0gL15bKl9dezEsM30vO1xuXG4vKiogVGhlIGNsb3NpbmcgaGFsZiBvZiB7QGxpbmsgTEVBRElOR19FTVBIQVNJU30sIGJvdW5kZWQgZm9yIHRoZSBzYW1lIHJlYXNvbi4gKi9cbmNvbnN0IFRSQUlMSU5HX0VNUEhBU0lTID0gL1sqX117MSwzfSQvO1xuXG4vKipcbiAqIFNob3J0ZXN0IGNyb3NzLWxpbmUgdmFsdWUgc3RpbGwgdHJlYXRlZCBhcyBhIGNyZWRlbnRpYWwuXG4gKlxuICogRWlnaHQgY2hhcmFjdGVycyBpcyBzaG9ydGVyIHRoYW4gYW55dGhpbmcgYSBjcmVkZW50aWFsIGdlbmVyYXRvciBlbWl0cywgYW5kXG4gKiBsb25nIGVub3VnaCB0byBzcGFyZSB3aGF0IHByb3NlIGFjdHVhbGx5IG9wZW5zIGEgbGluZSB3aXRoIOKAlCBgVGhlYCwgYEFgLFxuICogYFdoZW5gLCBgKHNlZWAsIGBJdCdzYCwgYDEuYCwgYW5kIGFuIGlubGluZS1jb2RlIHNwYW4gc3VjaCBhcyBgYCBgaW5saW5lIGBgLFxuICogd2hvc2UgdmFsdWUgc3RvcHMgYXQgdGhlIGZpcnN0IHNwYWNlLiBBIGZsb29yIG9mIHNpeCB3YXMgdHJpZWQgYW5kIHB1dCBiYWNrOlxuICogaXQgbWFza2VkIHRoZSBvcGVuaW5nIG9mIGV2ZXJ5IHNlbnRlbmNlIHRoYXQgYmVnYW4gd2l0aCBhIGNvZGUgc3Bhbiwgd2hpY2hcbiAqIGlzIHRoZSBzYW1lIGNsYXNzIG9mIGRlZmVjdCBhcyB0aGUgZmVuY2UgdGhpcyBpc3N1ZSBpcyBhYm91dC5cbiAqXG4gKiBUaGUgZmxvb3IgYXBwbGllcyBvbmx5IGFjcm9zcyBhIGxpbmUgYnJlYWssIHNvIGFuIGlubGluZSBgUEFTU1dPUkQ9MTIzNDVgIGlzXG4gKiB1bmFmZmVjdGVkLiBBIGNyZWRlbnRpYWwgc2hvcnRlciB0aGFuIGVpZ2h0IGNoYXJhY3RlcnMgc2l0dGluZyBhbG9uZSBvbiB0aGVcbiAqIGxpbmUgKmFmdGVyKiBpdHMgbGFiZWwgaXMgdGhlIGFjY2VwdGVkIGNvc3QsIGFuZCBpdCBpcyB0aGUgY29zdCB0aGUgaXNzdWVcbiAqIGFza2VkIGZvciAoXCJtaW5pbXVtIGxlbmd0aFwiKS4gQSBjcmVkZW50aWFsIHRoYXQgc2hvcnQgc3RpbGwgY2FycnlpbmcgYVxuICogcHJvdmlkZXIgcHJlZml4IGlzIG1hc2tlZCBieSBpdHMgb3duIHNpZ25hdHVyZSBydWxlIHJlZ2FyZGxlc3MuXG4gKi9cbmNvbnN0IE1JTl9DUk9TU19MSU5FX0xFTkdUSCA9IDg7XG5cbi8qKlxuICogQSBiYXJlIG1hcHBpbmcga2V5IOKAlCBgREVQTE9ZX1RPS0VOOmAg4oCUIGNhcHR1cmVkIGFzIHRoZSB2YWx1ZSBvZiBhIHBhcmVudCBrZXlcbiAqIHRoYXQgZW5kZWQgaXRzIGxpbmUgKGBzZWNyZXRzOmApLiBBY3Jvc3MgYSBsaW5lIGJyZWFrIHRoYXQgaXMgWUFNTFxuICogc3RydWN0dXJlLCB0aGUgcGFyZW50J3MgZmlyc3QgY2hpbGQsIG5ldmVyIGEgY3JlZGVudGlhbC4gQm91bmRlZCBhbmRcbiAqIGFuY2hvcmVkLCBzbyBpdCBpcyBjb25zdGFudCB3b3JrIHBlciBjYW5kaWRhdGUgKHRoZSBJc3N1ZSAjMzk0MiBsaW5lYXJpdHlcbiAqIHJ1bGUpLlxuICovXG5jb25zdCBNQVBQSU5HX0tFWV9WQUxVRSA9IC9eW0EtWmEtejAtOV8uLV17MSwxMjh9OiQvO1xuXG4vKiogQ2hhcmFjdGVycyB0aGF0IGVuZCBhIGxpbmUsIHNvIGEgdmFsdWUgZm91bmQgcGFzdCBvbmUgaXMgb24gYSBsYXRlciBsaW5lLiAqL1xuY29uc3QgTElORV9URVJNSU5BVE9SID0gL1tcXG5cXHJcXHUyMDI4XFx1MjAyOV0vO1xuXG4vKipcbiAqIFJlcG9ydCB3aGV0aGVyIGEgbWF0Y2hlZCBgc2VjcmV0LWFzc2lnbm1lbnRgIHZhbHVlIGlzIGNyZWRlbnRpYWwtc2hhcGVkXG4gKiAoSXNzdWUgIzE3MjcpLlxuICpcbiAqIFRoZSBydWxlJ3Mgc2VwYXJhdG9yIOKAlCBgW1wiJ10/XFxzKls9Ol1cXHMqYCDigJQgc3BhbnMgbGluZSBicmVha3MsIHNvIGEgcHJvc2VcbiAqIGxpbmUgZW5kaW5nIGluIGEgY3JlZGVudGlhbC1pc2ggbGFiZWwgYWRvcHRlZCB0aGUgKm5leHQqIG5vbi1ibGFuayBsaW5lIGFzXG4gKiB0aGUgYXNzaWdubWVudCdzIHZhbHVlLiBBIFBSIGJvZHkgd2hvc2UgbGVhZC1pbiByZWFkXG4gKiBg4oCmIG5vdyBwaWNrcyBhIGNyZWRlbnRpYWw6YCBoYWQgdGhlIE1lcm1haWQgZmVuY2Ugb24gdGhlIGZvbGxvd2luZyBsaW5lXG4gKiBwdWJsaXNoZWQgYXMgdGhlIHBsYWNlaG9sZGVyLCBhbmQgdGhlIGRpYWdyYW0gYENPRElORy1TVEFOREFSRFMubWRgIHJlcXVpcmVzXG4gKiBzdG9wcGVkIHJlbmRlcmluZzsgdGhlIHByb3NlIHZhcmlhbnQgbWFza2VkIGEgc2VudGVuY2UncyBmaXJzdCB3b3JkLlxuICpcbiAqIFRoZSBsYWJlbCBzaWRlIG9mIHRoZSBydWxlIGlzIGRlbGliZXJhdGVseSBibHVudCBhbmQgc3RheXMgdGhhdCB3YXkg4oCUIGl0XG4gKiBjYXRjaGVzIHJlYWwgc2VjcmV0cy4gT25seSB0aGUgdmFsdWUgaXMganVkZ2VkLCBhbmQgb25seSB3aGVuIHRoZSBzZXBhcmF0b3JcbiAqIGNyb3NzZWQgYSBsaW5lIGJyZWFrLiAqKkFuIGlubGluZSBhc3NpZ25tZW50IGlzIG1hc2tlZCBleGFjdGx5IGFzIGJlZm9yZSoqOlxuICogYHNlY3JldF9zY2FubmluZzogZW5hYmxlZGAsIGBQQVNTV09SRD0xMjM0NWAgYW5kIGEgdmFsdWUgd3JhcHBlZCBpblxuICogYmFja3RpY2tzLCBvciBvcGVuaW5nIHdpdGggYCNgLCBgPmAgb3IgYHxgIOKAlCBhbGwgbGVnaXRpbWF0ZSBwYXNzd29yZFxuICogY2hhcmFjdGVycyDigJQgYXJlIHVudG91Y2hlZCBieSB0aGlzIHByZWRpY2F0ZS4gVGhhdCBib3VuZGFyeSBpcyBsb2FkLWJlYXJpbmc6XG4gKiBqdWRnaW5nIGlubGluZSB2YWx1ZXMgdG9vIGlzIHdoYXQgbGV0IGEgZmVuY2Utd3JhcHBlZCBzZWNyZXQgdGhyb3VnaC5cbiAqXG4gKiBBY3Jvc3MgYSBsaW5lIGJyZWFrIHRoZSB2YWx1ZSBtdXN0IGVhcm4gdGhlIG1hc2s6IGNvbXBsZXRlIE1hcmtkb3duXG4gKiAoe0BsaW5rIEZFTkNFX1ZBTFVFfSwge0BsaW5rIElNQUdFX1ZBTFVFfSkgYW5kIGEgY2hpbGQgbWFwcGluZyBrZXlcbiAqICh7QGxpbmsgTUFQUElOR19LRVlfVkFMVUV9KSBuZXZlciBkbywgYSBxdW90ZWQgdmFsdWUgYWx3YXlzXG4gKiBkb2VzLCBhbmQgYW55dGhpbmcgZWxzZSBuZWVkcyB7QGxpbmsgTUlOX0NST1NTX0xJTkVfTEVOR1RIfSBjaGFyYWN0ZXJzIGFuZCBhXG4gKiBzaGFwZSB0aGF0IGlzIG5vdCBhIHtAbGluayBQTEFJTl9XT1JEfS5cbiAqXG4gKiBFeHBvcnRlZCBmb3IgZGlyZWN0IGJvdW5kYXJ5IHRlc3RzOyB7QGxpbmsgYXNzaWdubWVudElzTWFza2VkfSBpcyBpdHMgb25seVxuICogY2FsbGVyIGluIHRoaXMgbW9kdWxlLlxuICpcbiAqIEBwYXJhbSB2YWx1ZSAtIFRoZSB2YWx1ZSB0aGUgYHNlY3JldC1hc3NpZ25tZW50YCBydWxlIGNhcHR1cmVkLlxuICogQHBhcmFtIHNhbWVMaW5lIC0gVHJ1ZSB3aGVuIHRoZSBzZXBhcmF0b3IgZGlkIG5vdCBjcm9zcyBhIGxpbmUgYnJlYWsuXG4gKiBAcmV0dXJucyBUcnVlIHdoZW4gdGhlIHZhbHVlIHNob3VsZCBiZSByZXBsYWNlZCB3aXRoIHRoZSBwbGFjZWhvbGRlci5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGlzQ3JlZGVudGlhbFNoYXBlZFZhbHVlKFxuICB2YWx1ZTogc3RyaW5nLFxuICBzYW1lTGluZTogYm9vbGVhbixcbik6IGJvb2xlYW4ge1xuICBpZiAoc2FtZUxpbmUpIHJldHVybiB0cnVlO1xuICBpZiAoRkVOQ0VfVkFMVUUudGVzdCh2YWx1ZSkgfHwgSU1BR0VfVkFMVUUudGVzdCh2YWx1ZSkpIHJldHVybiBmYWxzZTtcbiAgaWYgKE1BUFBJTkdfS0VZX1ZBTFVFLnRlc3QodmFsdWUpKSByZXR1cm4gZmFsc2U7XG4gIGlmIChRVU9URURfVkFMVUUudGVzdCh2YWx1ZSkpIHJldHVybiB0cnVlO1xuICBpZiAodmFsdWUubGVuZ3RoIDwgTUlOX0NST1NTX0xJTkVfTEVOR1RIKSByZXR1cm4gZmFsc2U7XG4gIC8vIEVtcGhhc2lzIG1hcmtlcnMgYmVsb25nIHRvIHRoZSByZW5kZXJpbmcsIG5vdCB0byB0aGUgdmFsdWUgaW5zaWRlIHRoZW0uXG4gIC8vIFRoZSBsZW5ndGggZmxvb3IgYWJvdmUgaXMgbWVhc3VyZWQgb24gdGhlIHdob2xlIHZhbHVlLCBzbyBzdHJpcHBpbmcgdGhlbVxuICAvLyBjYW5ub3QgZHJvcCBhIGxvbmcgdmFsdWUgdW5kZXIgaXQuXG4gIGNvbnN0IHNjYWxhciA9IHZhbHVlLnJlcGxhY2UoTEVBRElOR19FTVBIQVNJUywgXCJcIikucmVwbGFjZShcbiAgICBUUkFJTElOR19FTVBIQVNJUyxcbiAgICBcIlwiLFxuICApO1xuICByZXR1cm4gIVBMQUlOX1dPUkQudGVzdChzY2FsYXIpO1xufVxuXG4vKipcbiAqIEFwcGx5IHtAbGluayBpc0NyZWRlbnRpYWxTaGFwZWRWYWx1ZX0gdG8gb25lIGBzZWNyZXQtYXNzaWdubWVudGAgbWF0Y2guXG4gKlxuICogVGhlIHNpbmdsZSBwbGFjZSB0aGUgc2VwYXJhdG9yJ3Mgc2hhcGUgaXMgdHVybmVkIGludG8gYSBgc2FtZUxpbmVgIHZlcmRpY3QsXG4gKiBzbyB0aGUgcmVwbGFjZW1lbnQgcGFzcyBhbmQge0BsaW5rIG1hdGNoZXNTaWduYXR1cmVSdWxlfSBjYW5ub3QgZHJpZnQgYXBhcnRcbiAqIChJc3N1ZSAjMTcyNykuXG4gKi9cbmZ1bmN0aW9uIGFzc2lnbm1lbnRJc01hc2tlZChzZXA6IHN0cmluZywgdmFsdWU6IHN0cmluZyk6IGJvb2xlYW4ge1xuICByZXR1cm4gaXNDcmVkZW50aWFsU2hhcGVkVmFsdWUodmFsdWUsICFMSU5FX1RFUk1JTkFUT1IudGVzdChzZXApKTtcbn1cblxuLyoqIFNob3J0ZXN0IHdyYXAgd2lkdGggdGhlIFBFTS1ib2R5IGZhbGxiYWNrIHRyZWF0cyBhcyBhIFwibG9uZ1wiIGxpbmUuICovXG5jb25zdCBQRU1fQk9EWV9MSU5FX01JTiA9IDQwO1xuXG4vKipcbiAqIExvbmdlc3Qgd3JhcCB3aWR0aCB0aGUgUEVNLWJvZHkgZmFsbGJhY2sgd2lsbCBzY2FuLiBBIFJlRG9TIGNlaWxpbmcsXG4gKiBub3QgYSBQRU0gY29udmVudGlvbjogcmVhbCB3cmFwcGluZyBzaXRzIGF0IDQ44oCTNzYuXG4gKi9cbmNvbnN0IFBFTV9CT0RZX0xJTkVfTUFYID0gMTI4O1xuXG4vKiogT25lIHBoeXNpY2FsIGxpbmUgaW5zaWRlIGEgY2FuZGlkYXRlIFBFTS1ib2R5IHJ1bi4gKi9cbmludGVyZmFjZSBQZW1Cb2R5TGluZSB7XG4gIHJlYWRvbmx5IHJhdzogc3RyaW5nO1xuICByZWFkb25seSBwYXlsb2FkTGVuOiBudW1iZXI7XG4gIHJlYWRvbmx5IGhhc1BhZGRpbmc6IGJvb2xlYW47XG4gIHJlYWRvbmx5IG5ld2xpbmU6IHN0cmluZztcbiAgcmVhZG9ubHkgaXNCYXNlNjQ6IGJvb2xlYW47XG59XG5cbi8qKlxuICogU3BsaXQgYHRleHRgIGludG8gcGh5c2ljYWwgbGluZXMsIGtlZXBpbmcgZWFjaCBsaW5lJ3MgZW5kaW5nIHNvIGFcbiAqIHJlY29uc3RydWN0ZWQgc3BhbiBpcyBieXRlLWlkZW50aWNhbCB0byB0aGUgaW5wdXQgd2hlbiBub3RoaW5nIGlzXG4gKiByZWRhY3RlZC5cbiAqL1xuZnVuY3Rpb24gc3BsaXRMaW5lc0tlZXBFbmRpbmdzKHRleHQ6IHN0cmluZyk6IHN0cmluZ1tdIHtcbiAgY29uc3QgbGluZXM6IHN0cmluZ1tdID0gW107XG4gIGNvbnN0IHJlID0gL1teXFxyXFxuXSpcXHI/XFxufFteXFxyXFxuXSsvZztcbiAgbGV0IG06IFJlZ0V4cEV4ZWNBcnJheSB8IG51bGw7XG4gIHdoaWxlICgobSA9IHJlLmV4ZWModGV4dCkpICE9PSBudWxsKSB7XG4gICAgbGluZXMucHVzaChtWzBdKTtcbiAgfVxuICByZXR1cm4gbGluZXM7XG59XG5cbi8qKiBDbGFzc2lmeSBhIHBoeXNpY2FsIGxpbmUgYXMgYSAocG9zc2libHkgcGFkZGVkKSBiYXNlNjQgcGF5bG9hZC4gKi9cbmZ1bmN0aW9uIHBhcnNlUGVtQm9keUxpbmUocmF3OiBzdHJpbmcpOiBQZW1Cb2R5TGluZSB7XG4gIGxldCBuZXdsaW5lID0gXCJcIjtcbiAgbGV0IGNvbnRlbnQgPSByYXc7XG4gIGlmIChyYXcuZW5kc1dpdGgoXCJcXHJcXG5cIikpIHtcbiAgICBuZXdsaW5lID0gXCJcXHJcXG5cIjtcbiAgICBjb250ZW50ID0gcmF3LnNsaWNlKDAsIC0yKTtcbiAgfSBlbHNlIGlmIChyYXcuZW5kc1dpdGgoXCJcXG5cIikpIHtcbiAgICBuZXdsaW5lID0gXCJcXG5cIjtcbiAgICBjb250ZW50ID0gcmF3LnNsaWNlKDAsIC0xKTtcbiAgfVxuICBjb25zdCBtID0gL14oW0EtWmEtejAtOSsvXSspKD17MCwyfSkkLy5leGVjKGNvbnRlbnQpO1xuICBpZiAoIW0pIHtcbiAgICByZXR1cm4ge1xuICAgICAgcmF3LFxuICAgICAgcGF5bG9hZExlbjogMCxcbiAgICAgIGhhc1BhZGRpbmc6IGZhbHNlLFxuICAgICAgbmV3bGluZSxcbiAgICAgIGlzQmFzZTY0OiBmYWxzZSxcbiAgICB9O1xuICB9XG4gIGNvbnN0IHBheWxvYWQgPSBtWzFdID8/IFwiXCI7XG4gIGNvbnN0IHBhZGRpbmcgPSBtWzJdID8/IFwiXCI7XG4gIHJldHVybiB7XG4gICAgcmF3LFxuICAgIHBheWxvYWRMZW46IHBheWxvYWQubGVuZ3RoLFxuICAgIGhhc1BhZGRpbmc6IHBhZGRpbmcubGVuZ3RoID4gMCxcbiAgICBuZXdsaW5lLFxuICAgIGlzQmFzZTY0OiBwYXlsb2FkLmxlbmd0aCA+IDAsXG4gIH07XG59XG5cbi8qKlxuICogUmVkYWN0IHVuaWZvcm0gUEVNLXNoYXBlZCBydW5zIGluc2lkZSBhIGNhbmRpZGF0ZSBzcGFuIChJc3N1ZSAjMTk2KS5cbiAqXG4gKiBBIHJ1biBpcyB0d28gb3IgbW9yZSBjb25zZWN1dGl2ZSBiYXNlNjQgbGluZXMgb2YgdGhlIHNhbWUgd2lkdGhcbiAqIGBXYCAoNDDigJMxMjgpIGZvbGxvd2VkIGJ5IGEgZmluYWwgbGluZSBvZiB3aWR0aCAxLi5XIHdpdGggb3B0aW9uYWxcbiAqIGA9YCAvIGA9PWAgcGFkZGluZy4gUmFnZ2VkIChub24tdW5pZm9ybSkgbG9uZyBsaW5lcyBhcmUgbGVmdCBpbnRhY3QsXG4gKiBpbmNsdWRpbmcgYW55IHVuaWZvcm0gc3ViLXJ1biB0aGF0IGRvZXMgbm90IG1lZXQgdGhhdCBzaGFwZS5cbiAqL1xuZnVuY3Rpb24gcmVkYWN0VW5pZm9ybVBlbUJvZHlSdW5zKHRleHQ6IHN0cmluZyk6IHN0cmluZyB7XG4gIGNvbnN0IHBhcnNlZCA9IHNwbGl0TGluZXNLZWVwRW5kaW5ncyh0ZXh0KS5tYXAocGFyc2VQZW1Cb2R5TGluZSk7XG4gIGlmIChwYXJzZWQubGVuZ3RoID09PSAwKSByZXR1cm4gdGV4dDtcblxuICBjb25zdCBvdXQ6IHN0cmluZ1tdID0gW107XG4gIGxldCBpID0gMDtcbiAgd2hpbGUgKGkgPCBwYXJzZWQubGVuZ3RoKSB7XG4gICAgY29uc3Qgc3RhcnQgPSBwYXJzZWRbaV07XG4gICAgaWYgKFxuICAgICAgIXN0YXJ0IHx8XG4gICAgICAhc3RhcnQuaXNCYXNlNjQgfHxcbiAgICAgIHN0YXJ0Lmhhc1BhZGRpbmcgfHxcbiAgICAgIHN0YXJ0LnBheWxvYWRMZW4gPCBQRU1fQk9EWV9MSU5FX01JTiB8fFxuICAgICAgc3RhcnQucGF5bG9hZExlbiA+IFBFTV9CT0RZX0xJTkVfTUFYIHx8XG4gICAgICBzdGFydC5uZXdsaW5lID09PSBcIlwiXG4gICAgKSB7XG4gICAgICBvdXQucHVzaChzdGFydD8ucmF3ID8/IFwiXCIpO1xuICAgICAgaSsrO1xuICAgICAgY29udGludWU7XG4gICAgfVxuXG4gICAgY29uc3Qgd2lkdGggPSBzdGFydC5wYXlsb2FkTGVuO1xuICAgIGxldCBqID0gaSArIDE7XG4gICAgd2hpbGUgKGogPCBwYXJzZWQubGVuZ3RoKSB7XG4gICAgICBjb25zdCBuZXh0ID0gcGFyc2VkW2pdO1xuICAgICAgaWYgKFxuICAgICAgICAhbmV4dCB8fFxuICAgICAgICAhbmV4dC5pc0Jhc2U2NCB8fFxuICAgICAgICBuZXh0Lmhhc1BhZGRpbmcgfHxcbiAgICAgICAgbmV4dC5wYXlsb2FkTGVuICE9PSB3aWR0aCB8fFxuICAgICAgICBuZXh0Lm5ld2xpbmUgPT09IFwiXCJcbiAgICAgICkge1xuICAgICAgICBicmVhaztcbiAgICAgIH1cbiAgICAgIGorKztcbiAgICB9XG4gICAgY29uc3QgZnVsbENvdW50ID0gaiAtIGk7XG4gICAgY29uc3QgbGFzdCA9IHBhcnNlZFtqXTtcbiAgICBjb25zdCBsYXN0SXNQYXJ0aWFsID0gISFsYXN0ICYmIGxhc3QuaXNCYXNlNjQgJiZcbiAgICAgIGxhc3QucGF5bG9hZExlbiA+PSAxICYmXG4gICAgICBsYXN0LnBheWxvYWRMZW4gPD0gd2lkdGggJiZcbiAgICAgIGxhc3QucGF5bG9hZExlbiA8PSBQRU1fQk9EWV9MSU5FX01BWDtcblxuICAgIGlmIChmdWxsQ291bnQgPj0gMiAmJiBsYXN0SXNQYXJ0aWFsICYmIGxhc3QpIHtcbiAgICAgIC8vIFRoZSBwYXR0ZXJuIGRvZXMgbm90IGNvbnN1bWUgYSBuZXdsaW5lIGFmdGVyIHRoZSBmaW5hbCBwYXlsb2FkLFxuICAgICAgLy8gc28ga2VlcCB0aGF0IGVuZGluZyAoaWYgYW55KSB2aXNpYmxlIGFmdGVyIHRoZSBwbGFjZWhvbGRlci5cbiAgICAgIG91dC5wdXNoKFJFREFDVElPTl9QTEFDRUhPTERFUiArIGxhc3QubmV3bGluZSk7XG4gICAgICBpID0gaiArIDE7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgaWYgKGZ1bGxDb3VudCA+PSAzKSB7XG4gICAgICBjb25zdCB0YWlsID0gcGFyc2VkW2ogLSAxXTtcbiAgICAgIG91dC5wdXNoKFJFREFDVElPTl9QTEFDRUhPTERFUiArICh0YWlsPy5uZXdsaW5lID8/IFwiXCIpKTtcbiAgICAgIGkgPSBqO1xuICAgICAgY29udGludWU7XG4gICAgfVxuXG4gICAgb3V0LnB1c2goc3RhcnQucmF3KTtcbiAgICBpKys7XG4gIH1cbiAgcmV0dXJuIG91dC5qb2luKFwiXCIpO1xufVxuXG4vKipcbiAqIE9yZGVyZWQgcmVkYWN0aW9uIHJ1bGVzLiBVUkwtY3JlZGVudGlhbCBydWxlcyBydW4gYmVmb3JlIHRoZSBiYXJlLXRva2VuXG4gKiBydWxlcyBzbyB0aGUgaG9zdC9wYXRoIG9mIGEgdG9rZW5pc2VkIFVSTCBzdGF5cyB2aXNpYmxlIGFmdGVyIHRoZSBlbWJlZGRlZFxuICogdG9rZW4gaXMgbWFza2VkLlxuICovXG5jb25zdCBSVUxFUzogcmVhZG9ubHkgUmVkYWN0aW9uUnVsZVtdID0gW1xuICAvLyBNdWx0aS1saW5lIFBFTSBwcml2YXRlLWtleSBibG9jayAoSXNzdWUgIzMyMDMpLiBIaWdoZXN0LXZhbHVlIHNlY3JldDpcbiAgLy8gdGhlIEdpdEh1YiBBcHAgcHJpdmF0ZSBrZXkgbWludHMgaW5zdGFsbGF0aW9uIHRva2VucyBmb3IgZXZlcnkgcmVwbyB0aGVcbiAgLy8gQXBwIGNhbiByZWFjaC4gTWFza2VkIHdob2xlIChCRUdJTi4uRU5ELCBhbnkga2V5IHR5cGUpIEJFRk9SRSB0aGUgb3RoZXJcbiAgLy8gcnVsZXMgc28gYSBwYXN0ZWQgUEVNIG5ldmVyIHN1cnZpdmVzIHRoZSBjaG9rZXBvaW50IOKAlCBlLmcuIGludG8gYSBwdWJsaWNcbiAgLy8gaXNzdWUgY29tbWVudCB2aWEgdGhlIHF1ZXN0aW9uLWFuc3dlciBwYXRoLlxuICB7XG4gICAgbmFtZTogXCJwZW0tcHJpdmF0ZS1rZXlcIixcbiAgICAvLyBUaGUgRU5EIG1hcmtlciBpcyBvcHRpb25hbCAoSXNzdWUgIzM3MDcpOiBhIHRhaWwgY3V0IG1pZC1rZXksIG9yIGEgbG9nXG4gICAgLy8gbGluZSB0aGF0IG9ubHkgZWNob2VkIHRoZSBoZWFkIG9mIHRoZSBmaWxlLCBsZWZ0IHRoZSBib2R5IHVubWFza2VkXG4gICAgLy8gYmVjYXVzZSB0aGUgcnVsZSBkZW1hbmRlZCBib3RoIG1hcmtlcnMuIFdpdGhvdXQgYW4gRU5EIHRoZSBtYXRjaCBydW5zXG4gICAgLy8gdG8gdGhlIGVuZCBvZiB0aGUgdGV4dC5cbiAgICBwYXR0ZXJuOlxuICAgICAgLy0tLS0tQkVHSU4gW0EtWjAtOSBdKlBSSVZBVEUgS0VZLS0tLS1bXFxzXFxTXSo/KD86LS0tLS1FTkQgW0EtWjAtOSBdKlBSSVZBVEUgS0VZLS0tLS18JCkvZyxcbiAgICByZXBsYWNlOiAoKSA9PiBSRURBQ1RJT05fUExBQ0VIT0xERVIsXG4gIH0sXG4gIC8vIEJhcmUgUEVNIGJvZHkgd2l0aCBubyBtYXJrZXJzIGF0IGFsbCAoSXNzdWUgIzM3MDcgLyAjMTk2KS4gQSBrZXkgY2FuXG4gIC8vIHJlYWNoIGEgbG9nIHNpbmsgc3RyaXBwZWQgb2YgaXRzIGhlYWRlciDigJQgYSB0cnVuY2F0ZWQgdGFpbCwgYSBgZ3JlcGAgb2ZcbiAgLy8gdGhlIGZpbGUsIGEgSlNPTi1lc2NhcGVkIHZhbHVlIHNwbGl0IGFjcm9zcyBsaW5lcy4gVGhlIHNpZ25hbCBpcyB0d28gb3JcbiAgLy8gbW9yZSBjb25zZWN1dGl2ZSAqbG9uZyB1bmlmb3JtKiBiYXNlNjQgbGluZXMgcGx1cyBhIGZpbmFsIChwb3NzaWJseVxuICAvLyBwYWRkZWQpIGxpbmUg4oCUIG5vdCBhIGhhcmQtY29kZWQgd3JhcCB3aWR0aC4gUEVNIGlzIHdyYXBwZWQgYXQgNjQsIDc2XG4gIC8vIChNSU1FKSwgNzIsIDQ4IGFuZCBvdGhlciB3aWR0aHM7IG9yZGluYXJ5IGJhc2U2NCBpbiBsb2dzIGlzIGEgc2luZ2xlXG4gIC8vIHNob3J0IGxpbmUsIHNvIHBhdGNoIGJsb2JzLCBoYXNoZXMsIHJhZ2dlZCBsaW5lcyBhbmQgcHJvc2Ugc3RheSBpbnRhY3QuXG4gIC8vXG4gIC8vIExpbmUgd2lkdGggaXMgYm91bmRlZCAoSXNzdWUgIzM5NDIpOiBhbiB1bmJvdW5kZWQgYHs0MCx9YCBvbiBhIDUwMCBrQlxuICAvLyBzaW5nbGUtbGluZSBibG9iIGJhY2t0cmFja3MgZnJvbSBldmVyeSBzdGFydCBwb3NpdGlvbi4gMTI4IGlzIHdlbGxcbiAgLy8gYWJvdmUgYW55IHdyYXAgaW4gY2lyY3VsYXRpb24uIFVuaWZvcm1pdHkgaXMgYXNzZXJ0ZWQgaW4gdGhlIHJlcGxhY2VcbiAgLy8gY2FsbGJhY2sgc28gdGhlIHBhdHRlcm4gaXRzZWxmIHN0YXlzIGxpbmVhciBhbmQgY2Fubm90IFJlRG9TIG9uIGFcbiAgLy8gYmFja3JlZmVyZW5jZS1zdHlsZSBcInNhbWUgbGVuZ3RoXCIgY29uc3RydWN0aW9uLlxuICB7XG4gICAgbmFtZTogXCJwZW0tYm9keS1ibG9ja1wiLFxuICAgIHBhdHRlcm46IC8oPzpbQS1aYS16MC05Ky9dezQwLDEyOH1cXHI/XFxuKXsyLH1bQS1aYS16MC05Ky9dezEsMTI4fT17MCwyfS9nLFxuICAgIHJlcGxhY2U6IChtYXRjaDogc3RyaW5nKSA9PiByZWRhY3RVbmlmb3JtUGVtQm9keVJ1bnMobWF0Y2gpLFxuICB9LFxuICAvLyBDcmVkZW50aWFscyBlbWJlZGRlZCBpbiBhIFVSTDogc2NoZW1lOi8vdXNlcjpzZWNyZXRAaG9zdC9wYXRoLlxuICAvLyBLZWVwIHNjaGVtZSwgdGhlIHVzZXJuYW1lLCBhbmQgaG9zdC9wYXRoOyBtYXNrIG9ubHkgdGhlIHBhc3N3b3JkL3Rva2VuLlxuICAvL1xuICAvLyBUaGUgc2NoZW1lIHJ1biBpcyBib3VuZGVkIChJc3N1ZSAjMzk0MikuIFVuYm91bmRlZCwgYFthLXowLTkrLi1dKmAgd2FzXG4gIC8vIGdyZWVkeSwgdW5hbmNob3JlZCBhbmQg4oCUIHVuZGVyIGAvaWAg4oCUIGNvdmVyZWQgdGhlIHdob2xlIEFTQ0lJIGFscGhhbnVtZXJpY1xuICAvLyBjbGFzcywgc28gZXZlcnkgc3RhcnQgcG9zaXRpb24gaW4gYSBsb25nIGFscGhhbnVtZXJpYyBydW4gY29uc3VtZWQgdGhlXG4gIC8vIHJlbWFpbmRlciBhbmQgYmFja3RyYWNrZWQgbG9va2luZyBmb3IgYDovL2A6IHF1YWRyYXRpYywgYW5kIGVub3VnaCB0b1xuICAvLyBmcmVlemUgdGhlIHNpbmdsZS10aHJlYWRlZCB3b3JrZXIgb24gfjUwMCBrQiBvZiBtb2RlbCBvdXRwdXQuIE5vIHJlYWxcbiAgLy8gVVJMIHNjaGVtZSBhcHByb2FjaGVzIDY0IGNoYXJhY3RlcnMuXG4gIHtcbiAgICBuYW1lOiBcInVybC11c2VyaW5mb1wiLFxuICAgIHBhdHRlcm46IC8oW2Etel1bYS16MC05Ky4tXXswLDYzfTpcXC9cXC8pKFteL1xcczpAXSspOihbXi9cXHNAXSspQC9naSxcbiAgICByZXBsYWNlOiAoX20sIHNjaGVtZTogc3RyaW5nLCB1c2VyOiBzdHJpbmcpID0+XG4gICAgICBgJHtzY2hlbWV9JHt1c2VyfToke1JFREFDVElPTl9QTEFDRUhPTERFUn1AYCxcbiAgfSxcbiAgLy8gR2l0SHViIGZpbmUtZ3JhaW5lZCBwZXJzb25hbCBhY2Nlc3MgdG9rZW4uXG4gIHtcbiAgICBuYW1lOiBcImdpdGh1Yi1maW5lLWdyYWluZWQtcGF0XCIsXG4gICAgcGF0dGVybjogL2dpdGh1Yl9wYXRfW0EtWmEtejAtOV9dezIwLH0vZyxcbiAgICByZXBsYWNlOiAoKSA9PiBSRURBQ1RJT05fUExBQ0VIT0xERVIsXG4gIH0sXG4gIC8vIEdpdEh1YiBjbGFzc2ljIHRva2VuczogZ2hwXyAvIGdob18gLyBnaHVfIC8gZ2hzXyAvIGdocl8gKyA+PTM2IGJhc2U2Mi5cbiAge1xuICAgIG5hbWU6IFwiZ2l0aHViLXRva2VuXCIsXG4gICAgcGF0dGVybjogL2doW3BvdXNyXV9bQS1aYS16MC05XXszNix9L2csXG4gICAgcmVwbGFjZTogKCkgPT4gUkVEQUNUSU9OX1BMQUNFSE9MREVSLFxuICB9LFxuICAvLyBBbnRocm9waWMgQVBJIGtleS5cbiAge1xuICAgIG5hbWU6IFwiYW50aHJvcGljLWtleVwiLFxuICAgIHBhdHRlcm46IC9zay1hbnQtW0EtWmEtejAtOV8tXXsyMCx9L2csXG4gICAgcmVwbGFjZTogKCkgPT4gUkVEQUNUSU9OX1BMQUNFSE9MREVSLFxuICB9LFxuICAvLyBPcGVuQUkgLyBDb2RleCBBUEkga2V5IChJc3N1ZSAjMzYpLiBgT1BFTkFJX0FQSV9LRVlgIGFuZCBgQ09ERVhfQVBJX0tFWWBcbiAgLy8gYXJlIGxpdmUgc2VjcmV0cyBoYW5kZWQgdG8gdGhlIENvZGV4IGNoaWxkIChzZWUgYGNvZGV4X2Vudi50c2ApLCBidXQgdW50aWxcbiAgLy8gdGhpcyBydWxlIGV4aXN0ZWQgYSBiYXJlIGtleSB3YXMgbWFza2VkIG9ubHkgd2hlbiBpdCBoYXBwZW5lZCB0byBzaXQgaW4gYVxuICAvLyByZWNvZ25pc2VkIHN0cnVjdHVyZSDigJQgYW4gZW52IGFzc2lnbm1lbnQsIGEgYC0tYXBpLWtleWAgZmxhZyBvciBhIEJlYXJlclxuICAvLyBoZWFkZXIuIFRoZSBzaGFwZSB0aGF0IGFjdHVhbGx5IGxlYWtzIGhhcyBubyBzdHJ1Y3R1cmUgYXQgYWxsOiBhIENMSVxuICAvLyBlY2hvaW5nIHRoZSByZWplY3RlZCBrZXkgaW50byBzdGRlcnIsIG9yIGFuIGV4Y2VwdGlvbiBtZXNzYWdlIGNhcnJ5aW5nIGl0XG4gIC8vIGludG8gYSBzdGFjayBmcmFtZS4gQ292ZXJzIHRoZSBjbGFzc2ljIGBzay1gIGZvcm0gYW5kIHRoZSBwcm9qZWN0LXNjb3BlZFxuICAvLyBgc2stcHJvai1gIHZhcmlhbnQgKHBsdXMgYHNrLXN2Y2FjY3QtYCAvIGBzay1hZG1pbi1gLCBzYW1lIGNoYXJzZXQpLlxuICAvL1xuICAvLyBPcmRlcmluZyBtYXR0ZXJzOiB0aGlzIHJ1bGUgcnVucyAqYWZ0ZXIqIGBhbnRocm9waWMta2V5YCwgd2hpY2ggb3ducyB0aGVcbiAgLy8gb3ZlcmxhcHBpbmcgYHNrLWFudC1gIHByZWZpeC4gQnkgdGhlIHRpbWUgdGhpcyBwYXR0ZXJuIHNlZXMgdGhlIHRleHQgYW5cbiAgLy8gQW50aHJvcGljIGtleSBpcyBhbHJlYWR5IHRoZSBwbGFjZWhvbGRlciDigJQgd2hpY2ggY29udGFpbnMgbm8gYHNrLWAg4oCUIHNvXG4gIC8vIGVhY2gga2V5IHlpZWxkcyBleGFjdGx5IG9uZSBzdWJzdGl0dXRpb24gYW5kIHBsYWNlaG9sZGVycyBuZXZlciBuZXN0LlxuICAvL1xuICAvLyBCb3VuZGVkIGF0IGJvdGggZW5kcyAoSXNzdWUgIzM5NDIpLiBUaGUgMjAtY2hhcmFjdGVyIG1pbmltdW0gYW5kIHRoZSBgXFxiYFxuICAvLyBhbmNob3Iga2VlcCBvcmRpbmFyeSBoeXBoZW5hdGVkIHByb3NlIChgdGFzay1zay1ub3Rlc2ApIGZyb20gbWF0Y2hpbmc7IHRoZVxuICAvLyA1MTIgY2VpbGluZyBrZWVwcyB0aGUgcXVhbnRpZmllciBleHBsaWNpdGx5IGJvdW5kZWQgYW5kIGlzIHJvdWdobHkgdGhyZWVcbiAgLy8gdGltZXMgdGhlIGxvbmdlc3QgcmVhbCBgc2stcHJvai1gIGtleSwgc28gbm8gZ2VudWluZSBrZXkgaXMgc3BsaXQuXG4gIHtcbiAgICBuYW1lOiBcIm9wZW5haS1rZXlcIixcbiAgICBwYXR0ZXJuOiAvXFxic2stW0EtWmEtejAtOV8tXXsyMCw1MTJ9L2csXG4gICAgcmVwbGFjZTogKCkgPT4gUkVEQUNUSU9OX1BMQUNFSE9MREVSLFxuICB9LFxuICAvLyBHb29nbGUgLyBHZW1pbmkgQVBJIGtleSAoSXNzdWUgIzM2KS4gYEdFTUlOSV9BUElfS0VZYCAvIGBHT09HTEVfQVBJX0tFWWBcbiAgLy8gcmVhY2ggdGhlIEdlbWluaSBjaGlsZCAoc2VlIGBnZW1pbmlfZW52LnRzYCkgYW5kIGxlYWsgaW4gdGhlIHNhbWUgYmFyZVxuICAvLyBzaGFwZSBhcyB0aGUgT3BlbkFJIGtleSBhYm92ZS4gR29vZ2xlJ3MgZm9ybWF0IGlzIGEgZml4ZWQgMzkgY2hhcmFjdGVycyDigJRcbiAgLy8gdGhlIGBBSXphU3lgIHByZWZpeCBwbHVzIDMzIGNoYXJzZXQgY2hhcmFjdGVycyDigJQgc28gdGhlIHF1YW50aWZpZXIgaXMgYW5cbiAgLy8gZXhhY3QgY291bnQgYW5kIGlzIGJvdW5kZWQgYnkgY29uc3RydWN0aW9uLiBUaGUgZml4ZWQgbGVuZ3RoIGlzIGFsc28gd2hhdFxuICAvLyBrZWVwcyB0aGUgcnVsZSBvZmYgb3JkaW5hcnkgdGV4dDogYSBzaG9ydGVyIGBBSXphU3nigKZgIGZyYWdtZW50IGlzIGxlZnRcbiAgLy8gYWxvbmUuXG4gIHtcbiAgICBuYW1lOiBcImdvb2dsZS1hcGkta2V5XCIsXG4gICAgcGF0dGVybjogL1xcYkFJemFTeVtBLVphLXowLTlfLV17MzN9L2csXG4gICAgcmVwbGFjZTogKCkgPT4gUkVEQUNUSU9OX1BMQUNFSE9MREVSLFxuICB9LFxuICAvLyBBV1Mgc2VjcmV0IGFjY2VzcyBrZXksIGFuY2hvcmVkIHRvIHRoZSBhY2Nlc3Mta2V5IGlkIHRoYXQgcHJlY2VkZXMgaXQuXG4gIC8vXG4gIC8vIFRoZSBpZCBoYXMgYSBmaXhlZCBzaGFwZSBhbmQgaXMgbWF0Y2hlZCBvbiBpdHMgb3duIGJlbG93OyB0aGUgU0VDUkVUIGhhc1xuICAvLyBub25lIOKAlCBpdCBpcyA0MCBjaGFyYWN0ZXJzIG9mIGJhc2U2NCBhbHBoYWJldCwgdGhlIHNhbWUgc2hhcGUgYXMgYW55XG4gIC8vIGhhc2ggb3IgYmxvYiDigJQgc28gbWF0Y2hpbmcgaXQgYmFyZSB3b3VsZCByZWRhY3Qgb3JkaW5hcnkgdGV4dC4gV2hhdCBpc1xuICAvLyByZWxpYWJsZSBpcyB0aGUgcGFpcjogQVdTIGhhbmRzIHRoZSB0d28gb3V0IHRvZ2V0aGVyLCBhbmQgZXZlcnkgbGVha1xuICAvLyBzaGFwZSBjYXJyaWVzIHRoZW0gdG9nZXRoZXIgdG9vLiBUaGUgY3JlZGVudGlhbHMgQ1NWIEFXUyBpdHNlbGYgaXNzdWVzXG4gIC8vIGlzIHRoZSBjYW5vbmljYWwgb25lOlxuICAvL1xuICAvLyAgICAgVXNlciBuYW1lLEFjY2VzcyBrZXkgSUQsU2VjcmV0IGFjY2VzcyBrZXlcbiAgLy8gICAgIHN2YyxBS0lBSU9TRk9ETk43RVhBTVBMRSx3SmFsclhVdG5GRU1JL0s3TURFTkcvYlB4UmZpQ1lFWEFNUExFS0VZXG4gIC8vXG4gIC8vIFRoZSBgQVdTX1NFQ1JFVF9BQ0NFU1NfS0VZPeKApmAgYW5kIGBcImF3c19zZWNyZXRfYWNjZXNzX2tleVwiOiBcIuKAplwiYCBmb3Jtc1xuICAvLyBhcmUgYWxyZWFkeSBjb3ZlcmVkIGJ5IGBzZWNyZXQtYXNzaWdubWVudGAgYmVsb3c7IHRoaXMgcnVsZSBpcyBmb3IgdGhlXG4gIC8vIHNlY3JldCBzdGFuZGluZyBvbiBpdHMgb3duIGJlc2lkZSBpdHMgaWQuXG4gIC8vXG4gIC8vIE1VU1QgcHJlY2VkZSBgYXdzLWFjY2Vzcy1rZXktaWRgOiB0aGF0IHJ1bGUgcmVwbGFjZXMgdGhlIGFuY2hvciB3aXRoIHRoZVxuICAvLyBwbGFjZWhvbGRlciwgYW5kIGFuIGFuY2hvciB0aGF0IGlzIGdvbmUgbWF0Y2hlcyBub3RoaW5nLlxuICAvL1xuICAvLyBUaGUgd2luZG93IGlzIGJvdW5kZWQgKHRoZSBJc3N1ZSAjMzk0MiBsaW5lYXJpdHkgcnVsZSkgYW5kIHRoZSB2YWx1ZSBpc1xuICAvLyBleGNsdWRlZCBmcm9tIGJlaW5nIHB1cmUgbG93ZXJjYXNlIGhleCDigJQgYSBnaXQgY29tbWl0IFNIQSBpcyBleGFjdGx5IDQwXG4gIC8vIGhleCBjaGFyYWN0ZXJzIGFuZCBhcHBlYXJzIGJlc2lkZSByZWRhY3RlZCBtYXRlcmlhbCBjb25zdGFudGx5LlxuICB7XG4gICAgbmFtZTogXCJhd3Mtc2VjcmV0LWFjY2Vzcy1rZXlcIixcbiAgICBwYXR0ZXJuOlxuICAgICAgLygoPzpBS0lBfEFTSUEpWzAtOUEtWl17MTZ9W1xcc1xcU117MCwxMjB9PylcXGIoPyFbMC05YS1mXXs0MH1cXGIpKFtBLVphLXowLTkvKz1dezQwfSlcXGIvZyxcbiAgICByZXBsYWNlOiAoX20sIGxlYWQ6IHN0cmluZykgPT4gYCR7bGVhZH0ke1JFREFDVElPTl9QTEFDRUhPTERFUn1gLFxuICB9LFxuICAvLyBBV1MgYWNjZXNzIGtleSBpZC5cbiAge1xuICAgIG5hbWU6IFwiYXdzLWFjY2Vzcy1rZXktaWRcIixcbiAgICBwYXR0ZXJuOiAvXFxiKD86QUtJQXxBU0lBKVswLTlBLVpdezE2fVxcYi9nLFxuICAgIHJlcGxhY2U6ICgpID0+IFJFREFDVElPTl9QTEFDRUhPTERFUixcbiAgfSxcbiAgLy8gQmVhcmVyIHRva2VuIGluIGFuIEF1dGhvcml6YXRpb24gaGVhZGVyIG9yIHNpbWlsYXIuIEtlZXAgdGhlIHNjaGVtZS5cbiAge1xuICAgIG5hbWU6IFwiYmVhcmVyLXRva2VuXCIsXG4gICAgcGF0dGVybjogL1xcYihCZWFyZXIpXFxzK1tBLVphLXowLTkuX34rLz0tXXs4LH0vZ2ksXG4gICAgcmVwbGFjZTogKF9tLCBzY2hlbWU6IHN0cmluZykgPT4gYCR7c2NoZW1lfSAke1JFREFDVElPTl9QTEFDRUhPTERFUn1gLFxuICB9LFxuICAvLyBCYXNpYyBhdXRoIGNyZWRlbnRpYWwgaW4gYW4gQXV0aG9yaXphdGlvbiBoZWFkZXIgKElzc3VlICMzNDI3KS4gVGhlIHZhbHVlXG4gIC8vIGlzIGEgYmFzZTY0IGJsb2Igb2YgYHVzZXI6dG9rZW5gLCBzbyBpdCBpcyBtYXRjaGVkIGJ5IG5vIG90aGVyIHJ1bGUuIEtlZXBcbiAgLy8gdGhlIHNjaGVtZTsgbWFzayB0aGUgZW5jb2RlZCBjcmVkZW50aWFsLiBUaGUgYHsxNix9YCBiYXNlNjQgbWluaW11bSBhbmRcbiAgLy8gdGhlIGArLz1gIGNoYXJhY3RlciBjbGFzcyBrZWVwIGl0IGZyb20gbWF0Y2hpbmcgYSBwbGFpbiB3b3JkIHN1Y2ggYXMgdGhlXG4gIC8vIHByb3NlIFwiQmFzaWMgYXV0aGVudGljYXRpb25cIi5cbiAge1xuICAgIG5hbWU6IFwiYmFzaWMtYXV0aFwiLFxuICAgIHBhdHRlcm46IC9cXGIoQmFzaWMpXFxzK1tBLVphLXowLTkrL117MTYsfT17MCwyfS9nLFxuICAgIHJlcGxhY2U6IChfbSwgc2NoZW1lOiBzdHJpbmcpID0+IGAke3NjaGVtZX0gJHtSRURBQ1RJT05fUExBQ0VIT0xERVJ9YCxcbiAgfSxcbiAgLy8gRW52aXJvbm1lbnQtc3R5bGUgYXNzaWdubWVudCBvZiBhIGNsZWFybHktc2VjcmV0IGtleS4gS2VlcCB0aGUga2V5IG5hbWVcbiAgLy8gYW5kIHRoZSBzZXBhcmF0b3I7IG1hc2sgdGhlIHZhbHVlLiBUaGUga2V5IG11c3QgY29udGFpbiBhIHNlY3JldC1pc2hcbiAgLy8gd29yZCBzbyBvcmRpbmFyeSBga2V5PXZhbHVlYCBwYWlycyAoZS5nLiByZXBvPW9yZy9yZXBvKSBhcmUgbGVmdCBhbG9uZS5cbiAgLy9cbiAgLy8gVGhlIHNlcGFyYXRvciBncm91cCB0b2xlcmF0ZXMgYSBjbG9zaW5nIHF1b3RlIGFuZCBzdXJyb3VuZGluZyB3aGl0ZXNwYWNlXG4gIC8vIChJc3N1ZSAjMzcwNykgc28gdGhlIEpTT04gZm9ybSBgXCJ0b2tlblwiOiBcImFiY1wiYCDigJQgdGhlIHNoYXBlIG9mIGBnaCBhcGlgXG4gIC8vIG91dHB1dCBhbmQgb2YgYC5jcmVkZW50aWFscy5qc29uYCDigJQgbWF0Y2hlcyBhcyB3ZWxsIGFzIGBUT0tFTj1hYmNgLlxuICAvL1xuICAvLyBUaGUgdmFsdWUgbXVzdCBhbHNvIGNvbnRhaW4gYW4gYWxwaGFudW1lcmljIGNoYXJhY3RlciAoSXNzdWUgIzQwMDQpLiBFdmVyeVxuICAvLyByZWFsIGNyZWRlbnRpYWwgZG9lczsgYSBydW4gb2YgcHVyZSBwdW5jdHVhdGlvbiBkb2VzIG5vdC4gV2l0aG91dCB0aGF0XG4gIC8vIHJlcXVpcmVtZW50IHRoZSBtYXJrZG93biBsYWJlbCBgLSAqKlRva2VuczoqKiBpbnB1dCAyNyDigKZgIGluIHRoZSBydW4tc3RhdHNcbiAgLy8gY29tbWVudCByZWFkIGFzIGtleSBgVG9rZW5zYCwgc2VwYXJhdG9yIGA6YCBhbmQgdmFsdWUgYCoqYCDigJQgdGhlIGJvbGRcbiAgLy8gY2xvc2VyIOKAlCBzbyB0aGUgcGxhY2Vob2xkZXIgd2FzIHN1YnN0aXR1dGVkIG92ZXIgdGhlIGVtcGhhc2lzIG1hcmtlcnMgYW5kXG4gIC8vIGJyb2tlIHRoZSByZW5kZXJpbmcgb2YgZXZlcnkgc3RhdHMgY29tbWVudC4gVGhlIGxvb2thaGVhZCBydW4gaXMgYm91bmRlZFxuICAvLyAodGhlIElzc3VlICMzOTQyIGxpbmVhcml0eSBydWxlKTogYSBjcmVkZW50aWFsIGFsd2F5cyBjYXJyaWVzIGFuXG4gIC8vIGFscGhhbnVtZXJpYyB3ZWxsIGluc2lkZSBpdHMgZmlyc3QgNjQgY2hhcmFjdGVycywgc28gdGhlIGJvdW5kZWQgc2NhbiBjb3N0c1xuICAvLyBjb25zdGFudCB0aW1lIHBlciBjYW5kaWRhdGUgbWF0Y2guXG4gIC8vXG4gIC8vIEEgdmFsdWUgdGhhdCBvcGVucyBhIEpTT04gb2JqZWN0IG9yIGFycmF5IGlzIHN0cnVjdHVyZSwgbm90IGEgY3JlZGVudGlhbFxuICAvLyAoSXNzdWUgIzEyNTQpLiBge1wic2VjcmV0X3NjYW5uaW5nXCI6e1wic3RhdHVzXCI6XCJlbmFibGVkXCJ9fWAg4oCUIHRoZSBib2R5IHRoZVxuICAvLyByZXBvLWhhcmRlbmluZyBwYXRoIFBVVHMgdG8gZW5hYmxlIHNlY3JldCBzY2FubmluZyDigJQgbWF0Y2hlZCB0aGUgYFxcUytgXG4gIC8vIGJyYW5jaCwgd2hpY2ggc3dhbGxvd2VkIHRoZSBicmFjZSBhbmQgZXZlcnl0aGluZyBhZnRlciBpdCBhbmQgbGVmdFxuICAvLyB0cnVuY2F0ZWQsIGludmFsaWQgSlNPTi4gRXhjbHVkaW5nIGB7YCBhbmQgYFtgIGNvc3RzIG5vIGNvdmVyYWdlOiBhXG4gIC8vIGNyZWRlbnRpYWwgbmV2ZXIgc3RhcnRzIHdpdGggZWl0aGVyLCBhbmQgYSBzZWNyZXQgbmVzdGVkIGluc2lkZSB0aGUgb2JqZWN0XG4gIC8vIGlzIHN0aWxsIG1hc2tlZCBieSB0aGlzIHJ1bGUncyBvd24gcGFzcyBvdmVyIHRoZSBpbm5lciBgXCJrZXlcIjogXCJ2YWx1ZVwiYC5cbiAgLy9cbiAgLy8gVGhlIHNlcGFyYXRvcidzIGBcXHMqYCBydW5zIHNwYW5zIGxpbmUgYnJlYWtzLCBzbyBhIHByb3NlIGxpbmUgZW5kaW5nIGluIGFcbiAgLy8gY3JlZGVudGlhbCBsYWJlbCBhZG9wdGVkIHRoZSAqbmV4dCogbGluZSBhcyBpdHMgdmFsdWUgKElzc3VlICMxNzI3KSDigJQgYVxuICAvLyBNZXJtYWlkIGZlbmNlIHdhcyBwdWJsaXNoZWQgYXMgdGhlIHBsYWNlaG9sZGVyIGFuZCB0aGUgZGlhZ3JhbSBzdG9wcGVkXG4gIC8vIHJlbmRlcmluZy4gYGlzQ3JlZGVudGlhbFNoYXBlZFZhbHVlYCBqdWRnZXMgdGhlIHZhbHVlIGJlZm9yZSB0aGVcbiAgLy8gc3Vic3RpdHV0aW9uOiBNYXJrZG93biBzdHJ1Y3R1cmUgaXMgbmV2ZXIgYSBjcmVkZW50aWFsLCBhbmQgYSB2YWx1ZSB0aGVcbiAgLy8gc2VwYXJhdG9yIHJlYWNoZWQgYWNyb3NzIGEgbGluZSBicmVhayBtdXN0IGxvb2sgbGlrZSBvbmUuIEFuIGlubGluZVxuICAvLyBhc3NpZ25tZW50IGlzIHVuYWZmZWN0ZWQsIHNvIHRoZSBsYWJlbCBzaWRlIHN0YXlzIGFzIGJsdW50IGFzIGl0IHdhcy5cbiAgLy9cbiAgLy8gQSBiYXJlIHN3aXRjaCBpcyBjb25maWd1cmF0aW9uLCBub3QgYSBjcmVkZW50aWFsLiBUaGVcbiAgLy8gYGdpdGh1Yi1hY3Rpb25zLWF1ZGl0YCBpZGxlIHRhc2sgZmlsZWQgZm91cnRlZW4gaXNzdWVzIHdob3NlIHdob2xlXG4gIC8vIGluc3RydWN0aW9uIHdhcyBcImFkZCBgcGVyc2lzdC1jcmVkZW50aWFsczogZmFsc2VgXCI6IHRoZSBrZXkgY29udGFpbnNcbiAgLy8gQ1JFREVOVElBTCwgc28gdGhlIHNldHRpbmcgd2FzIHB1Ymxpc2hlZCBhcyB0aGUgcGxhY2Vob2xkZXIsIGFuZCB0aGVcbiAgLy8gYmFyZS12YWx1ZSBicmFuY2ggdG9vayB0aGUgY2xvc2luZyBiYWNrdGljayBhbmQgdGhlIGZ1bGwgc3RvcCB3aXRoIGl0LlxuICAvLyBgdHJ1ZWAsIGBmYWxzZWAsIGBudWxsYCwgYG5vbmVgLCBgeWVzYCwgYG5vYCwgYG9uYCBhbmQgYG9mZmAgc3RhbmRpbmdcbiAgLy8gYWxvbmUgYXMgdGhlIHZhbHVlIGFyZSBsZWZ0IGFsb25lLCBhbmQgc28gYXJlIGByZWFkYCBhbmQgYHdyaXRlYDogdGhlXG4gIC8vIEdpdEh1YiBBY3Rpb25zIHBlcm1pc3Npb24gbGV2ZWxzLCB3aGljaCBldmVyeSBgYmVzdC1wcmFjdGljZXNgIHdyYXBwZXJcbiAgLy8gcHVibGlzaGVkIGFzIFwiYGlkLXRva2VuOiAqKipSRURBQ1RFRCoqKmBcIiBvbiAyMDI2LTA5LTI0IGJlY2F1c2UgdGhlIGtleVxuICAvLyBjb250YWlucyBUT0tFTiAoYG5vbmVgLCB0aGUgdGhpcmQgbGV2ZWwsIHdhcyBhbHJlYWR5IGEgc3dpdGNoIHdvcmQpLlxuICAvLyBgaW5oZXJpdGAgKGBzZWNyZXRzOiBpbmhlcml0YCkgaXMgd29ya2Zsb3cgc3ludGF4IG9mIHRoZSBzYW1lIGtpbmQsIGFuZCBhXG4gIC8vIHZhbHVlIG9wZW5pbmcgYSBgJHt7IOKApiB9fWAgZXhwcmVzc2lvbiBuYW1lcyBhIHNlY3JldCByYXRoZXIgdGhhbiBob2xkaW5nXG4gIC8vIGl0OyB0aGUgYGdpdGh1Yi1hY3Rpb25zLWF1ZGl0YCBwcm9tcHQgY2FycmllcyBib3RoLiBUaGVcbiAgLy8gaW5uZXIgbG9va2FoZWFkIHJlcXVpcmVzIHRoZSB3b3JkXG4gIC8vIHRvIGVuZCB0aGVyZSwgc28gYFBBU1NXT1JEPWZhbHNlLUZsYWctOWY4ZWAgYW5kIGBBUElfS0VZPW5vMVNlY3JldGAgYXJlXG4gIC8vIHN0aWxsIG1hc2tlZC4gQm90aCBsb29rYWhlYWRzIGFyZSBmaXhlZC13aWR0aCBhbHRlcm5hdGlvbnMg4oCUIGNvbnN0YW50XG4gIC8vIHdvcmsgcGVyIGNhbmRpZGF0ZSAodGhlIElzc3VlICMzOTQyIGxpbmVhcml0eSBydWxlKS5cbiAgLy9cbiAgLy8gSlNPTiBzdHJ1Y3R1cmUgc3Vydml2ZXMgdGhlIG1hc2sgKElzc3VlICM0MTY5J3MgdHJhbnNjcmlwdCB0ZWUgaXMgdGhlXG4gIC8vIHNpbmsgdGhhdCBzaG93ZWQgaXQpLiBFdmVyeSBzdHJlYW0tanNvbiBsaW5lIHRoZSBhZ2VudCBlbWl0cyBjYXJyaWVzIGFcbiAgLy8gYFwidXNhZ2VcIjp7XCJpbnB1dF90b2tlbnNcIjo1MCwuLi59YCBibG9jayDigJQgYSBrZXkgdGhhdCBtZXJlbHkgKmNvbnRhaW5zKlxuICAvLyBUT0tFTiBmb2xsb3dlZCBieSBhIG51bWJlciDigJQgYW5kIHRoZSBgaW5pdGAgbGluZSBjYXJyaWVzXG4gIC8vIGBcImFwaUtleVNvdXJjZVwiOlwibm9uZVwiYC4gVGhlIGJhcmUtdmFsdWUgYnJhbmNoIHdhcyBgXFxTK2AsIGFuZCBjb21wYWN0IEpTT05cbiAgLy8gaGFzIG5vIHdoaXRlc3BhY2UsIHNvIHRoZSBudW1iZXIgKmFuZCBldmVyeXRoaW5nIGFmdGVyIGl0IHRvIHRoZSBlbmQgb2ZcbiAgLy8gdGhlIGxpbmUqIGJlY2FtZSB0aGUgcGxhY2Vob2xkZXI7IHRoZSBxdW90ZWQgYnJhbmNoIGRyb3BwZWQgdGhlIHF1b3RlcyBpdFxuICAvLyBtYXRjaGVkLCBsZWF2aW5nIGEgYmFyZSB3b3JkIHdoZXJlIEpTT04gbmVlZHMgYSBzdHJpbmcuIEJvdGggbGVmdCB0aGVcbiAgLy8gYXJjaGl2ZWQgdHJhbnNjcmlwdCB1bnBhcnNhYmxlIHBhc3QgaXRzIGZpcnN0IGFzc2lzdGFudCBtZXNzYWdlLCBhbmQgdGhlXG4gIC8vIHBlci1tZXNzYWdlIHVzYWdlIGZpZ3VyZXMgd2VyZSBnb25lLiBUaHJlZSBib3VuZGVkIHJlZmluZW1lbnRzOlxuICAvLyAgIC0gYSBKU09OIHNjYWxhciDigJQgYSBudW1iZXIsIGB0cnVlYCwgYGZhbHNlYCBvciBgbnVsbGAg4oCUIGZvbGxvd2VkIGJ5IHRoZVxuICAvLyAgICAgYCxgLCBgfWAgb3IgYF1gIHRoYXQgZW5kcyBhIEpTT04gbWVtYmVyIGlzIHN0cnVjdHVyZSwgbm90IGEgY3JlZGVudGlhbFxuICAvLyAgICAgKGEgY291bnQgdW5kZXIgYSBgKl90b2tlbnNgIGtleSBpcyB0aGUgZXZlcnlkYXkgY2FzZSkuIFRoZSBzY2FsYXInc1xuICAvLyAgICAgcnVucyBhcmUgYm91bmRlZCBhbmQgdGhlIHRyYWlsaW5nIHdoaXRlc3BhY2UgcnVuIGlzIGJvdW5kZWQsIHNvIHRoZVxuICAvLyAgICAgbG9va2FoZWFkIGlzIGNvbnN0YW50IHdvcmsgcGVyIGNhbmRpZGF0ZSAoSXNzdWUgIzM5NDIpLiBBbiBpbmxpbmVcbiAgLy8gICAgIGBQQVNTV09SRD0xMjM0NWAgd2l0aCBub3RoaW5nIGFmdGVyIGl0IGlzIHN0aWxsIG1hc2tlZCBhcyBiZWZvcmUuXG4gIC8vICAgLSB0aGUgYmFyZS12YWx1ZSBicmFuY2ggc3RvcHMgYXQgYSBkb3VibGUgcXVvdGUsIHNvIGEgcmVhbCBhc3NpZ25tZW50XG4gIC8vICAgICBpbnNpZGUgYSBKU09OIHN0cmluZyDigJQgYFwidGV4dFwiOlwiZXhwb3J0IFRPS0VOPWFiY1wifWAg4oCUIGlzIG1hc2tlZFxuICAvLyAgICAgd2l0aG91dCBlYXRpbmcgdGhlIHN0cmluZydzIGNsb3NpbmcgcXVvdGUgYW5kIHRoZSBtZW1iZXJzIGFmdGVyIGl0LlxuICAvLyAgIC0gYSB2YWx1ZSBtYXRjaGVkICp3aXRoKiBpdHMgcXVvdGVzIGtlZXBzIHRoZW0gYXJvdW5kIHRoZSBwbGFjZWhvbGRlcixcbiAgLy8gICAgIHNvIGBcInBhc3N3b3JkXCI6XCJodW50ZXIyXCJgIGJlY29tZXMgYFwicGFzc3dvcmRcIjpcIioqKlJFREFDVEVEKioqXCJgIGFuZFxuICAvLyAgICAgc3RpbGwgcGFyc2VzLiBUaGUgYWxyZWFkeS1yZWRhY3RlZCBsb29rYWhlYWQgdG9sZXJhdGVzIHRoYXQgb3BlbmluZ1xuICAvLyAgICAgcXVvdGUsIHNvIHRoZSBwYXNzIHN0YXlzIGlkZW1wb3RlbnQgYW5kIGBjb250YWluc1NlY3JldGAgc3RheXMgZmFsc2VcbiAgLy8gICAgIG9uIGl0cyBvd24gb3V0cHV0LlxuICB7XG4gICAgbmFtZTogXCJzZWNyZXQtYXNzaWdubWVudFwiLFxuICAgIHBhdHRlcm46IFNFQ1JFVF9BU1NJR05NRU5UX1BBVFRFUk4sXG4gICAgcmVwbGFjZTogKG1hdGNoOiBzdHJpbmcsIGtleTogc3RyaW5nLCBzZXA6IHN0cmluZywgdmFsdWU6IHN0cmluZykgPT4ge1xuICAgICAgaWYgKCFhc3NpZ25tZW50SXNNYXNrZWQoc2VwLCB2YWx1ZSkpIHJldHVybiBtYXRjaDtcbiAgICAgIGNvbnN0IHF1b3RlID0gUVVPVEVEX1ZBTFVFLnRlc3QodmFsdWUpID8gdmFsdWUuY2hhckF0KDApIDogXCJcIjtcbiAgICAgIHJldHVybiBgJHtrZXl9JHtzZXB9JHtxdW90ZX0ke1JFREFDVElPTl9QTEFDRUhPTERFUn0ke3F1b3RlfWA7XG4gICAgfSxcbiAgfSxcbiAgLy8gU3BhY2Utc2VwYXJhdGVkIENMSSBmbGFnIGNhcnJ5aW5nIGEgc2VjcmV0IChJc3N1ZSAjMzY0OCkuIFRoZVxuICAvLyBgc2VjcmV0LWFzc2lnbm1lbnRgIHJ1bGUgYWJvdmUgcmVxdWlyZXMgYW4gYD1gIG9yIGA6YCBzZXBhcmF0b3IsIHNvIGFcbiAgLy8gZmxhZy1zdHlsZSBzZWNyZXQgc3VjaCBhcyBgLS1pbWdiYi1hcGkta2V5IDAxMjNhYmNk4oCmYCAoaXNzdWVfd29ya2VyLnNoXG4gIC8vIHBhc3NlcyBleGFjdGx5IHRoYXQgc2hhcGUgdG8gYHByLW1hbmFnZXJgKSB3YXMgbWF0Y2hlZCBieSBubyBydWxlIGF0IGFsbDpcbiAgLy8gdGhlIHZhbHVlIGlzIGEgYmFyZSBoZXggYmxvYiB3aXRoIG5vIHByb3ZpZGVyIHByZWZpeC4gS2VlcCB0aGUgZmxhZyBuYW1lO1xuICAvLyBtYXNrIHRoZSBmb2xsb3dpbmcgdG9rZW4uIFRoZSB2YWx1ZSBtdXN0IG5vdCBpdHNlbGYgc3RhcnQgd2l0aCBgLWAgc28gYW5cbiAgLy8gYWRqYWNlbnQgZmxhZyAoYC0tdG9rZW4gLS12ZXJib3NlYCkgaXMgbmV2ZXIgbWlzdGFrZW4gZm9yIGEgc2VjcmV0LlxuICAvL1xuICAvLyBCb3RoIGZsYWctbmFtZSBydW5zIGFyZSBib3VuZGVkIChJc3N1ZSAjMzk0Mik6IHVuYm91bmRlZCBgW0EtWmEtejAtOS1dKmBcbiAgLy8gY29uc3VtZWQgdGhlIHJlc3Qgb2YgdGhlIHRleHQgZnJvbSBldmVyeSBgLS1gIHBvc2l0aW9uIGFuZCBiYWNrdHJhY2tlZFxuICAvLyBsb29raW5nIGZvciB0aGUga2V5d29yZCwgd2hpY2ggaXMgcXVhZHJhdGljIG9uIGEgbG9uZyBydW4gb2YgaHlwaGVucy4gTm9cbiAgLy8gQ0xJIGZsYWcgbmFtZSBhcHByb2FjaGVzIDY0IGNoYXJhY3RlcnMgZWl0aGVyIHNpZGUgb2YgdGhlIGtleXdvcmQuXG4gIHtcbiAgICBuYW1lOiBcInNlY3JldC1jbGktZmxhZ1wiLFxuICAgIHBhdHRlcm46XG4gICAgICAvKC0tW0EtWmEtejAtOS1dezAsNjN9KD86dG9rZW58c2VjcmV0fHBhc3N3b3JkfHBhc3N3ZHxhcGlbXy1dP2tleXxhcGlrZXl8YWNjZXNzW18tXT9rZXl8cHJpdmF0ZVtfLV0/a2V5fGNyZWRlbnRpYWwpW0EtWmEtejAtOS1dezAsNjN9KShcXHMrKSg/IS0pKD8hXFwqXFwqXFwqUkVEQUNURUQpKFwiW15cIl0rXCJ8J1teJ10rJ3xcXFMrKS9naSxcbiAgICByZXBsYWNlOiAoX20sIGZsYWc6IHN0cmluZywgc2VwOiBzdHJpbmcpID0+XG4gICAgICBgJHtmbGFnfSR7c2VwfSR7UkVEQUNUSU9OX1BMQUNFSE9MREVSfWAsXG4gIH0sXG4gIC8vIEJhcmUgMzItaGV4IGNyZWRlbnRpYWwg4oCUIHRoZSBJbWdCQiBBUEkga2V5IHNoYXBlIChJc3N1ZSAjMTM4NykuIFRoZSB0d29cbiAgLy8gcnVsZXMgYWJvdmUgY2F0Y2ggdGhhdCBrZXkgb25seSB3aGlsZSBpdCBrZWVwcyBpdHMgd3JhcHBlcjogYW5cbiAgLy8gYC0taW1nYmItYXBpLWtleSA8a2V5PmAgZmxhZyBvciBhIGBWSUJFX0lNR0JCX0FQSV9LRVk9PGtleT5gIGFzc2lnbm1lbnQuXG4gIC8vIFN0cmlwcGVkIG9mIGJvdGgg4oCUIGFuIHVwbG9hZCBjbGllbnQgZWNob2luZyB0aGUgcmVqZWN0ZWQga2V5IGludG8gYW5cbiAgLy8gZXJyb3Igc3RyaW5nLCBvciB0aGUga2V5IHNpdHRpbmcgaW4gYW4gYD9rZXk9YCBxdWVyeSBwYXJhbWV0ZXIg4oCUIGl0IGlzIGFcbiAgLy8gYmFyZSBoZXggYmxvYiB3aXRoIG5vIHByb3ZpZGVyIHByZWZpeCwgYW5kIG5vIHJ1bGUgbWF0Y2hlZCBpdCBhdCBhbGwuXG4gIC8vIGBleHBvcnRfc2NydWJfZ2F0ZS50c2AgaGFzIHRyZWF0ZWQgdGhpcyBleGFjdCBzaGFwZSBhcyBhIGNyZWRlbnRpYWwgc2luY2VcbiAgLy8gaXQgd2FzIHdyaXR0ZW47IHRoaXMgY2xvc2VzIHRoZSBzYW1lIGdhcCBvbiB0aGUgcmVkYWN0aW9uIGNob2tlcG9pbnQuXG4gIC8vXG4gIC8vIFNjb3BlZCBieSBsZW5ndGggYW5kIG5laWdoYm91cnMgc28gb3JkaW5hcnkgdGV4dCBzdXJ2aXZlczogZXhhY3RseSAzMlxuICAvLyBoZXggY2hhcmFjdGVycyB3aXRoIG5vIGFscGhhbnVtZXJpYyBlaXRoZXIgc2lkZS4gQSA0MC1oZXggZ2l0IFNIQSwgYVxuICAvLyA2NC1oZXggc2hhMjU2IGRpZ2VzdCBhbmQgYSBkYXNoZWQgVVVJRCBhbGwgZmFpbCB0aGF0IHRlc3QsIGFuZCB0aGUgd29ya2VyXG4gIC8vIGxvZ3MgdGhvc2UgY29uc3RhbnRseS4gVGhlIGZpeGVkIGB7MzJ9YCBjb3VudCBpcyBsaW5lYXIgYnkgY29uc3RydWN0aW9uXG4gIC8vIChJc3N1ZSAjMzk0Mikg4oCUIHRoZXJlIGlzIG5vIHF1YW50aWZpZXIgdG8gYmFja3RyYWNrIG92ZXIuXG4gIC8vXG4gIC8vIENhc2UtaW5zZW5zaXRpdmUgKElzc3VlICMxNjA1KTogdGhlIHJ1bGUgZXhpc3RzIGZvciBhIGNyZWRlbnRpYWwgdGhhdFxuICAvLyBoYXMgbG9zdCBldmVyeSBzdHJ1Y3R1cmFsIGNsdWUsIGFuZCBhIGNsaWVudCB0aGF0IG5vcm1hbGlzZXMgaGV4IHRvXG4gIC8vIHVwcGVyY2FzZSBiZWZvcmUgaW50ZXJwb2xhdGluZyBpdCBpbnRvIGEgVVJMIG9yIGFuIGVycm9yIHN0cmluZyBzdHJpcHNcbiAgLy8gdGhlIGNhc2UgY2x1ZSBhbG9uZyB3aXRoIHRoZSB3cmFwcGVyLiBUaGUgbG93ZXJjYXNlLW9ubHkgc2hhcGUgbGV0IGFuXG4gIC8vIHVwcGVyY2FzZSByZW5kZXJpbmcgb2YgdGhlIHNhbWUga2V5IHRocm91Z2ggZXZlcnkgcnVsZSBpbiB0aGlzIGZpbGUuXG4gIC8vXG4gIC8vIFJ1bnMgbGFzdCwgc28gYSBrZXkgaW5zaWRlIGEgcmVjb2duaXNlZCBzdHJ1Y3R1cmUgaXMgbWFza2VkIGJ5IHRoZVxuICAvLyBzdHJ1Y3R1cmFsIHJ1bGUgdGhhdCBvd25zIGl0IGFuZCB0aGlzIG9uZSBvbmx5IHNlZXMgd2hhdCBpcyBsZWZ0LlxuICB7XG4gICAgbmFtZTogXCJoZXgzMi1jcmVkZW50aWFsXCIsXG4gICAgcGF0dGVybjogLyg/PCFbMC05QS1aYS16XSlbMC05YS1mXXszMn0oPyFbMC05QS1aYS16XSkvZ2ksXG4gICAgcmVwbGFjZTogKCkgPT4gUkVEQUNUSU9OX1BMQUNFSE9MREVSLFxuICB9LFxuXTtcblxuLyoqXG4gKiBSZXBvcnQgd2hldGhlciBgdGV4dGAgbWF0Y2hlcyBhbnkgc2lnbmF0dXJlIHJ1bGUsIHdpdGhvdXQgcmV3cml0aW5nIGl0LlxuICogVGhpcyBpcyB0aGUgc2NhbiB0aGUgZGVjb2RlLXRoZW4tcmVzY2FuIHBhc3MgYXBwbGllcyB0byBlYWNoIGRlY29kZWRcbiAqIGNhbmRpZGF0ZSAoSXNzdWUgIzE4OCkuXG4gKlxuICogRGV0ZWN0aW9uIGdvZXMgdGhyb3VnaCBgU3RyaW5nLnByb3RvdHlwZS5zZWFyY2hgIHJhdGhlciB0aGFuXG4gKiBgUmVnRXhwLnByb3RvdHlwZS50ZXN0YDogZXZlcnkgcnVsZSBwYXR0ZXJuIGlzIGdsb2JhbCwgYW5kIGB0ZXN0KClgIHdvdWxkXG4gKiBhZHZhbmNlIGFuZCBjYXJyeSBgbGFzdEluZGV4YCBhY3Jvc3MgY2FsbHMsIG1ha2luZyB0aGUgcmVzdWx0IGRlcGVuZCBvbiB0aGVcbiAqIHByZXZpb3VzIGlucHV0LiBgc2VhcmNoYCBzYXZlcyBhbmQgcmVzdG9yZXMgYGxhc3RJbmRleGAsIHNvIHRoZSBsaXRlcmFsIHJ1bGVcbiAqIHBhdHRlcm5zIGNhbiBiZSByZXVzZWQgYXMtaXMuIENsb25pbmcgdGhlbSB0aHJvdWdoIGBuZXcgUmVnRXhwKC4uLilgIHdvdWxkXG4gKiBkbyB0aGUgc2FtZSBqb2IgYnV0IHRyaXBzIHNlbWdyZXAncyBgZGV0ZWN0LW5vbi1saXRlcmFsLXJlZ2V4cGAgcnVsZSwgYW5kIGFcbiAqIGR5bmFtaWNhbGx5LWJ1aWx0IHJlZ2V4IGlzIHRoZSB3cm9uZyBwcmltaXRpdmUgaGVyZSBhbnl3YXkg4oCUIHRoZSBwYXR0ZXJuc1xuICogYXJlIGFsbCBoYXJkY29kZWQgbGl0ZXJhbHMuXG4gKlxuICogVGhlIGBzZWNyZXQtYXNzaWdubWVudGAgcnVsZSBpcyB0aGUgb25lIGV4Y2VwdGlvbjogaXRzIG1hdGNoIGlzIG5vdCB0aGVcbiAqIHdob2xlIGRlY2lzaW9uLCBzbyBpdCBpcyBkZXRlY3RlZCB0aHJvdWdoIGBkZXRlY3RzU2VjcmV0QXNzaWdubWVudGBcbiAqIGluc3RlYWQgKElzc3VlICMxNzI3KS5cbiAqL1xuZnVuY3Rpb24gbWF0Y2hlc1NpZ25hdHVyZVJ1bGUodGV4dDogc3RyaW5nKTogYm9vbGVhbiB7XG4gIHJldHVybiBSVUxFUy5zb21lKChydWxlKSA9PlxuICAgIHJ1bGUucGF0dGVybiA9PT0gU0VDUkVUX0FTU0lHTk1FTlRfUEFUVEVSTlxuICAgICAgPyBkZXRlY3RzU2VjcmV0QXNzaWdubWVudCh0ZXh0KVxuICAgICAgOiB0ZXh0LnNlYXJjaChydWxlLnBhdHRlcm4pICE9PSAtMVxuICApO1xufVxuXG4vKipcbiAqIERldGVjdCBhIGBzZWNyZXQtYXNzaWdubWVudGAgdGhlIHJlcGxhY2VtZW50IHBhc3Mgd291bGQgYWN0dWFsbHkgbWFzay5cbiAqXG4gKiBUaGUgcGF0dGVybiBhbG9uZSBpcyBubyBsb25nZXIgdGhlIHdob2xlIGRlY2lzaW9uIChJc3N1ZSAjMTcyNyksIHNvIGFcbiAqIHBhdHRlcm4tb25seSBzY2FuIG1hZGUgYGNvbnRhaW5zU2VjcmV0YCBkaXNhZ3JlZSB3aXRoIGByZWRhY3RTZWNyZXRzYCDigJQgaXRcbiAqIHJlcG9ydGVkIGEgc2VjcmV0IGluIGEgUFIgYm9keSB3aG9zZSBvbmx5IFwic2VjcmV0XCIgd2FzIGEgTWVybWFpZCBmZW5jZSBhZnRlclxuICogYSBgY3JlZGVudGlhbDpgIGxlYWQtaW4uIEV2ZXJ5IGNhbmRpZGF0ZSBpcyBwdXQgdGhyb3VnaFxuICogYGFzc2lnbm1lbnRJc01hc2tlZGAsIHRoZSBzYW1lIHZlcmRpY3QgdGhlIHJ1bGUncyBgcmVwbGFjZWAgcmV0dXJucy5cbiAqXG4gKiBSdW5uaW5nICpldmVyeSogcnVsZSB0aHJvdWdoIGByZXBsYWNlYCBhbmQgY29tcGFyaW5nIHdvdWxkIGFuc3dlciB0aGlzIHRvbyxcbiAqIGFuZCBpdCB3YXMgdHJpZWQg4oCUIGJ1dCBpdCBzaWxlbnRseSBuYXJyb3dlZCB0aGUgb3RoZXIgcnVsZXM6XG4gKiBgcGVtLWJvZHktYmxvY2tgJ3MgY2FsbGJhY2sgbGVnaXRpbWF0ZWx5IHJldHVybnMgaXRzIGlucHV0IHVuY2hhbmdlZCBmb3IgYVxuICogbm9uLXVuaWZvcm0gbGluZSB3aWR0aCwgYW5kIHRoYXQgaGFkIGJlZW4gYSBkZXRlY3Rpb24uIFRoZSBvdGhlciBydWxlc1xuICogdGhlcmVmb3JlIGtlZXAgdGhlaXIgcGF0dGVybiBzY2FuOyBvbmx5IHRoaXMgb25lIGNvbnN1bHRzIGl0cyB2YWx1ZVxuICogcHJlZGljYXRlLlxuICpcbiAqIGBsYXN0SW5kZXhgIGlzIHNhdmVkIGFuZCByZXN0b3JlZCBhcm91bmQgdGhlIHdhbGsuIFRoZSBwYXR0ZXJuIGlzIGdsb2JhbCBhbmRcbiAqIHNoYXJlZCB3aXRoIHRoZSByZXBsYWNlbWVudCBwYXNzLCBzbyBhIGxlYWtlZCBvZmZzZXQgd291bGQgbWFrZSB0aGUgbmV4dFxuICogc2NhbiBkZXBlbmQgb24gdGhpcyBvbmUuXG4gKi9cbmZ1bmN0aW9uIGRldGVjdHNTZWNyZXRBc3NpZ25tZW50KHRleHQ6IHN0cmluZyk6IGJvb2xlYW4ge1xuICBjb25zdCBwYXR0ZXJuID0gU0VDUkVUX0FTU0lHTk1FTlRfUEFUVEVSTjtcbiAgY29uc3QgcmVzdW1lID0gcGF0dGVybi5sYXN0SW5kZXg7XG4gIHBhdHRlcm4ubGFzdEluZGV4ID0gMDtcbiAgdHJ5IHtcbiAgICBsZXQgbWF0Y2g6IFJlZ0V4cEV4ZWNBcnJheSB8IG51bGw7XG4gICAgd2hpbGUgKChtYXRjaCA9IHBhdHRlcm4uZXhlYyh0ZXh0KSkgIT09IG51bGwpIHtcbiAgICAgIGlmIChhc3NpZ25tZW50SXNNYXNrZWQobWF0Y2hbMl0gPz8gXCJcIiwgbWF0Y2hbM10gPz8gXCJcIikpIHJldHVybiB0cnVlO1xuICAgIH1cbiAgICByZXR1cm4gZmFsc2U7XG4gIH0gZmluYWxseSB7XG4gICAgcGF0dGVybi5sYXN0SW5kZXggPSByZXN1bWU7XG4gIH1cbn1cblxuLyoqXG4gKiBSZWRhY3Qga25vd24gc2VjcmV0IHNoYXBlcyBmcm9tIGEgc3RyaW5nLlxuICpcbiAqIFNpZ25hdHVyZSBydWxlcyBydW4gZmlyc3QsIHRoZW4gdGhlIGRlY29kZS10aGVuLXJlc2NhbiBwYXNzXG4gKiAoe0BsaW5rIHJlZGFjdFRyYW5zZm9ybWVkU2VjcmV0c30pIG1hc2tzIGFueXRoaW5nIGhpZGRlbiB1bmRlciBhIHJldmVyc2libGVcbiAqIHRyYW5zZm9ybSDigJQgYmFzZTY0LCBoZXgsIGByZXZgLCBvciBhIGNyZWRlbnRpYWwgc3BsaXQgYWNyb3NzIGxpbmVzLlxuICpcbiAqIEBwYXJhbSB0ZXh0IC0gQXJiaXRyYXJ5IHRleHQgZGVzdGluZWQgZm9yIGEgbG9nIHNpbmsuXG4gKiBAcmV0dXJucyBUaGUgdGV4dCB3aXRoIGFueSBkZXRlY3RlZCBzZWNyZXRzIHJlcGxhY2VkIGJ5XG4gKiAgICAgICAgICB7QGxpbmsgUkVEQUNUSU9OX1BMQUNFSE9MREVSfS4gTm9uLXNlY3JldCBjb250ZW50IGlzIHVuY2hhbmdlZC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlZGFjdFNlY3JldHModGV4dDogc3RyaW5nKTogc3RyaW5nIHtcbiAgaWYgKCF0ZXh0KSByZXR1cm4gdGV4dDtcbiAgbGV0IG91dCA9IHRleHQ7XG4gIGZvciAoY29uc3QgcnVsZSBvZiBSVUxFUykge1xuICAgIC8vIEVhY2ggcnVsZSdzIHBhdHRlcm4gaXMgZ2xvYmFsOyByZXBsYWNlIGhhbmRsZXMgZXZlcnkgbWF0Y2ggaW4gdGhlIGxpbmUuXG4gICAgb3V0ID0gb3V0LnJlcGxhY2UoXG4gICAgICBydWxlLnBhdHRlcm4sXG4gICAgICBydWxlLnJlcGxhY2UgYXMgKHN1YnN0cmluZzogc3RyaW5nLCAuLi5hcmdzOiB1bmtub3duW10pID0+IHN0cmluZyxcbiAgICApO1xuICB9XG4gIHJldHVybiByZWRhY3RUcmFuc2Zvcm1lZFNlY3JldHMoXG4gICAgb3V0LFxuICAgIG1hdGNoZXNTaWduYXR1cmVSdWxlLFxuICAgIFJFREFDVElPTl9QTEFDRUhPTERFUixcbiAgKTtcbn1cblxuLyoqXG4gKiBSZXBvcnQgd2hldGhlciB0aGUgZ2l2ZW4gdGV4dCBjb250YWlucyBhdCBsZWFzdCBvbmUgZGV0ZWN0YWJsZSBzZWNyZXQuXG4gKlxuICogVXNlZnVsIGZvciB0ZXN0cyBhbmQgZm9yIHNlY3VyaXR5LWV2ZW50IGxvZ2dpbmcgdGhhdCB3YW50cyB0byBub3RlIFwiYVxuICogc2VjcmV0IHdhcyByZWRhY3RlZFwiIHdpdGhvdXQgZWNob2luZyB0aGUgc2VjcmV0IGl0c2VsZi5cbiAqXG4gKiBAcGFyYW0gdGV4dCAtIFRleHQgdG8gaW5zcGVjdC5cbiAqIEByZXR1cm5zIHRydWUgaWYgcmVkYWN0aW9uIHdvdWxkIGNoYW5nZSB0aGUgdGV4dC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGNvbnRhaW5zU2VjcmV0KHRleHQ6IHN0cmluZyk6IGJvb2xlYW4ge1xuICBpZiAoIXRleHQpIHJldHVybiBmYWxzZTtcbiAgcmV0dXJuIHJlZGFjdFNlY3JldHModGV4dCkgIT09IHRleHQ7XG59XG4iXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUE7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztDQTBDQyxHQUVELFNBQVMsd0JBQXdCLFFBQVEsa0NBQWtDO0FBRTNFOzs7O0NBSUMsR0FDRCxNQUFNLDRCQUNKO0FBRUYsaUVBQWlFLEdBQ2pFLE9BQU8sTUFBTSx3QkFBd0IsaUJBQWlCO0FBY3REOzs7Ozs7Ozs7Ozs7Ozs7Q0FlQyxHQUNELE1BQU0sY0FBYztBQUVwQixtRUFBbUUsR0FDbkUsTUFBTSxjQUFjO0FBRXBCLHVFQUF1RSxHQUN2RSxNQUFNLGVBQWU7QUFFckI7Ozs7Ozs7OztDQVNDLEdBQ0QsTUFBTSxhQUFhO0FBRW5CLDhFQUE4RSxHQUM5RSxNQUFNLG1CQUFtQjtBQUV6QiwrRUFBK0UsR0FDL0UsTUFBTSxvQkFBb0I7QUFFMUI7Ozs7Ozs7Ozs7Ozs7OztDQWVDLEdBQ0QsTUFBTSx3QkFBd0I7QUFFOUI7Ozs7OztDQU1DLEdBQ0QsTUFBTSxvQkFBb0I7QUFFMUIsOEVBQThFLEdBQzlFLE1BQU0sa0JBQWtCO0FBRXhCOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7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
// denoCacheMetadata=16278875374954791489,4913901171415889759