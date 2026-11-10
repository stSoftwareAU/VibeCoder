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
    pattern: /((?:AKIA|ASIA)[0-9A-Z]{16}[\s\S]{0,120}?)(?:(?<![A-Za-z0-9/+_])|(?<=\\[nrt]))(?![0-9a-f]{40})(?![/+=]{40})(?!=)([A-Za-z0-9/+=]{40})(?![A-Za-z0-9/+_])/g,
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9zZWNyZXRfcmVkYWN0aW9uLnRzIl0sInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogU2VjcmV0IHJlZGFjdGlvbiBmb3IgbG9nIG91dHB1dCAoSXNzdWUgIzI0MTcpLlxuICpcbiAqIFNlbGYtYXVkaXQgZmluZGluZzogdGhlIHdvcmtlcidzIGxvZ2dlciBpbnRlcnBvbGF0ZWQgbWVzc2FnZSBhbmQgY29udGV4dFxuICogdmFsdWVzIHZlcmJhdGltIGludG8gc3RkZXJyIChjYXB0dXJlZCBpbnRvIHdvcmtlci0qLmxvZyBhbmQgQ0kgb3V0cHV0KS5cbiAqIEFueSBzZWNyZXQgdGhhdCByZWFjaGVkIGEgYGxvZ2dlci4qYCBjYWxsIOKAlCBtb3N0IHBsYXVzaWJseSBhIHRva2VuaXNlZCBnaXRcbiAqIGNsb25lIFVSTCBpbnNpZGUgYSBgZ2l0YC9gZ2hgIGVycm9yIHN0cmluZywgb3IgYSBsb2dnZWQgdGFpbCBvZiBleHRlcm5hbFxuICogY29tbWFuZCBvdXRwdXQg4oCUIHdvdWxkIGhhdmUgbGVha2VkIGludG8gdGhvc2UgbG9ncy5cbiAqXG4gKiBgcmVkYWN0U2VjcmV0c2AgaXMgdGhlIHNpbmdsZSBjaG9rZXBvaW50IHRoYXQgbWFza3Mga25vd24gc2VjcmV0IHNoYXBlc1xuICogYmVmb3JlIGFueSBieXRlcyBhcmUgd3JpdHRlbi4gSXQgaXMgd2lyZWQgaW50byB0aGUgbG9nZ2VyJ3Mgd3JpdGUgcGF0aFxuICogKHNlZSBgbG9nZ2VyLnRzYCkgc28gcmVkYWN0aW9uIGlzIGRlZmVuY2UtaW4tZGVwdGg6IGl0IGFwcGxpZXMgcmVnYXJkbGVzc1xuICogb2Ygd2hpY2ggY2FsbGVyIHByb2R1Y2VkIHRoZSBzdHJpbmcuXG4gKlxuICogSXQgYWxzbyBndWFyZHMgdGhlICoqaW5ib3VuZCoqIHNpZGUgKElzc3VlICMxNDI0KTogdGhlIHVudHJ1c3RlZC10ZXh0XG4gKiBpbmdlc3Rpb24gY2hva2Vwb2ludCBgc2FuaXRpc2VEZWxpbWl0ZXJQYXR0ZXJuc2AgKHNlZSBgcHJvbXB0X2RlbGltaXRlci50c2ApXG4gKiByZWRhY3RzIGJlZm9yZSBpdCBzY3J1YnMsIHNvIGEgY3JlZGVudGlhbCBxdW90ZWQgaW4gYW4gaXNzdWUgYm9keSwgYVxuICogY29tbWVudCwgYSByZXBvc2l0b3J5IGd1aWRhbmNlIGRvY3VtZW50IG9yIHRoZSBjb2RlYmFzZSBtYXAgaXMgbWFza2VkXG4gKiBiZWZvcmUgaXQgYmVjb21lcyBwYXJ0IG9mIHRoZSBtb2RlbCdzIGNvbnRleHQg4oCUIG5vdCBvbmx5IGJlZm9yZSB0aGVcbiAqIG1vZGVsJ3Mgb3duIG91dHB1dCByZWFjaGVzIGEgc2luay5cbiAqXG4gKiBEZXNpZ24gbm90ZXM6XG4gKiAgLSBQYXR0ZXJucyBhcmUgZGVsaWJlcmF0ZWx5IHNwZWNpZmljIChmaXhlZCBwcmVmaXhlcywgbWluaW11bSBsZW5ndGhzLFxuICogICAgc3RydWN0dXJhbCBhbmNob3JzIGxpa2UgYHVzZXI6cGFzc0Bob3N0YCkgc28gb3JkaW5hcnkgbG9nIHRleHQg4oCUIGlzc3VlXG4gKiAgICBudW1iZXJzLCBkdXJhdGlvbnMsIGZpbGUgcGF0aHMsIHByb3NlIOKAlCBpcyBuZXZlciBhbHRlcmVkLlxuICogIC0gUmVkYWN0aW9uIG5ldmVyIHRocm93czogYSBtYWxmb3JtZWQgaW5wdXQgc2ltcGx5IHJldHVybnMgdW5jaGFuZ2VkLlxuICogIC0gRXZlcnkgcGF0dGVybiBtdXN0IGJlICoqbGluZWFyKiogaW4gdGhlIGlucHV0IGxlbmd0aCAoSXNzdWUgIzM5NDIpLlxuICogICAgYHJlZGFjdFNlY3JldHNgIHJ1bnMgc3luY2hyb25vdXNseSBvbiB0aGUgbWFpbiB0aHJlYWQgb3ZlclxuICogICAgYXR0YWNrZXItaW5mbHVlbmNlZCB0ZXh0IChtb2RlbCBzdGRvdXQsIHN1YnByb2Nlc3Mgb3V0cHV0KSwgc28gYVxuICogICAgYmFja3RyYWNraW5nIHBhdHRlcm4gc3RhbGxzIHRoZSB3aG9sZSBldmVudCBsb29wLiBBbnkgcXVhbnRpZmllciBvdmVyIGFcbiAqICAgIGJyb2FkIGNoYXJhY3RlciBjbGFzcyBpcyB0aGVyZWZvcmUgYm91bmRlZCBvciBhbmNob3JlZCBvbiBhIGxpdGVyYWwuXG4gKiAgICBOb3RlIHRoZSBpbnB1dCBpdHNlbGYgaXMgZGVsaWJlcmF0ZWx5ICoqbm90KiogdHJ1bmNhdGVkOiB0aGVcbiAqICAgIHJlZGFjdC1iZWZvcmUtdHJ1bmNhdGUgc3RhbmRhcmQgKFNFQ1VSSVRZLm1kKSByZXF1aXJlcyByZWRhY3Rpb24gdG8gY292ZXJcbiAqICAgIHRoZSB3aG9sZSB0ZXh0LCBzbyBhIHNjYW4gY2FwIHdvdWxkIHNpbGVudGx5IGxlYXZlIHRoZSB0YWlsIHVubWFza2VkLlxuICpcbiAqICAtIFNpZ25hdHVyZSBydWxlcyBvbmx5IHNlZSB0aGUgc2VjcmV0J3MgKm9yaWdpbmFsKiBieXRlcywgc28gYSBjcmVkZW50aWFsXG4gKiAgICBwdXQgdGhyb3VnaCBgYmFzZTY0YCwgYHh4ZGAgb3IgYHJldmAg4oCUIG9yIHNwbGl0IGFjcm9zcyB0d28gYGVjaG9gIGNhbGxzXG4gKiAgICDigJQgbWF0Y2hlZCBub3RoaW5nIChJc3N1ZSAjMTg4KS4gYHJlZGFjdFRyYW5zZm9ybWVkU2VjcmV0c2AgY2xvc2VzIHRoYXRcbiAqICAgIGJ5IGRlY29kaW5nIGNhbmRpZGF0ZSBydW5zIGFuZCByZS1zY2FubmluZyB0aGVtIHdpdGggdGhlIHNhbWUgcnVsZXM7XG4gKiAgICBzZWUgYHNlY3JldF90cmFuc2Zvcm1fcmVkYWN0aW9uLnRzYC5cbiAqXG4gKiBVc2VzIEF1c3RyYWxpYW4gRW5nbGlzaCB0aHJvdWdob3V0IChiZWhhdmlvdXIsIGNvbG91ciwgb3JnYW5pc2F0aW9uLCBldGMuKS5cbiAqL1xuXG5pbXBvcnQgeyByZWRhY3RUcmFuc2Zvcm1lZFNlY3JldHMgfSBmcm9tIFwiLi9zZWNyZXRfdHJhbnNmb3JtX3JlZGFjdGlvbi50c1wiO1xuXG4vKipcbiAqIFRoZSBgc2VjcmV0LWFzc2lnbm1lbnRgIHJ1bGUncyBwYXR0ZXJuLCBuYW1lZCBzbyBkZXRlY3Rpb24gYW5kIHJlcGxhY2VtZW50XG4gKiBzaGFyZSBvbmUgbGl0ZXJhbCAoSXNzdWUgIzE3MjcpLiBTZWUgdGhlIHJ1bGUgaW4gYFJVTEVTYCBmb3Igd2hhdCBlYWNoIGdyb3VwXG4gKiBtZWFucyBhbmQgd2h5IGV2ZXJ5IHF1YW50aWZpZXIgaXMgYm91bmRlZC5cbiAqL1xuY29uc3QgU0VDUkVUX0FTU0lHTk1FTlRfUEFUVEVSTiA9XG4gIC9cXGIoW0EtWmEtejAtOV9dKig/OlRPS0VOfFNFQ1JFVHxQQVNTV09SRHxQQVNTV0R8QVBJW18tXT9LRVl8QVBJS0VZfEFDQ0VTU1tfLV0/S0VZfFBSSVZBVEVbXy1dP0tFWXxDUkVERU5USUFMKVtBLVphLXowLTlfXSopKFtcIiddP1xccypbPTpdXFxzKikoPyFcXHMpKD8hW1wiJ10/XFwqXFwqXFwqUkVEQUNURUQpKD8hW3tbXSkoPyFcXCRcXHtcXHspKD8hKD86dHJ1ZXxmYWxzZXxudWxsfG5vbmV8eWVzfG5vfG9ufG9mZnxyZWFkfHdyaXRlfGluaGVyaXQpKD8hW0EtWmEtejAtOV9cXC0uLys9QF0pKSg/ISg/Oi0/XFxkezEsMjB9KD86XFwuXFxkezEsMjB9KT8oPzpbZUVdWystXT9cXGR7MSw0fSk/fHRydWV8ZmFsc2V8bnVsbClcXHN7MCwzMn1bLH1cXF1dKSg/PVxcU3swLDYzfVtBLVphLXowLTldKShcIlteXCJdK1wifCdbXiddKyd8W15cXHNcIl0rKS9naTtcblxuLyoqIFJlcGxhY2VtZW50IHRva2VuIHN1YnN0aXR1dGVkIGluIHBsYWNlIG9mIGEgZGV0ZWN0ZWQgc2VjcmV0LiAqL1xuZXhwb3J0IGNvbnN0IFJFREFDVElPTl9QTEFDRUhPTERFUiA9IFwiKioqUkVEQUNURUQqKipcIjtcblxuLyoqXG4gKiBBIHNpbmdsZSByZWRhY3Rpb24gcnVsZTogYSBwYXR0ZXJuIGFuZCB0aGUgcmVwbGFjZW1lbnQgYXBwbGllZCB0byBlYWNoXG4gKiBtYXRjaC4gVGhlIGByZXBsYWNlYCBjYWxsYmFjayByZWNlaXZlcyB0aGUgc3RhbmRhcmQgYFN0cmluZy5yZXBsYWNlYFxuICogYXJndW1lbnRzIHNvIGEgcnVsZSBjYW4gcHJlc2VydmUgYSBub24tc2VjcmV0IHByZWZpeCAoZS5nLiB0aGUgYEJlYXJlciBgXG4gKiBzY2hlbWUgb3IgYSBgVE9LRU49YCBrZXkpIHdoaWxlIG1hc2tpbmcgb25seSB0aGUgc2VjcmV0IHBvcnRpb24uXG4gKi9cbmludGVyZmFjZSBSZWRhY3Rpb25SdWxlIHtcbiAgcmVhZG9ubHkgbmFtZTogc3RyaW5nO1xuICByZWFkb25seSBwYXR0ZXJuOiBSZWdFeHA7XG4gIHJlYWRvbmx5IHJlcGxhY2U6IChtYXRjaDogc3RyaW5nLCAuLi5ncm91cHM6IHN0cmluZ1tdKSA9PiBzdHJpbmc7XG59XG5cbi8qKlxuICogVGhlIGNvbXBsZXRlIE1hcmtkb3duIGEgY3Jvc3MtbGluZSBhc3NpZ25tZW50IHZhbHVlIGNhbiBiZSwgYW5kIG5vXG4gKiBjcmVkZW50aWFsIGV2ZXIgaXMgKElzc3VlICMxNzI3KS5cbiAqXG4gKiBCb3RoIGFsdGVybmF0aXZlcyBtYXRjaCB0aGUgKip3aG9sZSoqIHZhbHVlLCBhbmQgYm90aCBhcmUgY29uc3VsdGVkIG9ubHlcbiAqIHdoZW4gdGhlIHNlcGFyYXRvciBjcm9zc2VkIGEgbGluZSBicmVhay4gTmVpdGhlciByZXN0cmljdGlvbiBpcyBjb3NtZXRpYyDigJRcbiAqIGFuIGVhcmxpZXIgcGFzcyBoYWQgdGhpcyBhcyBhICpwcmVmaXgqIHRlc3QgYXBwbGllZCBvbiBhbnkgbGluZSwgYW5kIHRoYXRcbiAqIHR1cm5lZCB0aGUgY2hva2Vwb2ludCBvZmY6IGBTRUNSRVQ6IGBgYDw0MC1jaGFyIEFXUyBrZXk+YGBgIGAgYW5kXG4gKiBgQVBJX0tFWT0hWzxrZXk+YCB3ZXJlIHB1Ymxpc2hlZCB2ZXJiYXRpbSwgYmVjYXVzZSBhIHZhbHVlIG1lcmVseSAqb3BlbmluZypcbiAqIHdpdGggYSBmZW5jZSBvciBhbiBpbWFnZSB3YXMgZXhjbHVkZWQgd2hhdGV2ZXIgZm9sbG93ZWQgaXQuIEEgZmVuY2UgbGluZVxuICogY2FycmllcyBhdCBtb3N0IGEgbGFuZ3VhZ2UgdGFnOyBhbiBpbmxpbmUgaW1hZ2UgY2xvc2VzIGl0cyBvd24gYnJhY2tldHM7IGFcbiAqIGNyZWRlbnRpYWwgZG9lcyBuZWl0aGVyLlxuICpcbiAqIEV2ZXJ5IGFsdGVybmF0aXZlIGlzIGFuY2hvcmVkIGF0IGJvdGggZW5kcyB3aXRoIG5vIG5lc3RlZCBxdWFudGlmaWVyLCBzb1xuICogdGhlIHRlc3QgaXMgbGluZWFyIGluIHRoZSB2YWx1ZSBsZW5ndGggKHRoZSBJc3N1ZSAjMzk0MiBsaW5lYXJpdHkgcnVsZSkuXG4gKi9cbmNvbnN0IEZFTkNFX1ZBTFVFID0gL14oPzpgezMsfXx+ezMsfSlbQS1aYS16MC05XysjLV0qJC87XG5cbi8qKiBBIGNvbXBsZXRlIGlubGluZSBpbWFnZSDigJQgYCFbYWx0XShwYXRoKWAg4oCUIGFzIHRoZSB3aG9sZSB2YWx1ZS4gKi9cbmNvbnN0IElNQUdFX1ZBTFVFID0gL14hXFxbW15cXF1bXSpcXF1cXChbXigpXSpcXCkkLztcblxuLyoqIEEgdmFsdWUgaW4gbWF0Y2hpbmcgcXVvdGVzOiBleHBsaWNpdCBhc3NpZ25tZW50IHN5bnRheCwgbm90IHByb3NlLiAqL1xuY29uc3QgUVVPVEVEX1ZBTFVFID0gL14oPzpcIlteXCJdKlwifCdbXiddKicpJC87XG5cbi8qKlxuICogQSBzaW5nbGUgd29yZCB3aXRoIG5vIGRpZ2l0LCBzeW1ib2wgb3IgaW50ZXJuYWwgY2FwaXRhbCDigJQgdGhlIHNoYXBlIG9mIGFuXG4gKiBFbmdsaXNoIHNlbnRlbmNlJ3MgZmlyc3Qgd29yZC5cbiAqXG4gKiBUaGUgbGVuZ3RoIGlzICoqYm91bmRlZCoqLCBhbmQgdGhhdCBib3VuZCBpcyB0aGUgcnVsZSAoSXNzdWUgIzE3MjcpOiBhblxuICogdW5ib3VuZGVkIGBbYS16XSpgIGxldCBhIGxvd2VyLWNhc2UgcGFzc3BocmFzZSBzdWNoIGFzXG4gKiBgY29ycmVjdGhvcnNlYmF0dGVyeXN0YXBsZWAgcGFzcyBhcyBcImEgcGxhaW4gd29yZFwiIGhvd2V2ZXIgbG9uZyBpdCByYW4sXG4gKiB3aGljaCBpcyBhIGNyZWRlbnRpYWwgc2hhcGUsIG5vdCBhIHByb3NlIHNoYXBlLiBGaWZ0ZWVuIGNoYXJhY3RlcnMgY292ZXJzXG4gKiB0aGUgd29yZHMgRW5nbGlzaCBzZW50ZW5jZXMgYWN0dWFsbHkgb3BlbiB3aXRoLlxuICovXG5jb25zdCBQTEFJTl9XT1JEID0gL15bQS1aYS16XVthLXpdezAsMTR9JC87XG5cbi8qKiBFbXBoYXNpcyBtYXJrZXJzIHdyYXBwaW5nIGEgdmFsdWU6IGF0IG1vc3QgYCoqKmAsIHNvIHRoZSBzdHJpcCBpcyBsaW5lYXIuICovXG5jb25zdCBMRUFESU5HX0VNUEhBU0lTID0gL15bKl9dezEsM30vO1xuXG4vKiogVGhlIGNsb3NpbmcgaGFsZiBvZiB7QGxpbmsgTEVBRElOR19FTVBIQVNJU30sIGJvdW5kZWQgZm9yIHRoZSBzYW1lIHJlYXNvbi4gKi9cbmNvbnN0IFRSQUlMSU5HX0VNUEhBU0lTID0gL1sqX117MSwzfSQvO1xuXG4vKipcbiAqIFNob3J0ZXN0IGNyb3NzLWxpbmUgdmFsdWUgc3RpbGwgdHJlYXRlZCBhcyBhIGNyZWRlbnRpYWwuXG4gKlxuICogRWlnaHQgY2hhcmFjdGVycyBpcyBzaG9ydGVyIHRoYW4gYW55dGhpbmcgYSBjcmVkZW50aWFsIGdlbmVyYXRvciBlbWl0cywgYW5kXG4gKiBsb25nIGVub3VnaCB0byBzcGFyZSB3aGF0IHByb3NlIGFjdHVhbGx5IG9wZW5zIGEgbGluZSB3aXRoIOKAlCBgVGhlYCwgYEFgLFxuICogYFdoZW5gLCBgKHNlZWAsIGBJdCdzYCwgYDEuYCwgYW5kIGFuIGlubGluZS1jb2RlIHNwYW4gc3VjaCBhcyBgYCBgaW5saW5lIGBgLFxuICogd2hvc2UgdmFsdWUgc3RvcHMgYXQgdGhlIGZpcnN0IHNwYWNlLiBBIGZsb29yIG9mIHNpeCB3YXMgdHJpZWQgYW5kIHB1dCBiYWNrOlxuICogaXQgbWFza2VkIHRoZSBvcGVuaW5nIG9mIGV2ZXJ5IHNlbnRlbmNlIHRoYXQgYmVnYW4gd2l0aCBhIGNvZGUgc3Bhbiwgd2hpY2hcbiAqIGlzIHRoZSBzYW1lIGNsYXNzIG9mIGRlZmVjdCBhcyB0aGUgZmVuY2UgdGhpcyBpc3N1ZSBpcyBhYm91dC5cbiAqXG4gKiBUaGUgZmxvb3IgYXBwbGllcyBvbmx5IGFjcm9zcyBhIGxpbmUgYnJlYWssIHNvIGFuIGlubGluZSBgUEFTU1dPUkQ9MTIzNDVgIGlzXG4gKiB1bmFmZmVjdGVkLiBBIGNyZWRlbnRpYWwgc2hvcnRlciB0aGFuIGVpZ2h0IGNoYXJhY3RlcnMgc2l0dGluZyBhbG9uZSBvbiB0aGVcbiAqIGxpbmUgKmFmdGVyKiBpdHMgbGFiZWwgaXMgdGhlIGFjY2VwdGVkIGNvc3QsIGFuZCBpdCBpcyB0aGUgY29zdCB0aGUgaXNzdWVcbiAqIGFza2VkIGZvciAoXCJtaW5pbXVtIGxlbmd0aFwiKS4gQSBjcmVkZW50aWFsIHRoYXQgc2hvcnQgc3RpbGwgY2FycnlpbmcgYVxuICogcHJvdmlkZXIgcHJlZml4IGlzIG1hc2tlZCBieSBpdHMgb3duIHNpZ25hdHVyZSBydWxlIHJlZ2FyZGxlc3MuXG4gKi9cbmNvbnN0IE1JTl9DUk9TU19MSU5FX0xFTkdUSCA9IDg7XG5cbi8qKlxuICogQSBiYXJlIG1hcHBpbmcga2V5IOKAlCBgREVQTE9ZX1RPS0VOOmAg4oCUIGNhcHR1cmVkIGFzIHRoZSB2YWx1ZSBvZiBhIHBhcmVudCBrZXlcbiAqIHRoYXQgZW5kZWQgaXRzIGxpbmUgKGBzZWNyZXRzOmApLiBBY3Jvc3MgYSBsaW5lIGJyZWFrIHRoYXQgaXMgWUFNTFxuICogc3RydWN0dXJlLCB0aGUgcGFyZW50J3MgZmlyc3QgY2hpbGQsIG5ldmVyIGEgY3JlZGVudGlhbC4gQm91bmRlZCBhbmRcbiAqIGFuY2hvcmVkLCBzbyBpdCBpcyBjb25zdGFudCB3b3JrIHBlciBjYW5kaWRhdGUgKHRoZSBJc3N1ZSAjMzk0MiBsaW5lYXJpdHlcbiAqIHJ1bGUpLlxuICovXG5jb25zdCBNQVBQSU5HX0tFWV9WQUxVRSA9IC9eW0EtWmEtejAtOV8uLV17MSwxMjh9OiQvO1xuXG4vKiogQ2hhcmFjdGVycyB0aGF0IGVuZCBhIGxpbmUsIHNvIGEgdmFsdWUgZm91bmQgcGFzdCBvbmUgaXMgb24gYSBsYXRlciBsaW5lLiAqL1xuY29uc3QgTElORV9URVJNSU5BVE9SID0gL1tcXG5cXHJcXHUyMDI4XFx1MjAyOV0vO1xuXG4vKipcbiAqIFJlcG9ydCB3aGV0aGVyIGEgbWF0Y2hlZCBgc2VjcmV0LWFzc2lnbm1lbnRgIHZhbHVlIGlzIGNyZWRlbnRpYWwtc2hhcGVkXG4gKiAoSXNzdWUgIzE3MjcpLlxuICpcbiAqIFRoZSBydWxlJ3Mgc2VwYXJhdG9yIOKAlCBgW1wiJ10/XFxzKls9Ol1cXHMqYCDigJQgc3BhbnMgbGluZSBicmVha3MsIHNvIGEgcHJvc2VcbiAqIGxpbmUgZW5kaW5nIGluIGEgY3JlZGVudGlhbC1pc2ggbGFiZWwgYWRvcHRlZCB0aGUgKm5leHQqIG5vbi1ibGFuayBsaW5lIGFzXG4gKiB0aGUgYXNzaWdubWVudCdzIHZhbHVlLiBBIFBSIGJvZHkgd2hvc2UgbGVhZC1pbiByZWFkXG4gKiBg4oCmIG5vdyBwaWNrcyBhIGNyZWRlbnRpYWw6YCBoYWQgdGhlIE1lcm1haWQgZmVuY2Ugb24gdGhlIGZvbGxvd2luZyBsaW5lXG4gKiBwdWJsaXNoZWQgYXMgdGhlIHBsYWNlaG9sZGVyLCBhbmQgdGhlIGRpYWdyYW0gYENPRElORy1TVEFOREFSRFMubWRgIHJlcXVpcmVzXG4gKiBzdG9wcGVkIHJlbmRlcmluZzsgdGhlIHByb3NlIHZhcmlhbnQgbWFza2VkIGEgc2VudGVuY2UncyBmaXJzdCB3b3JkLlxuICpcbiAqIFRoZSBsYWJlbCBzaWRlIG9mIHRoZSBydWxlIGlzIGRlbGliZXJhdGVseSBibHVudCBhbmQgc3RheXMgdGhhdCB3YXkg4oCUIGl0XG4gKiBjYXRjaGVzIHJlYWwgc2VjcmV0cy4gT25seSB0aGUgdmFsdWUgaXMganVkZ2VkLCBhbmQgb25seSB3aGVuIHRoZSBzZXBhcmF0b3JcbiAqIGNyb3NzZWQgYSBsaW5lIGJyZWFrLiAqKkFuIGlubGluZSBhc3NpZ25tZW50IGlzIG1hc2tlZCBleGFjdGx5IGFzIGJlZm9yZSoqOlxuICogYHNlY3JldF9zY2FubmluZzogZW5hYmxlZGAsIGBQQVNTV09SRD0xMjM0NWAgYW5kIGEgdmFsdWUgd3JhcHBlZCBpblxuICogYmFja3RpY2tzLCBvciBvcGVuaW5nIHdpdGggYCNgLCBgPmAgb3IgYHxgIOKAlCBhbGwgbGVnaXRpbWF0ZSBwYXNzd29yZFxuICogY2hhcmFjdGVycyDigJQgYXJlIHVudG91Y2hlZCBieSB0aGlzIHByZWRpY2F0ZS4gVGhhdCBib3VuZGFyeSBpcyBsb2FkLWJlYXJpbmc6XG4gKiBqdWRnaW5nIGlubGluZSB2YWx1ZXMgdG9vIGlzIHdoYXQgbGV0IGEgZmVuY2Utd3JhcHBlZCBzZWNyZXQgdGhyb3VnaC5cbiAqXG4gKiBBY3Jvc3MgYSBsaW5lIGJyZWFrIHRoZSB2YWx1ZSBtdXN0IGVhcm4gdGhlIG1hc2s6IGNvbXBsZXRlIE1hcmtkb3duXG4gKiAoe0BsaW5rIEZFTkNFX1ZBTFVFfSwge0BsaW5rIElNQUdFX1ZBTFVFfSkgYW5kIGEgY2hpbGQgbWFwcGluZyBrZXlcbiAqICh7QGxpbmsgTUFQUElOR19LRVlfVkFMVUV9KSBuZXZlciBkbywgYSBxdW90ZWQgdmFsdWUgYWx3YXlzXG4gKiBkb2VzLCBhbmQgYW55dGhpbmcgZWxzZSBuZWVkcyB7QGxpbmsgTUlOX0NST1NTX0xJTkVfTEVOR1RIfSBjaGFyYWN0ZXJzIGFuZCBhXG4gKiBzaGFwZSB0aGF0IGlzIG5vdCBhIHtAbGluayBQTEFJTl9XT1JEfS5cbiAqXG4gKiBFeHBvcnRlZCBmb3IgZGlyZWN0IGJvdW5kYXJ5IHRlc3RzOyB7QGxpbmsgYXNzaWdubWVudElzTWFza2VkfSBpcyBpdHMgb25seVxuICogY2FsbGVyIGluIHRoaXMgbW9kdWxlLlxuICpcbiAqIEBwYXJhbSB2YWx1ZSAtIFRoZSB2YWx1ZSB0aGUgYHNlY3JldC1hc3NpZ25tZW50YCBydWxlIGNhcHR1cmVkLlxuICogQHBhcmFtIHNhbWVMaW5lIC0gVHJ1ZSB3aGVuIHRoZSBzZXBhcmF0b3IgZGlkIG5vdCBjcm9zcyBhIGxpbmUgYnJlYWsuXG4gKiBAcmV0dXJucyBUcnVlIHdoZW4gdGhlIHZhbHVlIHNob3VsZCBiZSByZXBsYWNlZCB3aXRoIHRoZSBwbGFjZWhvbGRlci5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGlzQ3JlZGVudGlhbFNoYXBlZFZhbHVlKFxuICB2YWx1ZTogc3RyaW5nLFxuICBzYW1lTGluZTogYm9vbGVhbixcbik6IGJvb2xlYW4ge1xuICBpZiAoc2FtZUxpbmUpIHJldHVybiB0cnVlO1xuICBpZiAoRkVOQ0VfVkFMVUUudGVzdCh2YWx1ZSkgfHwgSU1BR0VfVkFMVUUudGVzdCh2YWx1ZSkpIHJldHVybiBmYWxzZTtcbiAgaWYgKE1BUFBJTkdfS0VZX1ZBTFVFLnRlc3QodmFsdWUpKSByZXR1cm4gZmFsc2U7XG4gIGlmIChRVU9URURfVkFMVUUudGVzdCh2YWx1ZSkpIHJldHVybiB0cnVlO1xuICBpZiAodmFsdWUubGVuZ3RoIDwgTUlOX0NST1NTX0xJTkVfTEVOR1RIKSByZXR1cm4gZmFsc2U7XG4gIC8vIEVtcGhhc2lzIG1hcmtlcnMgYmVsb25nIHRvIHRoZSByZW5kZXJpbmcsIG5vdCB0byB0aGUgdmFsdWUgaW5zaWRlIHRoZW0uXG4gIC8vIFRoZSBsZW5ndGggZmxvb3IgYWJvdmUgaXMgbWVhc3VyZWQgb24gdGhlIHdob2xlIHZhbHVlLCBzbyBzdHJpcHBpbmcgdGhlbVxuICAvLyBjYW5ub3QgZHJvcCBhIGxvbmcgdmFsdWUgdW5kZXIgaXQuXG4gIGNvbnN0IHNjYWxhciA9IHZhbHVlLnJlcGxhY2UoTEVBRElOR19FTVBIQVNJUywgXCJcIikucmVwbGFjZShcbiAgICBUUkFJTElOR19FTVBIQVNJUyxcbiAgICBcIlwiLFxuICApO1xuICByZXR1cm4gIVBMQUlOX1dPUkQudGVzdChzY2FsYXIpO1xufVxuXG4vKipcbiAqIEFwcGx5IHtAbGluayBpc0NyZWRlbnRpYWxTaGFwZWRWYWx1ZX0gdG8gb25lIGBzZWNyZXQtYXNzaWdubWVudGAgbWF0Y2guXG4gKlxuICogVGhlIHNpbmdsZSBwbGFjZSB0aGUgc2VwYXJhdG9yJ3Mgc2hhcGUgaXMgdHVybmVkIGludG8gYSBgc2FtZUxpbmVgIHZlcmRpY3QsXG4gKiBzbyB0aGUgcmVwbGFjZW1lbnQgcGFzcyBhbmQge0BsaW5rIG1hdGNoZXNTaWduYXR1cmVSdWxlfSBjYW5ub3QgZHJpZnQgYXBhcnRcbiAqIChJc3N1ZSAjMTcyNykuXG4gKi9cbmZ1bmN0aW9uIGFzc2lnbm1lbnRJc01hc2tlZChzZXA6IHN0cmluZywgdmFsdWU6IHN0cmluZyk6IGJvb2xlYW4ge1xuICByZXR1cm4gaXNDcmVkZW50aWFsU2hhcGVkVmFsdWUodmFsdWUsICFMSU5FX1RFUk1JTkFUT1IudGVzdChzZXApKTtcbn1cblxuLyoqIFNob3J0ZXN0IHdyYXAgd2lkdGggdGhlIFBFTS1ib2R5IGZhbGxiYWNrIHRyZWF0cyBhcyBhIFwibG9uZ1wiIGxpbmUuICovXG5jb25zdCBQRU1fQk9EWV9MSU5FX01JTiA9IDQwO1xuXG4vKipcbiAqIExvbmdlc3Qgd3JhcCB3aWR0aCB0aGUgUEVNLWJvZHkgZmFsbGJhY2sgd2lsbCBzY2FuLiBBIFJlRG9TIGNlaWxpbmcsXG4gKiBub3QgYSBQRU0gY29udmVudGlvbjogcmVhbCB3cmFwcGluZyBzaXRzIGF0IDQ44oCTNzYuXG4gKi9cbmNvbnN0IFBFTV9CT0RZX0xJTkVfTUFYID0gMTI4O1xuXG4vKiogT25lIHBoeXNpY2FsIGxpbmUgaW5zaWRlIGEgY2FuZGlkYXRlIFBFTS1ib2R5IHJ1bi4gKi9cbmludGVyZmFjZSBQZW1Cb2R5TGluZSB7XG4gIHJlYWRvbmx5IHJhdzogc3RyaW5nO1xuICByZWFkb25seSBwYXlsb2FkTGVuOiBudW1iZXI7XG4gIHJlYWRvbmx5IGhhc1BhZGRpbmc6IGJvb2xlYW47XG4gIHJlYWRvbmx5IG5ld2xpbmU6IHN0cmluZztcbiAgcmVhZG9ubHkgaXNCYXNlNjQ6IGJvb2xlYW47XG59XG5cbi8qKlxuICogU3BsaXQgYHRleHRgIGludG8gcGh5c2ljYWwgbGluZXMsIGtlZXBpbmcgZWFjaCBsaW5lJ3MgZW5kaW5nIHNvIGFcbiAqIHJlY29uc3RydWN0ZWQgc3BhbiBpcyBieXRlLWlkZW50aWNhbCB0byB0aGUgaW5wdXQgd2hlbiBub3RoaW5nIGlzXG4gKiByZWRhY3RlZC5cbiAqL1xuZnVuY3Rpb24gc3BsaXRMaW5lc0tlZXBFbmRpbmdzKHRleHQ6IHN0cmluZyk6IHN0cmluZ1tdIHtcbiAgY29uc3QgbGluZXM6IHN0cmluZ1tdID0gW107XG4gIGNvbnN0IHJlID0gL1teXFxyXFxuXSpcXHI/XFxufFteXFxyXFxuXSsvZztcbiAgbGV0IG06IFJlZ0V4cEV4ZWNBcnJheSB8IG51bGw7XG4gIHdoaWxlICgobSA9IHJlLmV4ZWModGV4dCkpICE9PSBudWxsKSB7XG4gICAgbGluZXMucHVzaChtWzBdKTtcbiAgfVxuICByZXR1cm4gbGluZXM7XG59XG5cbi8qKiBDbGFzc2lmeSBhIHBoeXNpY2FsIGxpbmUgYXMgYSAocG9zc2libHkgcGFkZGVkKSBiYXNlNjQgcGF5bG9hZC4gKi9cbmZ1bmN0aW9uIHBhcnNlUGVtQm9keUxpbmUocmF3OiBzdHJpbmcpOiBQZW1Cb2R5TGluZSB7XG4gIGxldCBuZXdsaW5lID0gXCJcIjtcbiAgbGV0IGNvbnRlbnQgPSByYXc7XG4gIGlmIChyYXcuZW5kc1dpdGgoXCJcXHJcXG5cIikpIHtcbiAgICBuZXdsaW5lID0gXCJcXHJcXG5cIjtcbiAgICBjb250ZW50ID0gcmF3LnNsaWNlKDAsIC0yKTtcbiAgfSBlbHNlIGlmIChyYXcuZW5kc1dpdGgoXCJcXG5cIikpIHtcbiAgICBuZXdsaW5lID0gXCJcXG5cIjtcbiAgICBjb250ZW50ID0gcmF3LnNsaWNlKDAsIC0xKTtcbiAgfVxuICBjb25zdCBtID0gL14oW0EtWmEtejAtOSsvXSspKD17MCwyfSkkLy5leGVjKGNvbnRlbnQpO1xuICBpZiAoIW0pIHtcbiAgICByZXR1cm4ge1xuICAgICAgcmF3LFxuICAgICAgcGF5bG9hZExlbjogMCxcbiAgICAgIGhhc1BhZGRpbmc6IGZhbHNlLFxuICAgICAgbmV3bGluZSxcbiAgICAgIGlzQmFzZTY0OiBmYWxzZSxcbiAgICB9O1xuICB9XG4gIGNvbnN0IHBheWxvYWQgPSBtWzFdID8/IFwiXCI7XG4gIGNvbnN0IHBhZGRpbmcgPSBtWzJdID8/IFwiXCI7XG4gIHJldHVybiB7XG4gICAgcmF3LFxuICAgIHBheWxvYWRMZW46IHBheWxvYWQubGVuZ3RoLFxuICAgIGhhc1BhZGRpbmc6IHBhZGRpbmcubGVuZ3RoID4gMCxcbiAgICBuZXdsaW5lLFxuICAgIGlzQmFzZTY0OiBwYXlsb2FkLmxlbmd0aCA+IDAsXG4gIH07XG59XG5cbi8qKlxuICogUmVkYWN0IHVuaWZvcm0gUEVNLXNoYXBlZCBydW5zIGluc2lkZSBhIGNhbmRpZGF0ZSBzcGFuIChJc3N1ZSAjMTk2KS5cbiAqXG4gKiBBIHJ1biBpcyB0d28gb3IgbW9yZSBjb25zZWN1dGl2ZSBiYXNlNjQgbGluZXMgb2YgdGhlIHNhbWUgd2lkdGhcbiAqIGBXYCAoNDDigJMxMjgpIGZvbGxvd2VkIGJ5IGEgZmluYWwgbGluZSBvZiB3aWR0aCAxLi5XIHdpdGggb3B0aW9uYWxcbiAqIGA9YCAvIGA9PWAgcGFkZGluZy4gUmFnZ2VkIChub24tdW5pZm9ybSkgbG9uZyBsaW5lcyBhcmUgbGVmdCBpbnRhY3QsXG4gKiBpbmNsdWRpbmcgYW55IHVuaWZvcm0gc3ViLXJ1biB0aGF0IGRvZXMgbm90IG1lZXQgdGhhdCBzaGFwZS5cbiAqL1xuZnVuY3Rpb24gcmVkYWN0VW5pZm9ybVBlbUJvZHlSdW5zKHRleHQ6IHN0cmluZyk6IHN0cmluZyB7XG4gIGNvbnN0IHBhcnNlZCA9IHNwbGl0TGluZXNLZWVwRW5kaW5ncyh0ZXh0KS5tYXAocGFyc2VQZW1Cb2R5TGluZSk7XG4gIGlmIChwYXJzZWQubGVuZ3RoID09PSAwKSByZXR1cm4gdGV4dDtcblxuICBjb25zdCBvdXQ6IHN0cmluZ1tdID0gW107XG4gIGxldCBpID0gMDtcbiAgd2hpbGUgKGkgPCBwYXJzZWQubGVuZ3RoKSB7XG4gICAgY29uc3Qgc3RhcnQgPSBwYXJzZWRbaV07XG4gICAgaWYgKFxuICAgICAgIXN0YXJ0IHx8XG4gICAgICAhc3RhcnQuaXNCYXNlNjQgfHxcbiAgICAgIHN0YXJ0Lmhhc1BhZGRpbmcgfHxcbiAgICAgIHN0YXJ0LnBheWxvYWRMZW4gPCBQRU1fQk9EWV9MSU5FX01JTiB8fFxuICAgICAgc3RhcnQucGF5bG9hZExlbiA+IFBFTV9CT0RZX0xJTkVfTUFYIHx8XG4gICAgICBzdGFydC5uZXdsaW5lID09PSBcIlwiXG4gICAgKSB7XG4gICAgICBvdXQucHVzaChzdGFydD8ucmF3ID8/IFwiXCIpO1xuICAgICAgaSsrO1xuICAgICAgY29udGludWU7XG4gICAgfVxuXG4gICAgY29uc3Qgd2lkdGggPSBzdGFydC5wYXlsb2FkTGVuO1xuICAgIGxldCBqID0gaSArIDE7XG4gICAgd2hpbGUgKGogPCBwYXJzZWQubGVuZ3RoKSB7XG4gICAgICBjb25zdCBuZXh0ID0gcGFyc2VkW2pdO1xuICAgICAgaWYgKFxuICAgICAgICAhbmV4dCB8fFxuICAgICAgICAhbmV4dC5pc0Jhc2U2NCB8fFxuICAgICAgICBuZXh0Lmhhc1BhZGRpbmcgfHxcbiAgICAgICAgbmV4dC5wYXlsb2FkTGVuICE9PSB3aWR0aCB8fFxuICAgICAgICBuZXh0Lm5ld2xpbmUgPT09IFwiXCJcbiAgICAgICkge1xuICAgICAgICBicmVhaztcbiAgICAgIH1cbiAgICAgIGorKztcbiAgICB9XG4gICAgY29uc3QgZnVsbENvdW50ID0gaiAtIGk7XG4gICAgY29uc3QgbGFzdCA9IHBhcnNlZFtqXTtcbiAgICBjb25zdCBsYXN0SXNQYXJ0aWFsID0gISFsYXN0ICYmIGxhc3QuaXNCYXNlNjQgJiZcbiAgICAgIGxhc3QucGF5bG9hZExlbiA+PSAxICYmXG4gICAgICBsYXN0LnBheWxvYWRMZW4gPD0gd2lkdGggJiZcbiAgICAgIGxhc3QucGF5bG9hZExlbiA8PSBQRU1fQk9EWV9MSU5FX01BWDtcblxuICAgIGlmIChmdWxsQ291bnQgPj0gMiAmJiBsYXN0SXNQYXJ0aWFsICYmIGxhc3QpIHtcbiAgICAgIC8vIFRoZSBwYXR0ZXJuIGRvZXMgbm90IGNvbnN1bWUgYSBuZXdsaW5lIGFmdGVyIHRoZSBmaW5hbCBwYXlsb2FkLFxuICAgICAgLy8gc28ga2VlcCB0aGF0IGVuZGluZyAoaWYgYW55KSB2aXNpYmxlIGFmdGVyIHRoZSBwbGFjZWhvbGRlci5cbiAgICAgIG91dC5wdXNoKFJFREFDVElPTl9QTEFDRUhPTERFUiArIGxhc3QubmV3bGluZSk7XG4gICAgICBpID0gaiArIDE7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgaWYgKGZ1bGxDb3VudCA+PSAzKSB7XG4gICAgICBjb25zdCB0YWlsID0gcGFyc2VkW2ogLSAxXTtcbiAgICAgIG91dC5wdXNoKFJFREFDVElPTl9QTEFDRUhPTERFUiArICh0YWlsPy5uZXdsaW5lID8/IFwiXCIpKTtcbiAgICAgIGkgPSBqO1xuICAgICAgY29udGludWU7XG4gICAgfVxuXG4gICAgb3V0LnB1c2goc3RhcnQucmF3KTtcbiAgICBpKys7XG4gIH1cbiAgcmV0dXJuIG91dC5qb2luKFwiXCIpO1xufVxuXG4vKipcbiAqIE9yZGVyZWQgcmVkYWN0aW9uIHJ1bGVzLiBVUkwtY3JlZGVudGlhbCBydWxlcyBydW4gYmVmb3JlIHRoZSBiYXJlLXRva2VuXG4gKiBydWxlcyBzbyB0aGUgaG9zdC9wYXRoIG9mIGEgdG9rZW5pc2VkIFVSTCBzdGF5cyB2aXNpYmxlIGFmdGVyIHRoZSBlbWJlZGRlZFxuICogdG9rZW4gaXMgbWFza2VkLlxuICovXG5jb25zdCBSVUxFUzogcmVhZG9ubHkgUmVkYWN0aW9uUnVsZVtdID0gW1xuICAvLyBNdWx0aS1saW5lIFBFTSBwcml2YXRlLWtleSBibG9jayAoSXNzdWUgIzMyMDMpLiBIaWdoZXN0LXZhbHVlIHNlY3JldDpcbiAgLy8gdGhlIEdpdEh1YiBBcHAgcHJpdmF0ZSBrZXkgbWludHMgaW5zdGFsbGF0aW9uIHRva2VucyBmb3IgZXZlcnkgcmVwbyB0aGVcbiAgLy8gQXBwIGNhbiByZWFjaC4gTWFza2VkIHdob2xlIChCRUdJTi4uRU5ELCBhbnkga2V5IHR5cGUpIEJFRk9SRSB0aGUgb3RoZXJcbiAgLy8gcnVsZXMgc28gYSBwYXN0ZWQgUEVNIG5ldmVyIHN1cnZpdmVzIHRoZSBjaG9rZXBvaW50IOKAlCBlLmcuIGludG8gYSBwdWJsaWNcbiAgLy8gaXNzdWUgY29tbWVudCB2aWEgdGhlIHF1ZXN0aW9uLWFuc3dlciBwYXRoLlxuICB7XG4gICAgbmFtZTogXCJwZW0tcHJpdmF0ZS1rZXlcIixcbiAgICAvLyBUaGUgRU5EIG1hcmtlciBpcyBvcHRpb25hbCAoSXNzdWUgIzM3MDcpOiBhIHRhaWwgY3V0IG1pZC1rZXksIG9yIGEgbG9nXG4gICAgLy8gbGluZSB0aGF0IG9ubHkgZWNob2VkIHRoZSBoZWFkIG9mIHRoZSBmaWxlLCBsZWZ0IHRoZSBib2R5IHVubWFza2VkXG4gICAgLy8gYmVjYXVzZSB0aGUgcnVsZSBkZW1hbmRlZCBib3RoIG1hcmtlcnMuIFdpdGhvdXQgYW4gRU5EIHRoZSBtYXRjaCBydW5zXG4gICAgLy8gdG8gdGhlIGVuZCBvZiB0aGUgdGV4dC5cbiAgICBwYXR0ZXJuOlxuICAgICAgLy0tLS0tQkVHSU4gW0EtWjAtOSBdKlBSSVZBVEUgS0VZLS0tLS1bXFxzXFxTXSo/KD86LS0tLS1FTkQgW0EtWjAtOSBdKlBSSVZBVEUgS0VZLS0tLS18JCkvZyxcbiAgICByZXBsYWNlOiAoKSA9PiBSRURBQ1RJT05fUExBQ0VIT0xERVIsXG4gIH0sXG4gIC8vIEJhcmUgUEVNIGJvZHkgd2l0aCBubyBtYXJrZXJzIGF0IGFsbCAoSXNzdWUgIzM3MDcgLyAjMTk2KS4gQSBrZXkgY2FuXG4gIC8vIHJlYWNoIGEgbG9nIHNpbmsgc3RyaXBwZWQgb2YgaXRzIGhlYWRlciDigJQgYSB0cnVuY2F0ZWQgdGFpbCwgYSBgZ3JlcGAgb2ZcbiAgLy8gdGhlIGZpbGUsIGEgSlNPTi1lc2NhcGVkIHZhbHVlIHNwbGl0IGFjcm9zcyBsaW5lcy4gVGhlIHNpZ25hbCBpcyB0d28gb3JcbiAgLy8gbW9yZSBjb25zZWN1dGl2ZSAqbG9uZyB1bmlmb3JtKiBiYXNlNjQgbGluZXMgcGx1cyBhIGZpbmFsIChwb3NzaWJseVxuICAvLyBwYWRkZWQpIGxpbmUg4oCUIG5vdCBhIGhhcmQtY29kZWQgd3JhcCB3aWR0aC4gUEVNIGlzIHdyYXBwZWQgYXQgNjQsIDc2XG4gIC8vIChNSU1FKSwgNzIsIDQ4IGFuZCBvdGhlciB3aWR0aHM7IG9yZGluYXJ5IGJhc2U2NCBpbiBsb2dzIGlzIGEgc2luZ2xlXG4gIC8vIHNob3J0IGxpbmUsIHNvIHBhdGNoIGJsb2JzLCBoYXNoZXMsIHJhZ2dlZCBsaW5lcyBhbmQgcHJvc2Ugc3RheSBpbnRhY3QuXG4gIC8vXG4gIC8vIExpbmUgd2lkdGggaXMgYm91bmRlZCAoSXNzdWUgIzM5NDIpOiBhbiB1bmJvdW5kZWQgYHs0MCx9YCBvbiBhIDUwMCBrQlxuICAvLyBzaW5nbGUtbGluZSBibG9iIGJhY2t0cmFja3MgZnJvbSBldmVyeSBzdGFydCBwb3NpdGlvbi4gMTI4IGlzIHdlbGxcbiAgLy8gYWJvdmUgYW55IHdyYXAgaW4gY2lyY3VsYXRpb24uIFVuaWZvcm1pdHkgaXMgYXNzZXJ0ZWQgaW4gdGhlIHJlcGxhY2VcbiAgLy8gY2FsbGJhY2sgc28gdGhlIHBhdHRlcm4gaXRzZWxmIHN0YXlzIGxpbmVhciBhbmQgY2Fubm90IFJlRG9TIG9uIGFcbiAgLy8gYmFja3JlZmVyZW5jZS1zdHlsZSBcInNhbWUgbGVuZ3RoXCIgY29uc3RydWN0aW9uLlxuICB7XG4gICAgbmFtZTogXCJwZW0tYm9keS1ibG9ja1wiLFxuICAgIHBhdHRlcm46IC8oPzpbQS1aYS16MC05Ky9dezQwLDEyOH1cXHI/XFxuKXsyLH1bQS1aYS16MC05Ky9dezEsMTI4fT17MCwyfS9nLFxuICAgIHJlcGxhY2U6IChtYXRjaDogc3RyaW5nKSA9PiByZWRhY3RVbmlmb3JtUGVtQm9keVJ1bnMobWF0Y2gpLFxuICB9LFxuICAvLyBDcmVkZW50aWFscyBlbWJlZGRlZCBpbiBhIFVSTDogc2NoZW1lOi8vdXNlcjpzZWNyZXRAaG9zdC9wYXRoLlxuICAvLyBLZWVwIHNjaGVtZSwgdGhlIHVzZXJuYW1lLCBhbmQgaG9zdC9wYXRoOyBtYXNrIG9ubHkgdGhlIHBhc3N3b3JkL3Rva2VuLlxuICAvL1xuICAvLyBUaGUgc2NoZW1lIHJ1biBpcyBib3VuZGVkIChJc3N1ZSAjMzk0MikuIFVuYm91bmRlZCwgYFthLXowLTkrLi1dKmAgd2FzXG4gIC8vIGdyZWVkeSwgdW5hbmNob3JlZCBhbmQg4oCUIHVuZGVyIGAvaWAg4oCUIGNvdmVyZWQgdGhlIHdob2xlIEFTQ0lJIGFscGhhbnVtZXJpY1xuICAvLyBjbGFzcywgc28gZXZlcnkgc3RhcnQgcG9zaXRpb24gaW4gYSBsb25nIGFscGhhbnVtZXJpYyBydW4gY29uc3VtZWQgdGhlXG4gIC8vIHJlbWFpbmRlciBhbmQgYmFja3RyYWNrZWQgbG9va2luZyBmb3IgYDovL2A6IHF1YWRyYXRpYywgYW5kIGVub3VnaCB0b1xuICAvLyBmcmVlemUgdGhlIHNpbmdsZS10aHJlYWRlZCB3b3JrZXIgb24gfjUwMCBrQiBvZiBtb2RlbCBvdXRwdXQuIE5vIHJlYWxcbiAgLy8gVVJMIHNjaGVtZSBhcHByb2FjaGVzIDY0IGNoYXJhY3RlcnMuXG4gIHtcbiAgICBuYW1lOiBcInVybC11c2VyaW5mb1wiLFxuICAgIHBhdHRlcm46IC8oW2Etel1bYS16MC05Ky4tXXswLDYzfTpcXC9cXC8pKFteL1xcczpAXSspOihbXi9cXHNAXSspQC9naSxcbiAgICByZXBsYWNlOiAoX20sIHNjaGVtZTogc3RyaW5nLCB1c2VyOiBzdHJpbmcpID0+XG4gICAgICBgJHtzY2hlbWV9JHt1c2VyfToke1JFREFDVElPTl9QTEFDRUhPTERFUn1AYCxcbiAgfSxcbiAgLy8gR2l0SHViIGZpbmUtZ3JhaW5lZCBwZXJzb25hbCBhY2Nlc3MgdG9rZW4uXG4gIHtcbiAgICBuYW1lOiBcImdpdGh1Yi1maW5lLWdyYWluZWQtcGF0XCIsXG4gICAgcGF0dGVybjogL2dpdGh1Yl9wYXRfW0EtWmEtejAtOV9dezIwLH0vZyxcbiAgICByZXBsYWNlOiAoKSA9PiBSRURBQ1RJT05fUExBQ0VIT0xERVIsXG4gIH0sXG4gIC8vIEdpdEh1YiBjbGFzc2ljIHRva2VuczogZ2hwXyAvIGdob18gLyBnaHVfIC8gZ2hzXyAvIGdocl8gKyA+PTM2IGJhc2U2Mi5cbiAge1xuICAgIG5hbWU6IFwiZ2l0aHViLXRva2VuXCIsXG4gICAgcGF0dGVybjogL2doW3BvdXNyXV9bQS1aYS16MC05XXszNix9L2csXG4gICAgcmVwbGFjZTogKCkgPT4gUkVEQUNUSU9OX1BMQUNFSE9MREVSLFxuICB9LFxuICAvLyBBbnRocm9waWMgQVBJIGtleS5cbiAge1xuICAgIG5hbWU6IFwiYW50aHJvcGljLWtleVwiLFxuICAgIHBhdHRlcm46IC9zay1hbnQtW0EtWmEtejAtOV8tXXsyMCx9L2csXG4gICAgcmVwbGFjZTogKCkgPT4gUkVEQUNUSU9OX1BMQUNFSE9MREVSLFxuICB9LFxuICAvLyBPcGVuQUkgLyBDb2RleCBBUEkga2V5IChJc3N1ZSAjMzYpLiBgT1BFTkFJX0FQSV9LRVlgIGFuZCBgQ09ERVhfQVBJX0tFWWBcbiAgLy8gYXJlIGxpdmUgc2VjcmV0cyBoYW5kZWQgdG8gdGhlIENvZGV4IGNoaWxkIChzZWUgYGNvZGV4X2Vudi50c2ApLCBidXQgdW50aWxcbiAgLy8gdGhpcyBydWxlIGV4aXN0ZWQgYSBiYXJlIGtleSB3YXMgbWFza2VkIG9ubHkgd2hlbiBpdCBoYXBwZW5lZCB0byBzaXQgaW4gYVxuICAvLyByZWNvZ25pc2VkIHN0cnVjdHVyZSDigJQgYW4gZW52IGFzc2lnbm1lbnQsIGEgYC0tYXBpLWtleWAgZmxhZyBvciBhIEJlYXJlclxuICAvLyBoZWFkZXIuIFRoZSBzaGFwZSB0aGF0IGFjdHVhbGx5IGxlYWtzIGhhcyBubyBzdHJ1Y3R1cmUgYXQgYWxsOiBhIENMSVxuICAvLyBlY2hvaW5nIHRoZSByZWplY3RlZCBrZXkgaW50byBzdGRlcnIsIG9yIGFuIGV4Y2VwdGlvbiBtZXNzYWdlIGNhcnJ5aW5nIGl0XG4gIC8vIGludG8gYSBzdGFjayBmcmFtZS4gQ292ZXJzIHRoZSBjbGFzc2ljIGBzay1gIGZvcm0gYW5kIHRoZSBwcm9qZWN0LXNjb3BlZFxuICAvLyBgc2stcHJvai1gIHZhcmlhbnQgKHBsdXMgYHNrLXN2Y2FjY3QtYCAvIGBzay1hZG1pbi1gLCBzYW1lIGNoYXJzZXQpLlxuICAvL1xuICAvLyBPcmRlcmluZyBtYXR0ZXJzOiB0aGlzIHJ1bGUgcnVucyAqYWZ0ZXIqIGBhbnRocm9waWMta2V5YCwgd2hpY2ggb3ducyB0aGVcbiAgLy8gb3ZlcmxhcHBpbmcgYHNrLWFudC1gIHByZWZpeC4gQnkgdGhlIHRpbWUgdGhpcyBwYXR0ZXJuIHNlZXMgdGhlIHRleHQgYW5cbiAgLy8gQW50aHJvcGljIGtleSBpcyBhbHJlYWR5IHRoZSBwbGFjZWhvbGRlciDigJQgd2hpY2ggY29udGFpbnMgbm8gYHNrLWAg4oCUIHNvXG4gIC8vIGVhY2gga2V5IHlpZWxkcyBleGFjdGx5IG9uZSBzdWJzdGl0dXRpb24gYW5kIHBsYWNlaG9sZGVycyBuZXZlciBuZXN0LlxuICAvL1xuICAvLyBCb3VuZGVkIGF0IGJvdGggZW5kcyAoSXNzdWUgIzM5NDIpLiBUaGUgMjAtY2hhcmFjdGVyIG1pbmltdW0gYW5kIHRoZSBgXFxiYFxuICAvLyBhbmNob3Iga2VlcCBvcmRpbmFyeSBoeXBoZW5hdGVkIHByb3NlIChgdGFzay1zay1ub3Rlc2ApIGZyb20gbWF0Y2hpbmc7IHRoZVxuICAvLyA1MTIgY2VpbGluZyBrZWVwcyB0aGUgcXVhbnRpZmllciBleHBsaWNpdGx5IGJvdW5kZWQgYW5kIGlzIHJvdWdobHkgdGhyZWVcbiAgLy8gdGltZXMgdGhlIGxvbmdlc3QgcmVhbCBgc2stcHJvai1gIGtleSwgc28gbm8gZ2VudWluZSBrZXkgaXMgc3BsaXQuXG4gIHtcbiAgICBuYW1lOiBcIm9wZW5haS1rZXlcIixcbiAgICBwYXR0ZXJuOiAvXFxic2stW0EtWmEtejAtOV8tXXsyMCw1MTJ9L2csXG4gICAgcmVwbGFjZTogKCkgPT4gUkVEQUNUSU9OX1BMQUNFSE9MREVSLFxuICB9LFxuICAvLyBHb29nbGUgLyBHZW1pbmkgQVBJIGtleSAoSXNzdWUgIzM2KS4gYEdFTUlOSV9BUElfS0VZYCAvIGBHT09HTEVfQVBJX0tFWWBcbiAgLy8gcmVhY2ggdGhlIEdlbWluaSBjaGlsZCAoc2VlIGBnZW1pbmlfZW52LnRzYCkgYW5kIGxlYWsgaW4gdGhlIHNhbWUgYmFyZVxuICAvLyBzaGFwZSBhcyB0aGUgT3BlbkFJIGtleSBhYm92ZS4gR29vZ2xlJ3MgZm9ybWF0IGlzIGEgZml4ZWQgMzkgY2hhcmFjdGVycyDigJRcbiAgLy8gdGhlIGBBSXphU3lgIHByZWZpeCBwbHVzIDMzIGNoYXJzZXQgY2hhcmFjdGVycyDigJQgc28gdGhlIHF1YW50aWZpZXIgaXMgYW5cbiAgLy8gZXhhY3QgY291bnQgYW5kIGlzIGJvdW5kZWQgYnkgY29uc3RydWN0aW9uLiBUaGUgZml4ZWQgbGVuZ3RoIGlzIGFsc28gd2hhdFxuICAvLyBrZWVwcyB0aGUgcnVsZSBvZmYgb3JkaW5hcnkgdGV4dDogYSBzaG9ydGVyIGBBSXphU3nigKZgIGZyYWdtZW50IGlzIGxlZnRcbiAgLy8gYWxvbmUuXG4gIHtcbiAgICBuYW1lOiBcImdvb2dsZS1hcGkta2V5XCIsXG4gICAgcGF0dGVybjogL1xcYkFJemFTeVtBLVphLXowLTlfLV17MzN9L2csXG4gICAgcmVwbGFjZTogKCkgPT4gUkVEQUNUSU9OX1BMQUNFSE9MREVSLFxuICB9LFxuICAvLyBBV1Mgc2VjcmV0IGFjY2VzcyBrZXksIGFuY2hvcmVkIHRvIHRoZSBhY2Nlc3Mta2V5IGlkIHRoYXQgcHJlY2VkZXMgaXQuXG4gIC8vXG4gIC8vIFRoZSBpZCBoYXMgYSBmaXhlZCBzaGFwZSBhbmQgaXMgbWF0Y2hlZCBvbiBpdHMgb3duIGJlbG93OyB0aGUgU0VDUkVUIGhhc1xuICAvLyBub25lIOKAlCBpdCBpcyA0MCBjaGFyYWN0ZXJzIG9mIGJhc2U2NCBhbHBoYWJldCwgdGhlIHNhbWUgc2hhcGUgYXMgYW55XG4gIC8vIGhhc2ggb3IgYmxvYiDigJQgc28gbWF0Y2hpbmcgaXQgYmFyZSB3b3VsZCByZWRhY3Qgb3JkaW5hcnkgdGV4dC4gV2hhdCBpc1xuICAvLyByZWxpYWJsZSBpcyB0aGUgcGFpcjogQVdTIGhhbmRzIHRoZSB0d28gb3V0IHRvZ2V0aGVyLCBhbmQgZXZlcnkgbGVha1xuICAvLyBzaGFwZSBjYXJyaWVzIHRoZW0gdG9nZXRoZXIgdG9vLiBUaGUgY3JlZGVudGlhbHMgQ1NWIEFXUyBpdHNlbGYgaXNzdWVzXG4gIC8vIGlzIHRoZSBjYW5vbmljYWwgb25lOlxuICAvL1xuICAvLyAgICAgVXNlciBuYW1lLEFjY2VzcyBrZXkgSUQsU2VjcmV0IGFjY2VzcyBrZXlcbiAgLy8gICAgIHN2YyxBS0lBSU9TRk9ETk43RVhBTVBMRSx3SmFsclhVdG5GRU1JL0s3TURFTkcvYlB4UmZpQ1lFWEFNUExFS0VZXG4gIC8vXG4gIC8vIFRoZSBgQVdTX1NFQ1JFVF9BQ0NFU1NfS0VZPeKApmAgYW5kIGBcImF3c19zZWNyZXRfYWNjZXNzX2tleVwiOiBcIuKAplwiYCBmb3Jtc1xuICAvLyBhcmUgYWxyZWFkeSBjb3ZlcmVkIGJ5IGBzZWNyZXQtYXNzaWdubWVudGAgYmVsb3c7IHRoaXMgcnVsZSBpcyBmb3IgdGhlXG4gIC8vIHNlY3JldCBzdGFuZGluZyBvbiBpdHMgb3duIGJlc2lkZSBpdHMgaWQuXG4gIC8vXG4gIC8vIE1VU1QgcHJlY2VkZSBgYXdzLWFjY2Vzcy1rZXktaWRgOiB0aGF0IHJ1bGUgcmVwbGFjZXMgdGhlIGFuY2hvciB3aXRoIHRoZVxuICAvLyBwbGFjZWhvbGRlciwgYW5kIGFuIGFuY2hvciB0aGF0IGlzIGdvbmUgbWF0Y2hlcyBub3RoaW5nLlxuICAvL1xuICAvLyBUaGUgd2luZG93IGlzIGJvdW5kZWQgKHRoZSBJc3N1ZSAjMzk0MiBsaW5lYXJpdHkgcnVsZSkgYW5kIHRoZSB2YWx1ZSBpc1xuICAvLyBleGNsdWRlZCBmcm9tIGJlaW5nIHB1cmUgbG93ZXJjYXNlIGhleCDigJQgYSBnaXQgY29tbWl0IFNIQSBpcyBleGFjdGx5IDQwXG4gIC8vIGhleCBjaGFyYWN0ZXJzIGFuZCBhcHBlYXJzIGJlc2lkZSByZWRhY3RlZCBtYXRlcmlhbCBjb25zdGFudGx5LlxuICAvL1xuICAvLyBJc3N1ZSAjMzg1NzogaW4gSlNPTi1lbmNvZGVkIG9yIGVzY2FwZWQgdGV4dCB0aGUgc2VjcmV0IGZvbGxvd3MgYSBsaXRlcmFsXG4gIC8vIGBcXG5gLCBgXFxyYCBvciBgXFx0YCwgc28gdGhlIGVzY2FwZSBsZXR0ZXIgYWJ1dHMgaXQgYW5kIGBcXGJgIG5ldmVyIGZpcmVzLlxuICAvLyBPbmx5IHRob3NlIHRocmVlIGVzY2FwZXMgYXJlIGFjY2VwdGVkLCBzbyBhIHdvcmQgZ2x1ZWQgdG8gNDAgY2hhcmFjdGVyc1xuICAvLyBpcyBzdGlsbCBub3QgYSBtYXRjaC5cbiAgLy9cbiAgLy8gSXNzdWUgIzQxMDM6IGBcXGJgIGFsc28gZmFpbHMgYmVzaWRlIGAvYCBhbmQgYCtgLCB3aGljaCBhcmUgc2VjcmV0XG4gIC8vIGNoYXJhY3RlcnMgYnV0IG5vdCB3b3JkIGNoYXJhY3RlcnMsIHNvIGEgc2VjcmV0IHN0YXJ0aW5nIG9yIGVuZGluZyBpbiBvbmVcbiAgLy8gd2FzIGxlZnQgdmVyYmF0aW0uIExvb2thcm91bmRzIG92ZXIgdGhlIHNlY3JldCBhbHBoYWJldCByZXBsYWNlIGBcXGJgLiBUaGVcbiAgLy8gY29udGV4dCBjbGFzcyBvbWl0cyBgPWAgdG8gcHJlc2VydmUgYGlkPXNlY3JldGAgYW5kIGBzZWNyZXQ94oCmYC4gVGhlXG4gIC8vIG9sZCBgXFxiYCBmaXJlZCBiZXNpZGUgYD1gIG9ubHkgbmV4dCB0byBhIHdvcmQgY2hhcmFjdGVyLiBUd28gZ3VhcmRzXG4gIC8vIGtlZXAgc2VwYXJhdG9yIGxpbmVzIGFmdGVyIGFuIGlkIGZyb20gYmVpbmcgbWlzdGFrZW4gZm9yIHNlY3JldHM6IG9uZVxuICAvLyByZWplY3RzIGEgbGVhZGluZyBgPWAsIHRoZSBvdGhlciBhIGNhbmRpZGF0ZSBtYWRlIG9ubHkgb2YgYC9gLCBgK2AgYW5kIGA9YFxuICAvLyAoYSBgKz09PT0rYCBib3JkZXIsIGEgYC8vPT09PWAgYmFubmVyLCBhIHJ1biBvZiA0MCBgL2ApLiBSZWFsIHNlY3JldHNcbiAgLy8gYWx3YXlzIGNvbnRhaW4gYW4gYWxwaGFudW1lcmljLiBFdmVyeSBsb29rYXJvdW5kIGlzIGNvbnN0YW50IHdpZHRoICh0aGVcbiAgLy8gSXNzdWUgIzM5NDIgbGluZWFyaXR5IHJ1bGUpLCBhbmQgdGhlIGVzY2FwZSBhbHRlcm5hdGl2ZSBzdGF5cyBiZWNhdXNlIHRoZVxuICAvLyBlc2NhcGUgbGV0dGVyIGlzIGl0c2VsZiBhbiBhbHBoYWJldCBjaGFyYWN0ZXIuXG4gIC8vXG4gIC8vIGBfYCBpcyBpbiBib3RoIGNvbnRleHQgY2xhc3NlcyBiZWNhdXNlIGBcXGJgIHRyZWF0ZWQgaXQgYXMgYSB3b3JkXG4gIC8vIGNoYXJhY3Rlciwgc28gYSBzZWNyZXQgZ2x1ZWQgdG8gYF9gIHN0YXlzIHVubWFza2VkIGFzIGl0IGRpZCBmb3IgbGV0dGVyc1xuICAvLyBhbmQgZGlnaXRzLiBUaGUgaGV4IGd1YXJkIG5lZWRzIG5vIGlubmVyIGBcXGJgOiBhIGhleCBjYW5kaWRhdGUgd2l0aCBhXG4gIC8vIGNsYXNzIGNoYXJhY3RlciBhZnRlciBpdCBpcyByZWplY3RlZCBieSB0aGUgaGV4IGd1YXJkIG9yIHRoZSB0cmFpbGluZ1xuICAvLyBndWFyZCBhbGlrZSwgc28gYCg/IVswLTlhLWZdezQwfSlgIGFsb25lIGdpdmVzIHRoZSBzYW1lIG91dGNvbWUuXG4gIHtcbiAgICBuYW1lOiBcImF3cy1zZWNyZXQtYWNjZXNzLWtleVwiLFxuICAgIHBhdHRlcm46XG4gICAgICAvKCg/OkFLSUF8QVNJQSlbMC05QS1aXXsxNn1bXFxzXFxTXXswLDEyMH0/KSg/Oig/PCFbQS1aYS16MC05LytfXSl8KD88PVxcXFxbbnJ0XSkpKD8hWzAtOWEtZl17NDB9KSg/IVsvKz1dezQwfSkoPyE9KShbQS1aYS16MC05Lys9XXs0MH0pKD8hW0EtWmEtejAtOS8rX10pL2csXG4gICAgcmVwbGFjZTogKF9tLCBsZWFkOiBzdHJpbmcpID0+IGAke2xlYWR9JHtSRURBQ1RJT05fUExBQ0VIT0xERVJ9YCxcbiAgfSxcbiAgLy8gQVdTIGFjY2VzcyBrZXkgaWQuXG4gIHtcbiAgICBuYW1lOiBcImF3cy1hY2Nlc3Mta2V5LWlkXCIsXG4gICAgcGF0dGVybjogL1xcYig/OkFLSUF8QVNJQSlbMC05QS1aXXsxNn1cXGIvZyxcbiAgICByZXBsYWNlOiAoKSA9PiBSRURBQ1RJT05fUExBQ0VIT0xERVIsXG4gIH0sXG4gIC8vIEJlYXJlciB0b2tlbiBpbiBhbiBBdXRob3JpemF0aW9uIGhlYWRlciBvciBzaW1pbGFyLiBLZWVwIHRoZSBzY2hlbWUuXG4gIHtcbiAgICBuYW1lOiBcImJlYXJlci10b2tlblwiLFxuICAgIHBhdHRlcm46IC9cXGIoQmVhcmVyKVxccytbQS1aYS16MC05Ll9+Ky89LV17OCx9L2dpLFxuICAgIHJlcGxhY2U6IChfbSwgc2NoZW1lOiBzdHJpbmcpID0+IGAke3NjaGVtZX0gJHtSRURBQ1RJT05fUExBQ0VIT0xERVJ9YCxcbiAgfSxcbiAgLy8gQmFzaWMgYXV0aCBjcmVkZW50aWFsIGluIGFuIEF1dGhvcml6YXRpb24gaGVhZGVyIChJc3N1ZSAjMzQyNykuIFRoZSB2YWx1ZVxuICAvLyBpcyBhIGJhc2U2NCBibG9iIG9mIGB1c2VyOnRva2VuYCwgc28gaXQgaXMgbWF0Y2hlZCBieSBubyBvdGhlciBydWxlLiBLZWVwXG4gIC8vIHRoZSBzY2hlbWU7IG1hc2sgdGhlIGVuY29kZWQgY3JlZGVudGlhbC4gVGhlIGB7MTYsfWAgYmFzZTY0IG1pbmltdW0gYW5kXG4gIC8vIHRoZSBgKy89YCBjaGFyYWN0ZXIgY2xhc3Mga2VlcCBpdCBmcm9tIG1hdGNoaW5nIGEgcGxhaW4gd29yZCBzdWNoIGFzIHRoZVxuICAvLyBwcm9zZSBcIkJhc2ljIGF1dGhlbnRpY2F0aW9uXCIuXG4gIHtcbiAgICBuYW1lOiBcImJhc2ljLWF1dGhcIixcbiAgICBwYXR0ZXJuOiAvXFxiKEJhc2ljKVxccytbQS1aYS16MC05Ky9dezE2LH09ezAsMn0vZyxcbiAgICByZXBsYWNlOiAoX20sIHNjaGVtZTogc3RyaW5nKSA9PiBgJHtzY2hlbWV9ICR7UkVEQUNUSU9OX1BMQUNFSE9MREVSfWAsXG4gIH0sXG4gIC8vIEVudmlyb25tZW50LXN0eWxlIGFzc2lnbm1lbnQgb2YgYSBjbGVhcmx5LXNlY3JldCBrZXkuIEtlZXAgdGhlIGtleSBuYW1lXG4gIC8vIGFuZCB0aGUgc2VwYXJhdG9yOyBtYXNrIHRoZSB2YWx1ZS4gVGhlIGtleSBtdXN0IGNvbnRhaW4gYSBzZWNyZXQtaXNoXG4gIC8vIHdvcmQgc28gb3JkaW5hcnkgYGtleT12YWx1ZWAgcGFpcnMgKGUuZy4gcmVwbz1vcmcvcmVwbykgYXJlIGxlZnQgYWxvbmUuXG4gIC8vXG4gIC8vIFRoZSBzZXBhcmF0b3IgZ3JvdXAgdG9sZXJhdGVzIGEgY2xvc2luZyBxdW90ZSBhbmQgc3Vycm91bmRpbmcgd2hpdGVzcGFjZVxuICAvLyAoSXNzdWUgIzM3MDcpIHNvIHRoZSBKU09OIGZvcm0gYFwidG9rZW5cIjogXCJhYmNcImAg4oCUIHRoZSBzaGFwZSBvZiBgZ2ggYXBpYFxuICAvLyBvdXRwdXQgYW5kIG9mIGAuY3JlZGVudGlhbHMuanNvbmAg4oCUIG1hdGNoZXMgYXMgd2VsbCBhcyBgVE9LRU49YWJjYC5cbiAgLy9cbiAgLy8gVGhlIHZhbHVlIG11c3QgYWxzbyBjb250YWluIGFuIGFscGhhbnVtZXJpYyBjaGFyYWN0ZXIgKElzc3VlICM0MDA0KS4gRXZlcnlcbiAgLy8gcmVhbCBjcmVkZW50aWFsIGRvZXM7IGEgcnVuIG9mIHB1cmUgcHVuY3R1YXRpb24gZG9lcyBub3QuIFdpdGhvdXQgdGhhdFxuICAvLyByZXF1aXJlbWVudCB0aGUgbWFya2Rvd24gbGFiZWwgYC0gKipUb2tlbnM6KiogaW5wdXQgMjcg4oCmYCBpbiB0aGUgcnVuLXN0YXRzXG4gIC8vIGNvbW1lbnQgcmVhZCBhcyBrZXkgYFRva2Vuc2AsIHNlcGFyYXRvciBgOmAgYW5kIHZhbHVlIGAqKmAg4oCUIHRoZSBib2xkXG4gIC8vIGNsb3NlciDigJQgc28gdGhlIHBsYWNlaG9sZGVyIHdhcyBzdWJzdGl0dXRlZCBvdmVyIHRoZSBlbXBoYXNpcyBtYXJrZXJzIGFuZFxuICAvLyBicm9rZSB0aGUgcmVuZGVyaW5nIG9mIGV2ZXJ5IHN0YXRzIGNvbW1lbnQuIFRoZSBsb29rYWhlYWQgcnVuIGlzIGJvdW5kZWRcbiAgLy8gKHRoZSBJc3N1ZSAjMzk0MiBsaW5lYXJpdHkgcnVsZSk6IGEgY3JlZGVudGlhbCBhbHdheXMgY2FycmllcyBhblxuICAvLyBhbHBoYW51bWVyaWMgd2VsbCBpbnNpZGUgaXRzIGZpcnN0IDY0IGNoYXJhY3RlcnMsIHNvIHRoZSBib3VuZGVkIHNjYW4gY29zdHNcbiAgLy8gY29uc3RhbnQgdGltZSBwZXIgY2FuZGlkYXRlIG1hdGNoLlxuICAvL1xuICAvLyBBIHZhbHVlIHRoYXQgb3BlbnMgYSBKU09OIG9iamVjdCBvciBhcnJheSBpcyBzdHJ1Y3R1cmUsIG5vdCBhIGNyZWRlbnRpYWxcbiAgLy8gKElzc3VlICMxMjU0KS4gYHtcInNlY3JldF9zY2FubmluZ1wiOntcInN0YXR1c1wiOlwiZW5hYmxlZFwifX1gIOKAlCB0aGUgYm9keSB0aGVcbiAgLy8gcmVwby1oYXJkZW5pbmcgcGF0aCBQVVRzIHRvIGVuYWJsZSBzZWNyZXQgc2Nhbm5pbmcg4oCUIG1hdGNoZWQgdGhlIGBcXFMrYFxuICAvLyBicmFuY2gsIHdoaWNoIHN3YWxsb3dlZCB0aGUgYnJhY2UgYW5kIGV2ZXJ5dGhpbmcgYWZ0ZXIgaXQgYW5kIGxlZnRcbiAgLy8gdHJ1bmNhdGVkLCBpbnZhbGlkIEpTT04uIEV4Y2x1ZGluZyBge2AgYW5kIGBbYCBjb3N0cyBubyBjb3ZlcmFnZTogYVxuICAvLyBjcmVkZW50aWFsIG5ldmVyIHN0YXJ0cyB3aXRoIGVpdGhlciwgYW5kIGEgc2VjcmV0IG5lc3RlZCBpbnNpZGUgdGhlIG9iamVjdFxuICAvLyBpcyBzdGlsbCBtYXNrZWQgYnkgdGhpcyBydWxlJ3Mgb3duIHBhc3Mgb3ZlciB0aGUgaW5uZXIgYFwia2V5XCI6IFwidmFsdWVcImAuXG4gIC8vXG4gIC8vIFRoZSBzZXBhcmF0b3IncyBgXFxzKmAgcnVucyBzcGFucyBsaW5lIGJyZWFrcywgc28gYSBwcm9zZSBsaW5lIGVuZGluZyBpbiBhXG4gIC8vIGNyZWRlbnRpYWwgbGFiZWwgYWRvcHRlZCB0aGUgKm5leHQqIGxpbmUgYXMgaXRzIHZhbHVlIChJc3N1ZSAjMTcyNykg4oCUIGFcbiAgLy8gTWVybWFpZCBmZW5jZSB3YXMgcHVibGlzaGVkIGFzIHRoZSBwbGFjZWhvbGRlciBhbmQgdGhlIGRpYWdyYW0gc3RvcHBlZFxuICAvLyByZW5kZXJpbmcuIGBpc0NyZWRlbnRpYWxTaGFwZWRWYWx1ZWAganVkZ2VzIHRoZSB2YWx1ZSBiZWZvcmUgdGhlXG4gIC8vIHN1YnN0aXR1dGlvbjogTWFya2Rvd24gc3RydWN0dXJlIGlzIG5ldmVyIGEgY3JlZGVudGlhbCwgYW5kIGEgdmFsdWUgdGhlXG4gIC8vIHNlcGFyYXRvciByZWFjaGVkIGFjcm9zcyBhIGxpbmUgYnJlYWsgbXVzdCBsb29rIGxpa2Ugb25lLiBBbiBpbmxpbmVcbiAgLy8gYXNzaWdubWVudCBpcyB1bmFmZmVjdGVkLCBzbyB0aGUgbGFiZWwgc2lkZSBzdGF5cyBhcyBibHVudCBhcyBpdCB3YXMuXG4gIC8vXG4gIC8vIEEgYmFyZSBzd2l0Y2ggaXMgY29uZmlndXJhdGlvbiwgbm90IGEgY3JlZGVudGlhbC4gVGhlXG4gIC8vIGBnaXRodWItYWN0aW9ucy1hdWRpdGAgaWRsZSB0YXNrIGZpbGVkIGZvdXJ0ZWVuIGlzc3VlcyB3aG9zZSB3aG9sZVxuICAvLyBpbnN0cnVjdGlvbiB3YXMgXCJhZGQgYHBlcnNpc3QtY3JlZGVudGlhbHM6IGZhbHNlYFwiOiB0aGUga2V5IGNvbnRhaW5zXG4gIC8vIENSRURFTlRJQUwsIHNvIHRoZSBzZXR0aW5nIHdhcyBwdWJsaXNoZWQgYXMgdGhlIHBsYWNlaG9sZGVyLCBhbmQgdGhlXG4gIC8vIGJhcmUtdmFsdWUgYnJhbmNoIHRvb2sgdGhlIGNsb3NpbmcgYmFja3RpY2sgYW5kIHRoZSBmdWxsIHN0b3Agd2l0aCBpdC5cbiAgLy8gYHRydWVgLCBgZmFsc2VgLCBgbnVsbGAsIGBub25lYCwgYHllc2AsIGBub2AsIGBvbmAgYW5kIGBvZmZgIHN0YW5kaW5nXG4gIC8vIGFsb25lIGFzIHRoZSB2YWx1ZSBhcmUgbGVmdCBhbG9uZSwgYW5kIHNvIGFyZSBgcmVhZGAgYW5kIGB3cml0ZWA6IHRoZVxuICAvLyBHaXRIdWIgQWN0aW9ucyBwZXJtaXNzaW9uIGxldmVscywgd2hpY2ggZXZlcnkgYGJlc3QtcHJhY3RpY2VzYCB3cmFwcGVyXG4gIC8vIHB1Ymxpc2hlZCBhcyBcImBpZC10b2tlbjogKioqUkVEQUNURUQqKipgXCIgb24gMjAyNi0wOS0yNCBiZWNhdXNlIHRoZSBrZXlcbiAgLy8gY29udGFpbnMgVE9LRU4gKGBub25lYCwgdGhlIHRoaXJkIGxldmVsLCB3YXMgYWxyZWFkeSBhIHN3aXRjaCB3b3JkKS5cbiAgLy8gYGluaGVyaXRgIChgc2VjcmV0czogaW5oZXJpdGApIGlzIHdvcmtmbG93IHN5bnRheCBvZiB0aGUgc2FtZSBraW5kLCBhbmQgYVxuICAvLyB2YWx1ZSBvcGVuaW5nIGEgYCR7eyDigKYgfX1gIGV4cHJlc3Npb24gbmFtZXMgYSBzZWNyZXQgcmF0aGVyIHRoYW4gaG9sZGluZ1xuICAvLyBpdDsgdGhlIGBnaXRodWItYWN0aW9ucy1hdWRpdGAgcHJvbXB0IGNhcnJpZXMgYm90aC4gVGhlXG4gIC8vIGlubmVyIGxvb2thaGVhZCByZXF1aXJlcyB0aGUgd29yZFxuICAvLyB0byBlbmQgdGhlcmUsIHNvIGBQQVNTV09SRD1mYWxzZS1GbGFnLTlmOGVgIGFuZCBgQVBJX0tFWT1ubzFTZWNyZXRgIGFyZVxuICAvLyBzdGlsbCBtYXNrZWQuIEJvdGggbG9va2FoZWFkcyBhcmUgZml4ZWQtd2lkdGggYWx0ZXJuYXRpb25zIOKAlCBjb25zdGFudFxuICAvLyB3b3JrIHBlciBjYW5kaWRhdGUgKHRoZSBJc3N1ZSAjMzk0MiBsaW5lYXJpdHkgcnVsZSkuXG4gIC8vXG4gIC8vIEpTT04gc3RydWN0dXJlIHN1cnZpdmVzIHRoZSBtYXNrIChJc3N1ZSAjNDE2OSdzIHRyYW5zY3JpcHQgdGVlIGlzIHRoZVxuICAvLyBzaW5rIHRoYXQgc2hvd2VkIGl0KS4gRXZlcnkgc3RyZWFtLWpzb24gbGluZSB0aGUgYWdlbnQgZW1pdHMgY2FycmllcyBhXG4gIC8vIGBcInVzYWdlXCI6e1wiaW5wdXRfdG9rZW5zXCI6NTAsLi4ufWAgYmxvY2sg4oCUIGEga2V5IHRoYXQgbWVyZWx5ICpjb250YWlucypcbiAgLy8gVE9LRU4gZm9sbG93ZWQgYnkgYSBudW1iZXIg4oCUIGFuZCB0aGUgYGluaXRgIGxpbmUgY2Fycmllc1xuICAvLyBgXCJhcGlLZXlTb3VyY2VcIjpcIm5vbmVcImAuIFRoZSBiYXJlLXZhbHVlIGJyYW5jaCB3YXMgYFxcUytgLCBhbmQgY29tcGFjdCBKU09OXG4gIC8vIGhhcyBubyB3aGl0ZXNwYWNlLCBzbyB0aGUgbnVtYmVyICphbmQgZXZlcnl0aGluZyBhZnRlciBpdCB0byB0aGUgZW5kIG9mXG4gIC8vIHRoZSBsaW5lKiBiZWNhbWUgdGhlIHBsYWNlaG9sZGVyOyB0aGUgcXVvdGVkIGJyYW5jaCBkcm9wcGVkIHRoZSBxdW90ZXMgaXRcbiAgLy8gbWF0Y2hlZCwgbGVhdmluZyBhIGJhcmUgd29yZCB3aGVyZSBKU09OIG5lZWRzIGEgc3RyaW5nLiBCb3RoIGxlZnQgdGhlXG4gIC8vIGFyY2hpdmVkIHRyYW5zY3JpcHQgdW5wYXJzYWJsZSBwYXN0IGl0cyBmaXJzdCBhc3Npc3RhbnQgbWVzc2FnZSwgYW5kIHRoZVxuICAvLyBwZXItbWVzc2FnZSB1c2FnZSBmaWd1cmVzIHdlcmUgZ29uZS4gVGhyZWUgYm91bmRlZCByZWZpbmVtZW50czpcbiAgLy8gICAtIGEgSlNPTiBzY2FsYXIg4oCUIGEgbnVtYmVyLCBgdHJ1ZWAsIGBmYWxzZWAgb3IgYG51bGxgIOKAlCBmb2xsb3dlZCBieSB0aGVcbiAgLy8gICAgIGAsYCwgYH1gIG9yIGBdYCB0aGF0IGVuZHMgYSBKU09OIG1lbWJlciBpcyBzdHJ1Y3R1cmUsIG5vdCBhIGNyZWRlbnRpYWxcbiAgLy8gICAgIChhIGNvdW50IHVuZGVyIGEgYCpfdG9rZW5zYCBrZXkgaXMgdGhlIGV2ZXJ5ZGF5IGNhc2UpLiBUaGUgc2NhbGFyJ3NcbiAgLy8gICAgIHJ1bnMgYXJlIGJvdW5kZWQgYW5kIHRoZSB0cmFpbGluZyB3aGl0ZXNwYWNlIHJ1biBpcyBib3VuZGVkLCBzbyB0aGVcbiAgLy8gICAgIGxvb2thaGVhZCBpcyBjb25zdGFudCB3b3JrIHBlciBjYW5kaWRhdGUgKElzc3VlICMzOTQyKS4gQW4gaW5saW5lXG4gIC8vICAgICBgUEFTU1dPUkQ9MTIzNDVgIHdpdGggbm90aGluZyBhZnRlciBpdCBpcyBzdGlsbCBtYXNrZWQgYXMgYmVmb3JlLlxuICAvLyAgIC0gdGhlIGJhcmUtdmFsdWUgYnJhbmNoIHN0b3BzIGF0IGEgZG91YmxlIHF1b3RlLCBzbyBhIHJlYWwgYXNzaWdubWVudFxuICAvLyAgICAgaW5zaWRlIGEgSlNPTiBzdHJpbmcg4oCUIGBcInRleHRcIjpcImV4cG9ydCBUT0tFTj1hYmNcIn1gIOKAlCBpcyBtYXNrZWRcbiAgLy8gICAgIHdpdGhvdXQgZWF0aW5nIHRoZSBzdHJpbmcncyBjbG9zaW5nIHF1b3RlIGFuZCB0aGUgbWVtYmVycyBhZnRlciBpdC5cbiAgLy8gICAtIGEgdmFsdWUgbWF0Y2hlZCAqd2l0aCogaXRzIHF1b3RlcyBrZWVwcyB0aGVtIGFyb3VuZCB0aGUgcGxhY2Vob2xkZXIsXG4gIC8vICAgICBzbyBgXCJwYXNzd29yZFwiOlwiaHVudGVyMlwiYCBiZWNvbWVzIGBcInBhc3N3b3JkXCI6XCIqKipSRURBQ1RFRCoqKlwiYCBhbmRcbiAgLy8gICAgIHN0aWxsIHBhcnNlcy4gVGhlIGFscmVhZHktcmVkYWN0ZWQgbG9va2FoZWFkIHRvbGVyYXRlcyB0aGF0IG9wZW5pbmdcbiAgLy8gICAgIHF1b3RlLCBzbyB0aGUgcGFzcyBzdGF5cyBpZGVtcG90ZW50IGFuZCBgY29udGFpbnNTZWNyZXRgIHN0YXlzIGZhbHNlXG4gIC8vICAgICBvbiBpdHMgb3duIG91dHB1dC5cbiAge1xuICAgIG5hbWU6IFwic2VjcmV0LWFzc2lnbm1lbnRcIixcbiAgICBwYXR0ZXJuOiBTRUNSRVRfQVNTSUdOTUVOVF9QQVRURVJOLFxuICAgIHJlcGxhY2U6IChtYXRjaDogc3RyaW5nLCBrZXk6IHN0cmluZywgc2VwOiBzdHJpbmcsIHZhbHVlOiBzdHJpbmcpID0+IHtcbiAgICAgIGlmICghYXNzaWdubWVudElzTWFza2VkKHNlcCwgdmFsdWUpKSByZXR1cm4gbWF0Y2g7XG4gICAgICBjb25zdCBxdW90ZSA9IFFVT1RFRF9WQUxVRS50ZXN0KHZhbHVlKSA/IHZhbHVlLmNoYXJBdCgwKSA6IFwiXCI7XG4gICAgICByZXR1cm4gYCR7a2V5fSR7c2VwfSR7cXVvdGV9JHtSRURBQ1RJT05fUExBQ0VIT0xERVJ9JHtxdW90ZX1gO1xuICAgIH0sXG4gIH0sXG4gIC8vIFNwYWNlLXNlcGFyYXRlZCBDTEkgZmxhZyBjYXJyeWluZyBhIHNlY3JldCAoSXNzdWUgIzM2NDgpLiBUaGVcbiAgLy8gYHNlY3JldC1hc3NpZ25tZW50YCBydWxlIGFib3ZlIHJlcXVpcmVzIGFuIGA9YCBvciBgOmAgc2VwYXJhdG9yLCBzbyBhXG4gIC8vIGZsYWctc3R5bGUgc2VjcmV0IHN1Y2ggYXMgYC0taW1nYmItYXBpLWtleSAwMTIzYWJjZOKApmAgKGlzc3VlX3dvcmtlci5zaFxuICAvLyBwYXNzZXMgZXhhY3RseSB0aGF0IHNoYXBlIHRvIGBwci1tYW5hZ2VyYCkgd2FzIG1hdGNoZWQgYnkgbm8gcnVsZSBhdCBhbGw6XG4gIC8vIHRoZSB2YWx1ZSBpcyBhIGJhcmUgaGV4IGJsb2Igd2l0aCBubyBwcm92aWRlciBwcmVmaXguIEtlZXAgdGhlIGZsYWcgbmFtZTtcbiAgLy8gbWFzayB0aGUgZm9sbG93aW5nIHRva2VuLiBUaGUgdmFsdWUgbXVzdCBub3QgaXRzZWxmIHN0YXJ0IHdpdGggYC1gIHNvIGFuXG4gIC8vIGFkamFjZW50IGZsYWcgKGAtLXRva2VuIC0tdmVyYm9zZWApIGlzIG5ldmVyIG1pc3Rha2VuIGZvciBhIHNlY3JldC5cbiAgLy9cbiAgLy8gQm90aCBmbGFnLW5hbWUgcnVucyBhcmUgYm91bmRlZCAoSXNzdWUgIzM5NDIpOiB1bmJvdW5kZWQgYFtBLVphLXowLTktXSpgXG4gIC8vIGNvbnN1bWVkIHRoZSByZXN0IG9mIHRoZSB0ZXh0IGZyb20gZXZlcnkgYC0tYCBwb3NpdGlvbiBhbmQgYmFja3RyYWNrZWRcbiAgLy8gbG9va2luZyBmb3IgdGhlIGtleXdvcmQsIHdoaWNoIGlzIHF1YWRyYXRpYyBvbiBhIGxvbmcgcnVuIG9mIGh5cGhlbnMuIE5vXG4gIC8vIENMSSBmbGFnIG5hbWUgYXBwcm9hY2hlcyA2NCBjaGFyYWN0ZXJzIGVpdGhlciBzaWRlIG9mIHRoZSBrZXl3b3JkLlxuICB7XG4gICAgbmFtZTogXCJzZWNyZXQtY2xpLWZsYWdcIixcbiAgICBwYXR0ZXJuOlxuICAgICAgLygtLVtBLVphLXowLTktXXswLDYzfSg/OnRva2VufHNlY3JldHxwYXNzd29yZHxwYXNzd2R8YXBpW18tXT9rZXl8YXBpa2V5fGFjY2Vzc1tfLV0/a2V5fHByaXZhdGVbXy1dP2tleXxjcmVkZW50aWFsKVtBLVphLXowLTktXXswLDYzfSkoXFxzKykoPyEtKSg/IVxcKlxcKlxcKlJFREFDVEVEKShcIlteXCJdK1wifCdbXiddKyd8XFxTKykvZ2ksXG4gICAgcmVwbGFjZTogKF9tLCBmbGFnOiBzdHJpbmcsIHNlcDogc3RyaW5nKSA9PlxuICAgICAgYCR7ZmxhZ30ke3NlcH0ke1JFREFDVElPTl9QTEFDRUhPTERFUn1gLFxuICB9LFxuICAvLyBCYXJlIDMyLWhleCBjcmVkZW50aWFsIOKAlCB0aGUgSW1nQkIgQVBJIGtleSBzaGFwZSAoSXNzdWUgIzEzODcpLiBUaGUgdHdvXG4gIC8vIHJ1bGVzIGFib3ZlIGNhdGNoIHRoYXQga2V5IG9ubHkgd2hpbGUgaXQga2VlcHMgaXRzIHdyYXBwZXI6IGFuXG4gIC8vIGAtLWltZ2JiLWFwaS1rZXkgPGtleT5gIGZsYWcgb3IgYSBgVklCRV9JTUdCQl9BUElfS0VZPTxrZXk+YCBhc3NpZ25tZW50LlxuICAvLyBTdHJpcHBlZCBvZiBib3RoIOKAlCBhbiB1cGxvYWQgY2xpZW50IGVjaG9pbmcgdGhlIHJlamVjdGVkIGtleSBpbnRvIGFuXG4gIC8vIGVycm9yIHN0cmluZywgb3IgdGhlIGtleSBzaXR0aW5nIGluIGFuIGA/a2V5PWAgcXVlcnkgcGFyYW1ldGVyIOKAlCBpdCBpcyBhXG4gIC8vIGJhcmUgaGV4IGJsb2Igd2l0aCBubyBwcm92aWRlciBwcmVmaXgsIGFuZCBubyBydWxlIG1hdGNoZWQgaXQgYXQgYWxsLlxuICAvLyBgZXhwb3J0X3NjcnViX2dhdGUudHNgIGhhcyB0cmVhdGVkIHRoaXMgZXhhY3Qgc2hhcGUgYXMgYSBjcmVkZW50aWFsIHNpbmNlXG4gIC8vIGl0IHdhcyB3cml0dGVuOyB0aGlzIGNsb3NlcyB0aGUgc2FtZSBnYXAgb24gdGhlIHJlZGFjdGlvbiBjaG9rZXBvaW50LlxuICAvL1xuICAvLyBTY29wZWQgYnkgbGVuZ3RoIGFuZCBuZWlnaGJvdXJzIHNvIG9yZGluYXJ5IHRleHQgc3Vydml2ZXM6IGV4YWN0bHkgMzJcbiAgLy8gaGV4IGNoYXJhY3RlcnMgd2l0aCBubyBhbHBoYW51bWVyaWMgZWl0aGVyIHNpZGUuIEEgNDAtaGV4IGdpdCBTSEEsIGFcbiAgLy8gNjQtaGV4IHNoYTI1NiBkaWdlc3QgYW5kIGEgZGFzaGVkIFVVSUQgYWxsIGZhaWwgdGhhdCB0ZXN0LCBhbmQgdGhlIHdvcmtlclxuICAvLyBsb2dzIHRob3NlIGNvbnN0YW50bHkuIFRoZSBmaXhlZCBgezMyfWAgY291bnQgaXMgbGluZWFyIGJ5IGNvbnN0cnVjdGlvblxuICAvLyAoSXNzdWUgIzM5NDIpIOKAlCB0aGVyZSBpcyBubyBxdWFudGlmaWVyIHRvIGJhY2t0cmFjayBvdmVyLlxuICAvL1xuICAvLyBDYXNlLWluc2Vuc2l0aXZlIChJc3N1ZSAjMTYwNSk6IHRoZSBydWxlIGV4aXN0cyBmb3IgYSBjcmVkZW50aWFsIHRoYXRcbiAgLy8gaGFzIGxvc3QgZXZlcnkgc3RydWN0dXJhbCBjbHVlLCBhbmQgYSBjbGllbnQgdGhhdCBub3JtYWxpc2VzIGhleCB0b1xuICAvLyB1cHBlcmNhc2UgYmVmb3JlIGludGVycG9sYXRpbmcgaXQgaW50byBhIFVSTCBvciBhbiBlcnJvciBzdHJpbmcgc3RyaXBzXG4gIC8vIHRoZSBjYXNlIGNsdWUgYWxvbmcgd2l0aCB0aGUgd3JhcHBlci4gVGhlIGxvd2VyY2FzZS1vbmx5IHNoYXBlIGxldCBhblxuICAvLyB1cHBlcmNhc2UgcmVuZGVyaW5nIG9mIHRoZSBzYW1lIGtleSB0aHJvdWdoIGV2ZXJ5IHJ1bGUgaW4gdGhpcyBmaWxlLlxuICAvL1xuICAvLyBSdW5zIGxhc3QsIHNvIGEga2V5IGluc2lkZSBhIHJlY29nbmlzZWQgc3RydWN0dXJlIGlzIG1hc2tlZCBieSB0aGVcbiAgLy8gc3RydWN0dXJhbCBydWxlIHRoYXQgb3ducyBpdCBhbmQgdGhpcyBvbmUgb25seSBzZWVzIHdoYXQgaXMgbGVmdC5cbiAge1xuICAgIG5hbWU6IFwiaGV4MzItY3JlZGVudGlhbFwiLFxuICAgIHBhdHRlcm46IC8oPzwhWzAtOUEtWmEtel0pWzAtOWEtZl17MzJ9KD8hWzAtOUEtWmEtel0pL2dpLFxuICAgIHJlcGxhY2U6ICgpID0+IFJFREFDVElPTl9QTEFDRUhPTERFUixcbiAgfSxcbl07XG5cbi8qKlxuICogUmVwb3J0IHdoZXRoZXIgYHRleHRgIG1hdGNoZXMgYW55IHNpZ25hdHVyZSBydWxlLCB3aXRob3V0IHJld3JpdGluZyBpdC5cbiAqIFRoaXMgaXMgdGhlIHNjYW4gdGhlIGRlY29kZS10aGVuLXJlc2NhbiBwYXNzIGFwcGxpZXMgdG8gZWFjaCBkZWNvZGVkXG4gKiBjYW5kaWRhdGUgKElzc3VlICMxODgpLlxuICpcbiAqIERldGVjdGlvbiBnb2VzIHRocm91Z2ggYFN0cmluZy5wcm90b3R5cGUuc2VhcmNoYCByYXRoZXIgdGhhblxuICogYFJlZ0V4cC5wcm90b3R5cGUudGVzdGA6IGV2ZXJ5IHJ1bGUgcGF0dGVybiBpcyBnbG9iYWwsIGFuZCBgdGVzdCgpYCB3b3VsZFxuICogYWR2YW5jZSBhbmQgY2FycnkgYGxhc3RJbmRleGAgYWNyb3NzIGNhbGxzLCBtYWtpbmcgdGhlIHJlc3VsdCBkZXBlbmQgb24gdGhlXG4gKiBwcmV2aW91cyBpbnB1dC4gYHNlYXJjaGAgc2F2ZXMgYW5kIHJlc3RvcmVzIGBsYXN0SW5kZXhgLCBzbyB0aGUgbGl0ZXJhbCBydWxlXG4gKiBwYXR0ZXJucyBjYW4gYmUgcmV1c2VkIGFzLWlzLiBDbG9uaW5nIHRoZW0gdGhyb3VnaCBgbmV3IFJlZ0V4cCguLi4pYCB3b3VsZFxuICogZG8gdGhlIHNhbWUgam9iIGJ1dCB0cmlwcyBzZW1ncmVwJ3MgYGRldGVjdC1ub24tbGl0ZXJhbC1yZWdleHBgIHJ1bGUsIGFuZCBhXG4gKiBkeW5hbWljYWxseS1idWlsdCByZWdleCBpcyB0aGUgd3JvbmcgcHJpbWl0aXZlIGhlcmUgYW55d2F5IOKAlCB0aGUgcGF0dGVybnNcbiAqIGFyZSBhbGwgaGFyZGNvZGVkIGxpdGVyYWxzLlxuICpcbiAqIFRoZSBgc2VjcmV0LWFzc2lnbm1lbnRgIHJ1bGUgaXMgdGhlIG9uZSBleGNlcHRpb246IGl0cyBtYXRjaCBpcyBub3QgdGhlXG4gKiB3aG9sZSBkZWNpc2lvbiwgc28gaXQgaXMgZGV0ZWN0ZWQgdGhyb3VnaCBgZGV0ZWN0c1NlY3JldEFzc2lnbm1lbnRgXG4gKiBpbnN0ZWFkIChJc3N1ZSAjMTcyNykuXG4gKi9cbmZ1bmN0aW9uIG1hdGNoZXNTaWduYXR1cmVSdWxlKHRleHQ6IHN0cmluZyk6IGJvb2xlYW4ge1xuICByZXR1cm4gUlVMRVMuc29tZSgocnVsZSkgPT5cbiAgICBydWxlLnBhdHRlcm4gPT09IFNFQ1JFVF9BU1NJR05NRU5UX1BBVFRFUk5cbiAgICAgID8gZGV0ZWN0c1NlY3JldEFzc2lnbm1lbnQodGV4dClcbiAgICAgIDogdGV4dC5zZWFyY2gocnVsZS5wYXR0ZXJuKSAhPT0gLTFcbiAgKTtcbn1cblxuLyoqXG4gKiBEZXRlY3QgYSBgc2VjcmV0LWFzc2lnbm1lbnRgIHRoZSByZXBsYWNlbWVudCBwYXNzIHdvdWxkIGFjdHVhbGx5IG1hc2suXG4gKlxuICogVGhlIHBhdHRlcm4gYWxvbmUgaXMgbm8gbG9uZ2VyIHRoZSB3aG9sZSBkZWNpc2lvbiAoSXNzdWUgIzE3MjcpLCBzbyBhXG4gKiBwYXR0ZXJuLW9ubHkgc2NhbiBtYWRlIGBjb250YWluc1NlY3JldGAgZGlzYWdyZWUgd2l0aCBgcmVkYWN0U2VjcmV0c2Ag4oCUIGl0XG4gKiByZXBvcnRlZCBhIHNlY3JldCBpbiBhIFBSIGJvZHkgd2hvc2Ugb25seSBcInNlY3JldFwiIHdhcyBhIE1lcm1haWQgZmVuY2UgYWZ0ZXJcbiAqIGEgYGNyZWRlbnRpYWw6YCBsZWFkLWluLiBFdmVyeSBjYW5kaWRhdGUgaXMgcHV0IHRocm91Z2hcbiAqIGBhc3NpZ25tZW50SXNNYXNrZWRgLCB0aGUgc2FtZSB2ZXJkaWN0IHRoZSBydWxlJ3MgYHJlcGxhY2VgIHJldHVybnMuXG4gKlxuICogUnVubmluZyAqZXZlcnkqIHJ1bGUgdGhyb3VnaCBgcmVwbGFjZWAgYW5kIGNvbXBhcmluZyB3b3VsZCBhbnN3ZXIgdGhpcyB0b28sXG4gKiBhbmQgaXQgd2FzIHRyaWVkIOKAlCBidXQgaXQgc2lsZW50bHkgbmFycm93ZWQgdGhlIG90aGVyIHJ1bGVzOlxuICogYHBlbS1ib2R5LWJsb2NrYCdzIGNhbGxiYWNrIGxlZ2l0aW1hdGVseSByZXR1cm5zIGl0cyBpbnB1dCB1bmNoYW5nZWQgZm9yIGFcbiAqIG5vbi11bmlmb3JtIGxpbmUgd2lkdGgsIGFuZCB0aGF0IGhhZCBiZWVuIGEgZGV0ZWN0aW9uLiBUaGUgb3RoZXIgcnVsZXNcbiAqIHRoZXJlZm9yZSBrZWVwIHRoZWlyIHBhdHRlcm4gc2Nhbjsgb25seSB0aGlzIG9uZSBjb25zdWx0cyBpdHMgdmFsdWVcbiAqIHByZWRpY2F0ZS5cbiAqXG4gKiBgbGFzdEluZGV4YCBpcyBzYXZlZCBhbmQgcmVzdG9yZWQgYXJvdW5kIHRoZSB3YWxrLiBUaGUgcGF0dGVybiBpcyBnbG9iYWwgYW5kXG4gKiBzaGFyZWQgd2l0aCB0aGUgcmVwbGFjZW1lbnQgcGFzcywgc28gYSBsZWFrZWQgb2Zmc2V0IHdvdWxkIG1ha2UgdGhlIG5leHRcbiAqIHNjYW4gZGVwZW5kIG9uIHRoaXMgb25lLlxuICovXG5mdW5jdGlvbiBkZXRlY3RzU2VjcmV0QXNzaWdubWVudCh0ZXh0OiBzdHJpbmcpOiBib29sZWFuIHtcbiAgY29uc3QgcGF0dGVybiA9IFNFQ1JFVF9BU1NJR05NRU5UX1BBVFRFUk47XG4gIGNvbnN0IHJlc3VtZSA9IHBhdHRlcm4ubGFzdEluZGV4O1xuICBwYXR0ZXJuLmxhc3RJbmRleCA9IDA7XG4gIHRyeSB7XG4gICAgbGV0IG1hdGNoOiBSZWdFeHBFeGVjQXJyYXkgfCBudWxsO1xuICAgIHdoaWxlICgobWF0Y2ggPSBwYXR0ZXJuLmV4ZWModGV4dCkpICE9PSBudWxsKSB7XG4gICAgICBpZiAoYXNzaWdubWVudElzTWFza2VkKG1hdGNoWzJdID8/IFwiXCIsIG1hdGNoWzNdID8/IFwiXCIpKSByZXR1cm4gdHJ1ZTtcbiAgICB9XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9IGZpbmFsbHkge1xuICAgIHBhdHRlcm4ubGFzdEluZGV4ID0gcmVzdW1lO1xuICB9XG59XG5cbi8qKlxuICogUmVkYWN0IGtub3duIHNlY3JldCBzaGFwZXMgZnJvbSBhIHN0cmluZy5cbiAqXG4gKiBTaWduYXR1cmUgcnVsZXMgcnVuIGZpcnN0LCB0aGVuIHRoZSBkZWNvZGUtdGhlbi1yZXNjYW4gcGFzc1xuICogKHtAbGluayByZWRhY3RUcmFuc2Zvcm1lZFNlY3JldHN9KSBtYXNrcyBhbnl0aGluZyBoaWRkZW4gdW5kZXIgYSByZXZlcnNpYmxlXG4gKiB0cmFuc2Zvcm0g4oCUIGJhc2U2NCwgaGV4LCBgcmV2YCwgb3IgYSBjcmVkZW50aWFsIHNwbGl0IGFjcm9zcyBsaW5lcy5cbiAqXG4gKiBAcGFyYW0gdGV4dCAtIEFyYml0cmFyeSB0ZXh0IGRlc3RpbmVkIGZvciBhIGxvZyBzaW5rLlxuICogQHJldHVybnMgVGhlIHRleHQgd2l0aCBhbnkgZGV0ZWN0ZWQgc2VjcmV0cyByZXBsYWNlZCBieVxuICogICAgICAgICAge0BsaW5rIFJFREFDVElPTl9QTEFDRUhPTERFUn0uIE5vbi1zZWNyZXQgY29udGVudCBpcyB1bmNoYW5nZWQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZWRhY3RTZWNyZXRzKHRleHQ6IHN0cmluZyk6IHN0cmluZyB7XG4gIGlmICghdGV4dCkgcmV0dXJuIHRleHQ7XG4gIGxldCBvdXQgPSB0ZXh0O1xuICBmb3IgKGNvbnN0IHJ1bGUgb2YgUlVMRVMpIHtcbiAgICAvLyBFYWNoIHJ1bGUncyBwYXR0ZXJuIGlzIGdsb2JhbDsgcmVwbGFjZSBoYW5kbGVzIGV2ZXJ5IG1hdGNoIGluIHRoZSBsaW5lLlxuICAgIG91dCA9IG91dC5yZXBsYWNlKFxuICAgICAgcnVsZS5wYXR0ZXJuLFxuICAgICAgcnVsZS5yZXBsYWNlIGFzIChzdWJzdHJpbmc6IHN0cmluZywgLi4uYXJnczogdW5rbm93bltdKSA9PiBzdHJpbmcsXG4gICAgKTtcbiAgfVxuICByZXR1cm4gcmVkYWN0VHJhbnNmb3JtZWRTZWNyZXRzKFxuICAgIG91dCxcbiAgICBtYXRjaGVzU2lnbmF0dXJlUnVsZSxcbiAgICBSRURBQ1RJT05fUExBQ0VIT0xERVIsXG4gICk7XG59XG5cbi8qKlxuICogUmVwb3J0IHdoZXRoZXIgdGhlIGdpdmVuIHRleHQgY29udGFpbnMgYXQgbGVhc3Qgb25lIGRldGVjdGFibGUgc2VjcmV0LlxuICpcbiAqIFVzZWZ1bCBmb3IgdGVzdHMgYW5kIGZvciBzZWN1cml0eS1ldmVudCBsb2dnaW5nIHRoYXQgd2FudHMgdG8gbm90ZSBcImFcbiAqIHNlY3JldCB3YXMgcmVkYWN0ZWRcIiB3aXRob3V0IGVjaG9pbmcgdGhlIHNlY3JldCBpdHNlbGYuXG4gKlxuICogQHBhcmFtIHRleHQgLSBUZXh0IHRvIGluc3BlY3QuXG4gKiBAcmV0dXJucyB0cnVlIGlmIHJlZGFjdGlvbiB3b3VsZCBjaGFuZ2UgdGhlIHRleHQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBjb250YWluc1NlY3JldCh0ZXh0OiBzdHJpbmcpOiBib29sZWFuIHtcbiAgaWYgKCF0ZXh0KSByZXR1cm4gZmFsc2U7XG4gIHJldHVybiByZWRhY3RTZWNyZXRzKHRleHQpICE9PSB0ZXh0O1xufVxuIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Q0EwQ0MsR0FFRCxTQUFTLHdCQUF3QixRQUFRLGtDQUFrQztBQUUzRTs7OztDQUlDLEdBQ0QsTUFBTSw0QkFDSjtBQUVGLGlFQUFpRSxHQUNqRSxPQUFPLE1BQU0sd0JBQXdCLGlCQUFpQjtBQWN0RDs7Ozs7Ozs7Ozs7Ozs7O0NBZUMsR0FDRCxNQUFNLGNBQWM7QUFFcEIsbUVBQW1FLEdBQ25FLE1BQU0sY0FBYztBQUVwQix1RUFBdUUsR0FDdkUsTUFBTSxlQUFlO0FBRXJCOzs7Ozs7Ozs7Q0FTQyxHQUNELE1BQU0sYUFBYTtBQUVuQiw4RUFBOEUsR0FDOUUsTUFBTSxtQkFBbUI7QUFFekIsK0VBQStFLEdBQy9FLE1BQU0sb0JBQW9CO0FBRTFCOzs7Ozs7Ozs7Ozs7Ozs7Q0FlQyxHQUNELE1BQU0sd0JBQXdCO0FBRTlCOzs7Ozs7Q0FNQyxHQUNELE1BQU0sb0JBQW9CO0FBRTFCLDhFQUE4RSxHQUM5RSxNQUFNLGtCQUFrQjtBQUV4Qjs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztDQStCQyxHQUNELE9BQU8sU0FBUyx3QkFDZCxLQUFhLEVBQ2IsUUFBaUI7RUFFakIsSUFBSSxVQUFVLE9BQU87RUFDckIsSUFBSSxZQUFZLElBQUksQ0FBQyxVQUFVLFlBQVksSUFBSSxDQUFDLFFBQVEsT0FBTztFQUMvRCxJQUFJLGtCQUFrQixJQUFJLENBQUMsUUFBUSxPQUFPO0VBQzFDLElBQUksYUFBYSxJQUFJLENBQUMsUUFBUSxPQUFPO0VBQ3JDLElBQUksTUFBTSxNQUFNLEdBQUcsdUJBQXVCLE9BQU87RUFDakQs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
// denoCacheMetadata=14813779854209847710,7715314744754652485