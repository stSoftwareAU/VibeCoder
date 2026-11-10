/**
 * Redact-before-truncate, made unforgeable by the type system (Issue #1217).
 *
 * `SECURITY.md` states the rule plainly: **a sink that trims output to a size
 * limit must run `redactSecrets()` first.** Cutting first splits a credential
 * across the boundary, and the surviving fragment has lost the anchor every
 * signature rule keys on — `ghp_`, `sk-ant-`, the `AKIA…` id that precedes an
 * AWS secret — so the later redaction pass at the sink matches nothing and the
 * fragment is published verbatim.
 *
 * The rule was documented and applied per call site, which is exactly the shape
 * that drifts: `handle_no_changes_phase.ts` redacted its no-changes comment
 * before slicing (Issue #3636) while ten sibling call sites in the same phase
 * modules sliced the agent's stdout to 500 characters raw and relied on the
 * redaction that `label_failure.ts` runs later — after the cut.
 *
 * This module makes the ordering a **type**, not a convention. {@link
 * RedactedText} is a branded string that only the constructors below can
 * produce, and they redact the whole input before they trim it. A field typed
 * `RedactedText` therefore cannot be fed `output.slice(-500)`: the build fails
 * at `deno check`, which is a stage of the quality gate.
 *
 * What the brand does and does not buy, stated plainly: it removes the
 * *silent* inversion — the raw slice a call site reaches for by habit — by
 * making it a compile error at the field. It cannot stop someone deliberately
 * handing a constructor already-truncated text (`redactedTail(raw.slice(-500),
 * 500)` type-checks); the constructors' contract is that they are given the
 * **whole** text, and that contract is prose. The `separator` hole is closed,
 * though — see {@link joinRedacted}.
 *
 * ```mermaid
 * flowchart LR
 *     O["agent stdout / ps table<br/>(may carry a token)"] --> R["redactSecrets<br/>(whole text)"]
 *     R --> T["trim to budget"]
 *     T --> S["public sink<br/>(issue comment, log)"]
 *     X["output.slice(-500)"] -. "compile error" .-> S
 * ```
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */ import { redactSecrets } from "./secret_redaction.ts";
import { truncateLogTail } from "./log_tail.ts";
/** A budget of zero or fewer keeps nothing; guard the callers' arithmetic. */ function clampBudget(maxChars) {
  return Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : 0;
}
/**
 * Redact `text` in full, then keep its last `maxChars` characters.
 *
 * The tail is what a failure message wants — the agent's final words before it
 * died — and it is also the cut that loses a credential's leading anchor, so
 * this is the constructor most call sites need.
 *
 * @param text - The full, untruncated text. Pass it whole; trimming it first is
 *   the bug this module exists to prevent.
 * @param maxChars - Characters to keep. Zero or less keeps nothing.
 * @returns The redacted tail, branded as {@link RedactedText}.
 */ export function redactedTail(text, maxChars) {
  const budget = clampBudget(maxChars);
  const masked = redactSecrets(text);
  return budget === 0 ? "" : masked.slice(-budget);
}
/**
 * Redact `text` in full, then keep its first `maxChars` characters.
 *
 * @param text - The full, untruncated text.
 * @param maxChars - Characters to keep. Zero or less keeps nothing.
 * @returns The redacted head, branded as {@link RedactedText}.
 */ export function redactedHead(text, maxChars) {
  const budget = clampBudget(maxChars);
  return redactSecrets(text).slice(0, budget);
}
/**
 * Redact `text` in full, then keep its first `headChars` and last `tailChars`
 * characters, with an elision marker between them.
 *
 * The tail alone is what a failure sink wants for an agent's last words, but
 * a quality-gate excerpt loses the *name of the failing check* that way: the
 * gate prints it as it starts a check, so a 500-character tail of a long run
 * begins mid-sentence and the log cannot say what is red (Issue #1852).
 *
 * @param text - The full, untruncated text. Pass it whole.
 * @param headChars - Characters to keep from the start.
 * @param tailChars - Characters to keep from the end.
 * @returns The redacted head, an elision marker, and the redacted tail,
 *   branded as {@link RedactedText}. Text that already fits is returned whole.
 */ export function redactedHeadTail(text, headChars, tailChars) {
  const head = clampBudget(headChars);
  const tail = clampBudget(tailChars);
  const masked = redactSecrets(text);
  if (masked.length <= head + tail) return masked;
  // `slice(-0)` is `slice(0)` — the whole string — so a zero tail budget has
  // to be answered before the cut, exactly as `redactedTail` does.
  const keptTail = tail === 0 ? "" : masked.slice(-tail);
  return `${masked.slice(0, head)}\n…\n${keptTail}`;
}
/**
 * Join already-redacted parts, dropping the empty ones.
 *
 * Concatenating two `RedactedText` values yields a plain `string` in
 * TypeScript, so a call site that stitches a stdout tail to a stderr tail needs
 * this to keep the brand.
 *
 * The `separator` is an unbranded `string` — call sites pass a literal — so it
 * is redacted like any other input rather than trusted. Without that, the
 * separator would be a hole straight through the brand: arbitrary text goes in
 * and `RedactedText` comes out. The parts themselves are already masked and
 * redaction is idempotent, so the rescan changes nothing else.
 *
 * @param parts - Redacted fragments, in order.
 * @param separator - Text placed between the non-empty parts.
 * @returns The joined text, branded as {@link RedactedText}.
 */ export function joinRedacted(parts, separator) {
  const joined = parts.filter((part)=>part.length > 0).join(separator);
  return redactSecrets(joined);
}
/**
 * Redact `text` in full, then keep its last `maxLines` lines.
 *
 * The line-granular cut is what a stderr tail or a quality-gate excerpt wants,
 * and it is the shape most of the inverted sites had (Issue #1257): a cut is
 * line-granular but the *file* is not, so the kept tail can still begin in the
 * middle of a PEM block whose `BEGIN` marker fell above the cut.
 *
 * @param text - The full, untruncated text.
 * @param maxLines - Lines to keep. Zero or less keeps nothing.
 * @returns The redacted tail, branded as {@link RedactedText}.
 */ export function redactedLineTail(text, maxLines) {
  const budget = clampBudget(maxLines);
  if (budget === 0) return "";
  return redactSecrets(text).split("\n").slice(-budget).join("\n");
}
/**
 * Redact `text` in full, then keep the tail that fits in `maxBytes` UTF-8
 * bytes, with the drop marker `truncateLogTail` prepends.
 *
 * This is the constructor for the CI log-tail sinks (Issue #1257). They used
 * to cut first so the byte cap applied to the raw log; redacting first is both
 * safer and a *tighter* cap, because a placeholder wider than the secret it
 * replaced can no longer push the finished block past the budget.
 *
 * @param text - The full, untruncated log.
 * @param maxBytes - Byte ceiling for the returned text.
 * @returns The redacted tail, branded as {@link RedactedText}.
 */ export function redactedLogTail(text, maxBytes) {
  return truncateLogTail(redactSecrets(text), maxBytes);
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9yZWRhY3RlZF90ZXh0LnRzIl0sInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogUmVkYWN0LWJlZm9yZS10cnVuY2F0ZSwgbWFkZSB1bmZvcmdlYWJsZSBieSB0aGUgdHlwZSBzeXN0ZW0gKElzc3VlICMxMjE3KS5cbiAqXG4gKiBgU0VDVVJJVFkubWRgIHN0YXRlcyB0aGUgcnVsZSBwbGFpbmx5OiAqKmEgc2luayB0aGF0IHRyaW1zIG91dHB1dCB0byBhIHNpemVcbiAqIGxpbWl0IG11c3QgcnVuIGByZWRhY3RTZWNyZXRzKClgIGZpcnN0LioqIEN1dHRpbmcgZmlyc3Qgc3BsaXRzIGEgY3JlZGVudGlhbFxuICogYWNyb3NzIHRoZSBib3VuZGFyeSwgYW5kIHRoZSBzdXJ2aXZpbmcgZnJhZ21lbnQgaGFzIGxvc3QgdGhlIGFuY2hvciBldmVyeVxuICogc2lnbmF0dXJlIHJ1bGUga2V5cyBvbiDigJQgYGdocF9gLCBgc2stYW50LWAsIHRoZSBgQUtJQeKApmAgaWQgdGhhdCBwcmVjZWRlcyBhblxuICogQVdTIHNlY3JldCDigJQgc28gdGhlIGxhdGVyIHJlZGFjdGlvbiBwYXNzIGF0IHRoZSBzaW5rIG1hdGNoZXMgbm90aGluZyBhbmQgdGhlXG4gKiBmcmFnbWVudCBpcyBwdWJsaXNoZWQgdmVyYmF0aW0uXG4gKlxuICogVGhlIHJ1bGUgd2FzIGRvY3VtZW50ZWQgYW5kIGFwcGxpZWQgcGVyIGNhbGwgc2l0ZSwgd2hpY2ggaXMgZXhhY3RseSB0aGUgc2hhcGVcbiAqIHRoYXQgZHJpZnRzOiBgaGFuZGxlX25vX2NoYW5nZXNfcGhhc2UudHNgIHJlZGFjdGVkIGl0cyBuby1jaGFuZ2VzIGNvbW1lbnRcbiAqIGJlZm9yZSBzbGljaW5nIChJc3N1ZSAjMzYzNikgd2hpbGUgdGVuIHNpYmxpbmcgY2FsbCBzaXRlcyBpbiB0aGUgc2FtZSBwaGFzZVxuICogbW9kdWxlcyBzbGljZWQgdGhlIGFnZW50J3Mgc3Rkb3V0IHRvIDUwMCBjaGFyYWN0ZXJzIHJhdyBhbmQgcmVsaWVkIG9uIHRoZVxuICogcmVkYWN0aW9uIHRoYXQgYGxhYmVsX2ZhaWx1cmUudHNgIHJ1bnMgbGF0ZXIg4oCUIGFmdGVyIHRoZSBjdXQuXG4gKlxuICogVGhpcyBtb2R1bGUgbWFrZXMgdGhlIG9yZGVyaW5nIGEgKip0eXBlKiosIG5vdCBhIGNvbnZlbnRpb24uIHtAbGlua1xuICogUmVkYWN0ZWRUZXh0fSBpcyBhIGJyYW5kZWQgc3RyaW5nIHRoYXQgb25seSB0aGUgY29uc3RydWN0b3JzIGJlbG93IGNhblxuICogcHJvZHVjZSwgYW5kIHRoZXkgcmVkYWN0IHRoZSB3aG9sZSBpbnB1dCBiZWZvcmUgdGhleSB0cmltIGl0LiBBIGZpZWxkIHR5cGVkXG4gKiBgUmVkYWN0ZWRUZXh0YCB0aGVyZWZvcmUgY2Fubm90IGJlIGZlZCBgb3V0cHV0LnNsaWNlKC01MDApYDogdGhlIGJ1aWxkIGZhaWxzXG4gKiBhdCBgZGVubyBjaGVja2AsIHdoaWNoIGlzIGEgc3RhZ2Ugb2YgdGhlIHF1YWxpdHkgZ2F0ZS5cbiAqXG4gKiBXaGF0IHRoZSBicmFuZCBkb2VzIGFuZCBkb2VzIG5vdCBidXksIHN0YXRlZCBwbGFpbmx5OiBpdCByZW1vdmVzIHRoZVxuICogKnNpbGVudCogaW52ZXJzaW9uIOKAlCB0aGUgcmF3IHNsaWNlIGEgY2FsbCBzaXRlIHJlYWNoZXMgZm9yIGJ5IGhhYml0IOKAlCBieVxuICogbWFraW5nIGl0IGEgY29tcGlsZSBlcnJvciBhdCB0aGUgZmllbGQuIEl0IGNhbm5vdCBzdG9wIHNvbWVvbmUgZGVsaWJlcmF0ZWx5XG4gKiBoYW5kaW5nIGEgY29uc3RydWN0b3IgYWxyZWFkeS10cnVuY2F0ZWQgdGV4dCAoYHJlZGFjdGVkVGFpbChyYXcuc2xpY2UoLTUwMCksXG4gKiA1MDApYCB0eXBlLWNoZWNrcyk7IHRoZSBjb25zdHJ1Y3RvcnMnIGNvbnRyYWN0IGlzIHRoYXQgdGhleSBhcmUgZ2l2ZW4gdGhlXG4gKiAqKndob2xlKiogdGV4dCwgYW5kIHRoYXQgY29udHJhY3QgaXMgcHJvc2UuIFRoZSBgc2VwYXJhdG9yYCBob2xlIGlzIGNsb3NlZCxcbiAqIHRob3VnaCDigJQgc2VlIHtAbGluayBqb2luUmVkYWN0ZWR9LlxuICpcbiAqIGBgYG1lcm1haWRcbiAqIGZsb3djaGFydCBMUlxuICogICAgIE9bXCJhZ2VudCBzdGRvdXQgLyBwcyB0YWJsZTxici8+KG1heSBjYXJyeSBhIHRva2VuKVwiXSAtLT4gUltcInJlZGFjdFNlY3JldHM8YnIvPih3aG9sZSB0ZXh0KVwiXVxuICogICAgIFIgLS0+IFRbXCJ0cmltIHRvIGJ1ZGdldFwiXVxuICogICAgIFQgLS0+IFNbXCJwdWJsaWMgc2luazxici8+KGlzc3VlIGNvbW1lbnQsIGxvZylcIl1cbiAqICAgICBYW1wib3V0cHV0LnNsaWNlKC01MDApXCJdIC0uIFwiY29tcGlsZSBlcnJvclwiIC4tPiBTXG4gKiBgYGBcbiAqXG4gKiBVc2VzIEF1c3RyYWxpYW4gRW5nbGlzaCB0aHJvdWdob3V0IChiZWhhdmlvdXIsIGNvbG91ciwgb3JnYW5pc2F0aW9uLCBldGMuKS5cbiAqL1xuXG5pbXBvcnQgeyByZWRhY3RTZWNyZXRzIH0gZnJvbSBcIi4vc2VjcmV0X3JlZGFjdGlvbi50c1wiO1xuaW1wb3J0IHsgdHJ1bmNhdGVMb2dUYWlsIH0gZnJvbSBcIi4vbG9nX3RhaWwudHNcIjtcblxuZGVjbGFyZSBjb25zdCByZWRhY3RlZFRleHRCcmFuZDogdW5pcXVlIHN5bWJvbDtcblxuLyoqXG4gKiBUZXh0IHRoYXQgaGFzIGJlZW4gdGhyb3VnaCB7QGxpbmsgcmVkYWN0U2VjcmV0c30gb3ZlciBpdHMgKip3aG9sZSoqIGxlbmd0aFxuICogYmVmb3JlIGFueSB0cmltbWluZy5cbiAqXG4gKiBUaGUgYnJhbmQgaXMgbm9taW5hbCBhbmQgY2Fubm90IGJlIG1pbnRlZCBvdXRzaWRlIHRoaXMgbW9kdWxlLCBzbyBhIGZpZWxkXG4gKiB0eXBlZCBgUmVkYWN0ZWRUZXh0YCBjYW5ub3QgYmUgaGFuZGVkIHJhdywgcHJlLXRydW5jYXRlZCB0ZXh0IGJ5IG1pc3Rha2UuXG4gKi9cbmV4cG9ydCB0eXBlIFJlZGFjdGVkVGV4dCA9IHN0cmluZyAmIHsgcmVhZG9ubHkgW3JlZGFjdGVkVGV4dEJyYW5kXTogdHJ1ZSB9O1xuXG4vKiogQSBidWRnZXQgb2YgemVybyBvciBmZXdlciBrZWVwcyBub3RoaW5nOyBndWFyZCB0aGUgY2FsbGVycycgYXJpdGhtZXRpYy4gKi9cbmZ1bmN0aW9uIGNsYW1wQnVkZ2V0KG1heENoYXJzOiBudW1iZXIpOiBudW1iZXIge1xuICByZXR1cm4gTnVtYmVyLmlzRmluaXRlKG1heENoYXJzKSAmJiBtYXhDaGFycyA+IDAgPyBNYXRoLmZsb29yKG1heENoYXJzKSA6IDA7XG59XG5cbi8qKlxuICogUmVkYWN0IGB0ZXh0YCBpbiBmdWxsLCB0aGVuIGtlZXAgaXRzIGxhc3QgYG1heENoYXJzYCBjaGFyYWN0ZXJzLlxuICpcbiAqIFRoZSB0YWlsIGlzIHdoYXQgYSBmYWlsdXJlIG1lc3NhZ2Ugd2FudHMg4oCUIHRoZSBhZ2VudCdzIGZpbmFsIHdvcmRzIGJlZm9yZSBpdFxuICogZGllZCDigJQgYW5kIGl0IGlzIGFsc28gdGhlIGN1dCB0aGF0IGxvc2VzIGEgY3JlZGVudGlhbCdzIGxlYWRpbmcgYW5jaG9yLCBzb1xuICogdGhpcyBpcyB0aGUgY29uc3RydWN0b3IgbW9zdCBjYWxsIHNpdGVzIG5lZWQuXG4gKlxuICogQHBhcmFtIHRleHQgLSBUaGUgZnVsbCwgdW50cnVuY2F0ZWQgdGV4dC4gUGFzcyBpdCB3aG9sZTsgdHJpbW1pbmcgaXQgZmlyc3QgaXNcbiAqICAgdGhlIGJ1ZyB0aGlzIG1vZHVsZSBleGlzdHMgdG8gcHJldmVudC5cbiAqIEBwYXJhbSBtYXhDaGFycyAtIENoYXJhY3RlcnMgdG8ga2VlcC4gWmVybyBvciBsZXNzIGtlZXBzIG5vdGhpbmcuXG4gKiBAcmV0dXJucyBUaGUgcmVkYWN0ZWQgdGFpbCwgYnJhbmRlZCBhcyB7QGxpbmsgUmVkYWN0ZWRUZXh0fS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlZGFjdGVkVGFpbCh0ZXh0OiBzdHJpbmcsIG1heENoYXJzOiBudW1iZXIpOiBSZWRhY3RlZFRleHQge1xuICBjb25zdCBidWRnZXQgPSBjbGFtcEJ1ZGdldChtYXhDaGFycyk7XG4gIGNvbnN0IG1hc2tlZCA9IHJlZGFjdFNlY3JldHModGV4dCk7XG4gIHJldHVybiAoYnVkZ2V0ID09PSAwID8gXCJcIiA6IG1hc2tlZC5zbGljZSgtYnVkZ2V0KSkgYXMgUmVkYWN0ZWRUZXh0O1xufVxuXG4vKipcbiAqIFJlZGFjdCBgdGV4dGAgaW4gZnVsbCwgdGhlbiBrZWVwIGl0cyBmaXJzdCBgbWF4Q2hhcnNgIGNoYXJhY3RlcnMuXG4gKlxuICogQHBhcmFtIHRleHQgLSBUaGUgZnVsbCwgdW50cnVuY2F0ZWQgdGV4dC5cbiAqIEBwYXJhbSBtYXhDaGFycyAtIENoYXJhY3RlcnMgdG8ga2VlcC4gWmVybyBvciBsZXNzIGtlZXBzIG5vdGhpbmcuXG4gKiBAcmV0dXJucyBUaGUgcmVkYWN0ZWQgaGVhZCwgYnJhbmRlZCBhcyB7QGxpbmsgUmVkYWN0ZWRUZXh0fS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlZGFjdGVkSGVhZCh0ZXh0OiBzdHJpbmcsIG1heENoYXJzOiBudW1iZXIpOiBSZWRhY3RlZFRleHQge1xuICBjb25zdCBidWRnZXQgPSBjbGFtcEJ1ZGdldChtYXhDaGFycyk7XG4gIHJldHVybiByZWRhY3RTZWNyZXRzKHRleHQpLnNsaWNlKDAsIGJ1ZGdldCkgYXMgUmVkYWN0ZWRUZXh0O1xufVxuXG4vKipcbiAqIFJlZGFjdCBgdGV4dGAgaW4gZnVsbCwgdGhlbiBrZWVwIGl0cyBmaXJzdCBgaGVhZENoYXJzYCBhbmQgbGFzdCBgdGFpbENoYXJzYFxuICogY2hhcmFjdGVycywgd2l0aCBhbiBlbGlzaW9uIG1hcmtlciBiZXR3ZWVuIHRoZW0uXG4gKlxuICogVGhlIHRhaWwgYWxvbmUgaXMgd2hhdCBhIGZhaWx1cmUgc2luayB3YW50cyBmb3IgYW4gYWdlbnQncyBsYXN0IHdvcmRzLCBidXRcbiAqIGEgcXVhbGl0eS1nYXRlIGV4Y2VycHQgbG9zZXMgdGhlICpuYW1lIG9mIHRoZSBmYWlsaW5nIGNoZWNrKiB0aGF0IHdheTogdGhlXG4gKiBnYXRlIHByaW50cyBpdCBhcyBpdCBzdGFydHMgYSBjaGVjaywgc28gYSA1MDAtY2hhcmFjdGVyIHRhaWwgb2YgYSBsb25nIHJ1blxuICogYmVnaW5zIG1pZC1zZW50ZW5jZSBhbmQgdGhlIGxvZyBjYW5ub3Qgc2F5IHdoYXQgaXMgcmVkIChJc3N1ZSAjMTg1MikuXG4gKlxuICogQHBhcmFtIHRleHQgLSBUaGUgZnVsbCwgdW50cnVuY2F0ZWQgdGV4dC4gUGFzcyBpdCB3aG9sZS5cbiAqIEBwYXJhbSBoZWFkQ2hhcnMgLSBDaGFyYWN0ZXJzIHRvIGtlZXAgZnJvbSB0aGUgc3RhcnQuXG4gKiBAcGFyYW0gdGFpbENoYXJzIC0gQ2hhcmFjdGVycyB0byBrZWVwIGZyb20gdGhlIGVuZC5cbiAqIEByZXR1cm5zIFRoZSByZWRhY3RlZCBoZWFkLCBhbiBlbGlzaW9uIG1hcmtlciwgYW5kIHRoZSByZWRhY3RlZCB0YWlsLFxuICogICBicmFuZGVkIGFzIHtAbGluayBSZWRhY3RlZFRleHR9LiBUZXh0IHRoYXQgYWxyZWFkeSBmaXRzIGlzIHJldHVybmVkIHdob2xlLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcmVkYWN0ZWRIZWFkVGFpbChcbiAgdGV4dDogc3RyaW5nLFxuICBoZWFkQ2hhcnM6IG51bWJlcixcbiAgdGFpbENoYXJzOiBudW1iZXIsXG4pOiBSZWRhY3RlZFRleHQge1xuICBjb25zdCBoZWFkID0gY2xhbXBCdWRnZXQoaGVhZENoYXJzKTtcbiAgY29uc3QgdGFpbCA9IGNsYW1wQnVkZ2V0KHRhaWxDaGFycyk7XG4gIGNvbnN0IG1hc2tlZCA9IHJlZGFjdFNlY3JldHModGV4dCk7XG4gIGlmIChtYXNrZWQubGVuZ3RoIDw9IGhlYWQgKyB0YWlsKSByZXR1cm4gbWFza2VkIGFzIFJlZGFjdGVkVGV4dDtcbiAgLy8gYHNsaWNlKC0wKWAgaXMgYHNsaWNlKDApYCDigJQgdGhlIHdob2xlIHN0cmluZyDigJQgc28gYSB6ZXJvIHRhaWwgYnVkZ2V0IGhhc1xuICAvLyB0byBiZSBhbnN3ZXJlZCBiZWZvcmUgdGhlIGN1dCwgZXhhY3RseSBhcyBgcmVkYWN0ZWRUYWlsYCBkb2VzLlxuICBjb25zdCBrZXB0VGFpbCA9IHRhaWwgPT09IDAgPyBcIlwiIDogbWFza2VkLnNsaWNlKC10YWlsKTtcbiAgcmV0dXJuIGAke21hc2tlZC5zbGljZSgwLCBoZWFkKX1cXG7igKZcXG4ke2tlcHRUYWlsfWAgYXMgUmVkYWN0ZWRUZXh0O1xufVxuXG4vKipcbiAqIEpvaW4gYWxyZWFkeS1yZWRhY3RlZCBwYXJ0cywgZHJvcHBpbmcgdGhlIGVtcHR5IG9uZXMuXG4gKlxuICogQ29uY2F0ZW5hdGluZyB0d28gYFJlZGFjdGVkVGV4dGAgdmFsdWVzIHlpZWxkcyBhIHBsYWluIGBzdHJpbmdgIGluXG4gKiBUeXBlU2NyaXB0LCBzbyBhIGNhbGwgc2l0ZSB0aGF0IHN0aXRjaGVzIGEgc3Rkb3V0IHRhaWwgdG8gYSBzdGRlcnIgdGFpbCBuZWVkc1xuICogdGhpcyB0byBrZWVwIHRoZSBicmFuZC5cbiAqXG4gKiBUaGUgYHNlcGFyYXRvcmAgaXMgYW4gdW5icmFuZGVkIGBzdHJpbmdgIOKAlCBjYWxsIHNpdGVzIHBhc3MgYSBsaXRlcmFsIOKAlCBzbyBpdFxuICogaXMgcmVkYWN0ZWQgbGlrZSBhbnkgb3RoZXIgaW5wdXQgcmF0aGVyIHRoYW4gdHJ1c3RlZC4gV2l0aG91dCB0aGF0LCB0aGVcbiAqIHNlcGFyYXRvciB3b3VsZCBiZSBhIGhvbGUgc3RyYWlnaHQgdGhyb3VnaCB0aGUgYnJhbmQ6IGFyYml0cmFyeSB0ZXh0IGdvZXMgaW5cbiAqIGFuZCBgUmVkYWN0ZWRUZXh0YCBjb21lcyBvdXQuIFRoZSBwYXJ0cyB0aGVtc2VsdmVzIGFyZSBhbHJlYWR5IG1hc2tlZCBhbmRcbiAqIHJlZGFjdGlvbiBpcyBpZGVtcG90ZW50LCBzbyB0aGUgcmVzY2FuIGNoYW5nZXMgbm90aGluZyBlbHNlLlxuICpcbiAqIEBwYXJhbSBwYXJ0cyAtIFJlZGFjdGVkIGZyYWdtZW50cywgaW4gb3JkZXIuXG4gKiBAcGFyYW0gc2VwYXJhdG9yIC0gVGV4dCBwbGFjZWQgYmV0d2VlbiB0aGUgbm9uLWVtcHR5IHBhcnRzLlxuICogQHJldHVybnMgVGhlIGpvaW5lZCB0ZXh0LCBicmFuZGVkIGFzIHtAbGluayBSZWRhY3RlZFRleHR9LlxuICovXG5leHBvcnQgZnVuY3Rpb24gam9pblJlZGFjdGVkKFxuICBwYXJ0czogcmVhZG9ubHkgUmVkYWN0ZWRUZXh0W10sXG4gIHNlcGFyYXRvcjogc3RyaW5nLFxuKTogUmVkYWN0ZWRUZXh0IHtcbiAgY29uc3Qgam9pbmVkID0gcGFydHMuZmlsdGVyKChwYXJ0KSA9PiBwYXJ0Lmxlbmd0aCA+IDApLmpvaW4oc2VwYXJhdG9yKTtcbiAgcmV0dXJuIHJlZGFjdFNlY3JldHMoam9pbmVkKSBhcyBSZWRhY3RlZFRleHQ7XG59XG5cbi8qKlxuICogUmVkYWN0IGB0ZXh0YCBpbiBmdWxsLCB0aGVuIGtlZXAgaXRzIGxhc3QgYG1heExpbmVzYCBsaW5lcy5cbiAqXG4gKiBUaGUgbGluZS1ncmFudWxhciBjdXQgaXMgd2hhdCBhIHN0ZGVyciB0YWlsIG9yIGEgcXVhbGl0eS1nYXRlIGV4Y2VycHQgd2FudHMsXG4gKiBhbmQgaXQgaXMgdGhlIHNoYXBlIG1vc3Qgb2YgdGhlIGludmVydGVkIHNpdGVzIGhhZCAoSXNzdWUgIzEyNTcpOiBhIGN1dCBpc1xuICogbGluZS1ncmFudWxhciBidXQgdGhlICpmaWxlKiBpcyBub3QsIHNvIHRoZSBrZXB0IHRhaWwgY2FuIHN0aWxsIGJlZ2luIGluIHRoZVxuICogbWlkZGxlIG9mIGEgUEVNIGJsb2NrIHdob3NlIGBCRUdJTmAgbWFya2VyIGZlbGwgYWJvdmUgdGhlIGN1dC5cbiAqXG4gKiBAcGFyYW0gdGV4dCAtIFRoZSBmdWxsLCB1bnRydW5jYXRlZCB0ZXh0LlxuICogQHBhcmFtIG1heExpbmVzIC0gTGluZXMgdG8ga2VlcC4gWmVybyBvciBsZXNzIGtlZXBzIG5vdGhpbmcuXG4gKiBAcmV0dXJucyBUaGUgcmVkYWN0ZWQgdGFpbCwgYnJhbmRlZCBhcyB7QGxpbmsgUmVkYWN0ZWRUZXh0fS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlZGFjdGVkTGluZVRhaWwodGV4dDogc3RyaW5nLCBtYXhMaW5lczogbnVtYmVyKTogUmVkYWN0ZWRUZXh0IHtcbiAgY29uc3QgYnVkZ2V0ID0gY2xhbXBCdWRnZXQobWF4TGluZXMpO1xuICBpZiAoYnVkZ2V0ID09PSAwKSByZXR1cm4gXCJcIiBhcyBSZWRhY3RlZFRleHQ7XG4gIHJldHVybiByZWRhY3RTZWNyZXRzKHRleHQpLnNwbGl0KFwiXFxuXCIpLnNsaWNlKC1idWRnZXQpLmpvaW4oXG4gICAgXCJcXG5cIixcbiAgKSBhcyBSZWRhY3RlZFRleHQ7XG59XG5cbi8qKlxuICogUmVkYWN0IGB0ZXh0YCBpbiBmdWxsLCB0aGVuIGtlZXAgdGhlIHRhaWwgdGhhdCBmaXRzIGluIGBtYXhCeXRlc2AgVVRGLThcbiAqIGJ5dGVzLCB3aXRoIHRoZSBkcm9wIG1hcmtlciBgdHJ1bmNhdGVMb2dUYWlsYCBwcmVwZW5kcy5cbiAqXG4gKiBUaGlzIGlzIHRoZSBjb25zdHJ1Y3RvciBmb3IgdGhlIENJIGxvZy10YWlsIHNpbmtzIChJc3N1ZSAjMTI1NykuIFRoZXkgdXNlZFxuICogdG8gY3V0IGZpcnN0IHNvIHRoZSBieXRlIGNhcCBhcHBsaWVkIHRvIHRoZSByYXcgbG9nOyByZWRhY3RpbmcgZmlyc3QgaXMgYm90aFxuICogc2FmZXIgYW5kIGEgKnRpZ2h0ZXIqIGNhcCwgYmVjYXVzZSBhIHBsYWNlaG9sZGVyIHdpZGVyIHRoYW4gdGhlIHNlY3JldCBpdFxuICogcmVwbGFjZWQgY2FuIG5vIGxvbmdlciBwdXNoIHRoZSBmaW5pc2hlZCBibG9jayBwYXN0IHRoZSBidWRnZXQuXG4gKlxuICogQHBhcmFtIHRleHQgLSBUaGUgZnVsbCwgdW50cnVuY2F0ZWQgbG9nLlxuICogQHBhcmFtIG1heEJ5dGVzIC0gQnl0ZSBjZWlsaW5nIGZvciB0aGUgcmV0dXJuZWQgdGV4dC5cbiAqIEByZXR1cm5zIFRoZSByZWRhY3RlZCB0YWlsLCBicmFuZGVkIGFzIHtAbGluayBSZWRhY3RlZFRleHR9LlxuICovXG5leHBvcnQgZnVuY3Rpb24gcmVkYWN0ZWRMb2dUYWlsKHRleHQ6IHN0cmluZywgbWF4Qnl0ZXM6IG51bWJlcik6IFJlZGFjdGVkVGV4dCB7XG4gIHJldHVybiB0cnVuY2F0ZUxvZ1RhaWwocmVkYWN0U2VjcmV0cyh0ZXh0KSwgbWF4Qnl0ZXMpIGFzIFJlZGFjdGVkVGV4dDtcbn1cbiJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0NBdUNDLEdBRUQsU0FBUyxhQUFhLFFBQVEsd0JBQXdCO0FBQ3RELFNBQVMsZUFBZSxRQUFRLGdCQUFnQjtBQWFoRCw0RUFBNEUsR0FDNUUsU0FBUyxZQUFZLFFBQWdCO0VBQ25DLE9BQU8sT0FBTyxRQUFRLENBQUMsYUFBYSxXQUFXLElBQUksS0FBSyxLQUFLLENBQUMsWUFBWTtBQUM1RTtBQUVBOzs7Ozs7Ozs7OztDQVdDLEdBQ0QsT0FBTyxTQUFTLGFBQWEsSUFBWSxFQUFFLFFBQWdCO0VBQ3pELE1BQU0sU0FBUyxZQUFZO0VBQzNCLE1BQU0sU0FBUyxjQUFjO0VBQzdCLE9BQVEsV0FBVyxJQUFJLEtBQUssT0FBTyxLQUFLLENBQUMsQ0FBQztBQUM1QztBQUVBOzs7Ozs7Q0FNQyxHQUNELE9BQU8sU0FBUyxhQUFhLElBQVksRUFBRSxRQUFnQjtFQUN6RCxNQUFNLFNBQVMsWUFBWTtFQUMzQixPQUFPLGNBQWMsTUFBTSxLQUFLLENBQUMsR0FBRztBQUN0QztBQUVBOzs7Ozs7Ozs7Ozs7OztDQWNDLEdBQ0QsT0FBTyxTQUFTLGlCQUNkLElBQVksRUFDWixTQUFpQixFQUNqQixTQUFpQjtFQUVqQixNQUFNLE9BQU8sWUFBWTtFQUN6QixNQUFNLE9BQU8sWUFBWTtFQUN6QixNQUFNLFNBQVMsY0FBYztFQUM3QixJQUFJLE9BQU8sTUFBTSxJQUFJLE9BQU8sTUFBTSxPQUFPO0VBQ3pDLDJFQUEyRTtFQUMzRSxpRUFBaUU7RUFDakUsTUFBTSxXQUFXLFNBQVMsSUFBSSxLQUFLLE9BQU8sS0FBSyxDQUFDLENBQUM7RUFDakQsT0FBTyxHQUFHLE9BQU8sS0FBSyxDQUFDLEdBQUcsTUFBTSxLQUFLLEVBQUUsVUFBVTtBQUNuRDtBQUVBOzs7Ozs7Ozs7Ozs7Ozs7O0NBZ0JDLEdBQ0QsT0FBTyxTQUFTLGFBQ2QsS0FBOEIsRUFDOUIsU0FBaUI7RUFFakIsTUFBTSxTQUFTLE1BQU0sTUFBTSxDQUFDLENBQUMsT0FBUyxLQUFLLE1BQU0sR0FBRyxHQUFHLElBQUksQ0FBQztFQUM1RCxPQUFPLGNBQWM7QUFDdkI7QUFFQTs7Ozs7Ozs7Ozs7Q0FXQyxHQUNELE9BQU8sU0FBUyxpQkFBaUIsSUFBWSxFQUFFLFFBQWdCO0VBQzdELE1BQU0sU0FBUyxZQUFZO0VBQzNCLElBQUksV0FBVyxHQUFHLE9BQU87RUFDekIsT0FBTyxjQUFjLE1BQU0sS0FBSyxDQUFDLE1BQU0sS0FBSyxDQUFDLENBQUMsUUFBUSxJQUFJLENBQ3hEO0FBRUo7QUFFQTs7Ozs7Ozs7Ozs7O0NBWUMsR0FDRCxPQUFPLFNBQVMsZ0JBQWdCLElBQVksRUFBRSxRQUFnQjtFQUM1RCxPQUFPLGdCQUFnQixjQUFjLE9BQU87QUFDOUMifQ==
// denoCacheMetadata=14952322286204556259,3591149949154229310