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
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

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
  // Bare PEM body with no markers at all (Issue #3707). A key can reach a log
  // sink stripped of its header — a truncated tail, a `grep` of the file, a
  // JSON-escaped value split across lines. Anchored on the PEM wrapping
  // convention: two or more consecutive full-width (64-character) base64
  // lines. Ordinary base64 in logs is a single short line, so this does not
  // match patch blobs, hashes, or prose.
  {
    name: "pem-body-block",
    pattern: /(?:[A-Za-z0-9+/]{64}\r?\n){2,}[A-Za-z0-9+/]{1,64}={0,2}/g,
    replace: () => REDACTION_PLACEHOLDER,
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
  {
    name: "secret-assignment",
    pattern:
      /\b([A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API[_-]?KEY|APIKEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|CREDENTIAL)[A-Za-z0-9_]*)(["']?\s*[=:]\s*)(?!\s)(?!\*\*\*REDACTED)(?=\S{0,63}[A-Za-z0-9])("[^"]+"|'[^']+'|\S+)/gi,
    replace: (_m, key: string, sep: string) =>
      `${key}${sep}${REDACTION_PLACEHOLDER}`,
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
];

/**
 * Redact known secret shapes from a string.
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
  return out;
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
