/**
 * Neutralise worker marker syntax in agent-authored text (Issue #2236).
 *
 * The CI-fix and PR-feedback lanes post the agent's own `.pr_response_message`
 * verbatim into a comment the **fleet account** authors, and those
 * fleet-authored bodies are the fleet-wide record of CI-fix attempts and
 * deferrals (Issue #1879). That record is gated on the *comment's* author, so
 * a `<!-- vibe-ci-fix-attempt … -->` or `<!-- vibe-ci-fix-deferred … -->`
 * marker smuggled into the agent's message would be posted by the fleet and
 * read back as the fleet's own claim: a forged deferral parks a red pull
 * request for good, and forged attempts exhaust the shared attempt budget.
 *
 * The agent's message condenses the failing check's annotations, the fetched
 * Actions log and the branch's own files — all attacker-influenced on a
 * monitored repository — so it is untrusted text inside a trusted container.
 *
 * Two properties this module exists to hold:
 *
 * - **Neutralise by construction, never by name.** Every HTML-comment
 *   delimiter is made inert, so no marker of any name — including one added
 *   years from now — can be opened or closed by agent text. A filter naming
 *   the markers it knows is a bad-tag-filter, and the next marker name
 *   silently reopens the hole.
 * - **Fail loud.** Marker syntax in agent text is a prompt-injection attempt,
 *   not a formatting quirk. {@link neutraliseAgentMarkers} reports what it
 *   defused so the caller can log it rather than swallow it.
 *
 * The neutralisation runs on the untrusted text alone. The worker's own marker
 * is concatenated afterwards and is untouched, so #1879's fleet-wide tally
 * still parses exactly as before.
 *
 * The agent's message is not the only untrusted value those bodies carry: the
 * failing check's name is fork-chosen on a `pull_request`-triggered workflow
 * (the job name comes from the head ref), and the CI-fix replies interpolate
 * it into the same fleet-authored prose. It runs through this same helper
 * (Issue #2260) — the properties above are why one helper serves both.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */ /** Most marker-like names carried in the report; the rest are counted only. */ const MAX_REPORTED_NAMES = 5;
/** Longest name reported, so a log line cannot be flooded. */ const MAX_NAME_LENGTH = 64;
/** Opening delimiter of an HTML comment — how every marker starts. */ const COMMENT_OPEN = /<!--/g;
/**
 * Closing delimiter — how every marker ends.
 *
 * HTML parsers also close a comment on `--!>`, so a filter that matches only
 * `-->` leaves a working closer behind (CodeQL js/bad-tag-filter).
 */ const COMMENT_CLOSE = /--!?>/g;
/**
 * The name directly after an opening delimiter.
 *
 * Used **only** to describe what was defused in the warning; the
 * neutralisation itself never consults it.
 */ const MARKER_NAME_RE = /<!--\s*([A-Za-z][A-Za-z0-9_:.-]*)/g;
/**
 * Make every HTML-comment delimiter in agent-authored text inert.
 *
 * A space is kept inside each neutralised token (`<!- -`, `- ->`) so a longer
 * run of dashes cannot re-form the delimiter, and the text stays readable:
 * the injected marker is visible in the posted comment rather than silently
 * deleted, which is what makes an attempt evident to a reviewer.
 *
 * @param text - The agent's own message.
 * @returns The inert text, plus what was defused.
 */ export function neutraliseAgentMarkers(text) {
  const opens = text.match(COMMENT_OPEN)?.length ?? 0;
  const closes = text.match(COMMENT_CLOSE)?.length ?? 0;
  if (opens === 0 && closes === 0) {
    return {
      text,
      neutralised: 0,
      names: []
    };
  }
  const names = [];
  for (const match of text.matchAll(MARKER_NAME_RE)){
    const name = (match[1] ?? "").slice(0, MAX_NAME_LENGTH);
    if (name.length === 0 || names.includes(name)) continue;
    if (names.length >= MAX_REPORTED_NAMES) break;
    names.push(name);
  }
  return {
    text: neutraliseCommentDelimiters(text),
    neutralised: opens + closes,
    names
  };
}
/**
 * Make every HTML-comment opener and closer in `text` inert.
 *
 * The one copy of the replacement every body writer uses before it fences or
 * files untrusted output, so a closer form added here is added everywhere.
 * A space is kept inside each token (`<!- -`, `- ->`) so a longer dash run
 * cannot re-form the delimiter from the surviving characters.
 *
 * @param text - Untrusted text bound for an issue or comment body
 * @returns The text with no comment delimiter left in it
 */ export function neutraliseCommentDelimiters(text) {
  return text.replace(COMMENT_CLOSE, "- ->").replace(COMMENT_OPEN, "<!- -");
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9hZ2VudF9tYXJrZXJfbmV1dHJhbGlzYXRpb24udHMiXSwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBOZXV0cmFsaXNlIHdvcmtlciBtYXJrZXIgc3ludGF4IGluIGFnZW50LWF1dGhvcmVkIHRleHQgKElzc3VlICMyMjM2KS5cbiAqXG4gKiBUaGUgQ0ktZml4IGFuZCBQUi1mZWVkYmFjayBsYW5lcyBwb3N0IHRoZSBhZ2VudCdzIG93biBgLnByX3Jlc3BvbnNlX21lc3NhZ2VgXG4gKiB2ZXJiYXRpbSBpbnRvIGEgY29tbWVudCB0aGUgKipmbGVldCBhY2NvdW50KiogYXV0aG9ycywgYW5kIHRob3NlXG4gKiBmbGVldC1hdXRob3JlZCBib2RpZXMgYXJlIHRoZSBmbGVldC13aWRlIHJlY29yZCBvZiBDSS1maXggYXR0ZW1wdHMgYW5kXG4gKiBkZWZlcnJhbHMgKElzc3VlICMxODc5KS4gVGhhdCByZWNvcmQgaXMgZ2F0ZWQgb24gdGhlICpjb21tZW50J3MqIGF1dGhvciwgc29cbiAqIGEgYDwhLS0gdmliZS1jaS1maXgtYXR0ZW1wdCDigKYgLS0+YCBvciBgPCEtLSB2aWJlLWNpLWZpeC1kZWZlcnJlZCDigKYgLS0+YFxuICogbWFya2VyIHNtdWdnbGVkIGludG8gdGhlIGFnZW50J3MgbWVzc2FnZSB3b3VsZCBiZSBwb3N0ZWQgYnkgdGhlIGZsZWV0IGFuZFxuICogcmVhZCBiYWNrIGFzIHRoZSBmbGVldCdzIG93biBjbGFpbTogYSBmb3JnZWQgZGVmZXJyYWwgcGFya3MgYSByZWQgcHVsbFxuICogcmVxdWVzdCBmb3IgZ29vZCwgYW5kIGZvcmdlZCBhdHRlbXB0cyBleGhhdXN0IHRoZSBzaGFyZWQgYXR0ZW1wdCBidWRnZXQuXG4gKlxuICogVGhlIGFnZW50J3MgbWVzc2FnZSBjb25kZW5zZXMgdGhlIGZhaWxpbmcgY2hlY2sncyBhbm5vdGF0aW9ucywgdGhlIGZldGNoZWRcbiAqIEFjdGlvbnMgbG9nIGFuZCB0aGUgYnJhbmNoJ3Mgb3duIGZpbGVzIOKAlCBhbGwgYXR0YWNrZXItaW5mbHVlbmNlZCBvbiBhXG4gKiBtb25pdG9yZWQgcmVwb3NpdG9yeSDigJQgc28gaXQgaXMgdW50cnVzdGVkIHRleHQgaW5zaWRlIGEgdHJ1c3RlZCBjb250YWluZXIuXG4gKlxuICogVHdvIHByb3BlcnRpZXMgdGhpcyBtb2R1bGUgZXhpc3RzIHRvIGhvbGQ6XG4gKlxuICogLSAqKk5ldXRyYWxpc2UgYnkgY29uc3RydWN0aW9uLCBuZXZlciBieSBuYW1lLioqIEV2ZXJ5IEhUTUwtY29tbWVudFxuICogICBkZWxpbWl0ZXIgaXMgbWFkZSBpbmVydCwgc28gbm8gbWFya2VyIG9mIGFueSBuYW1lIOKAlCBpbmNsdWRpbmcgb25lIGFkZGVkXG4gKiAgIHllYXJzIGZyb20gbm93IOKAlCBjYW4gYmUgb3BlbmVkIG9yIGNsb3NlZCBieSBhZ2VudCB0ZXh0LiBBIGZpbHRlciBuYW1pbmdcbiAqICAgdGhlIG1hcmtlcnMgaXQga25vd3MgaXMgYSBiYWQtdGFnLWZpbHRlciwgYW5kIHRoZSBuZXh0IG1hcmtlciBuYW1lXG4gKiAgIHNpbGVudGx5IHJlb3BlbnMgdGhlIGhvbGUuXG4gKiAtICoqRmFpbCBsb3VkLioqIE1hcmtlciBzeW50YXggaW4gYWdlbnQgdGV4dCBpcyBhIHByb21wdC1pbmplY3Rpb24gYXR0ZW1wdCxcbiAqICAgbm90IGEgZm9ybWF0dGluZyBxdWlyay4ge0BsaW5rIG5ldXRyYWxpc2VBZ2VudE1hcmtlcnN9IHJlcG9ydHMgd2hhdCBpdFxuICogICBkZWZ1c2VkIHNvIHRoZSBjYWxsZXIgY2FuIGxvZyBpdCByYXRoZXIgdGhhbiBzd2FsbG93IGl0LlxuICpcbiAqIFRoZSBuZXV0cmFsaXNhdGlvbiBydW5zIG9uIHRoZSB1bnRydXN0ZWQgdGV4dCBhbG9uZS4gVGhlIHdvcmtlcidzIG93biBtYXJrZXJcbiAqIGlzIGNvbmNhdGVuYXRlZCBhZnRlcndhcmRzIGFuZCBpcyB1bnRvdWNoZWQsIHNvICMxODc5J3MgZmxlZXQtd2lkZSB0YWxseVxuICogc3RpbGwgcGFyc2VzIGV4YWN0bHkgYXMgYmVmb3JlLlxuICpcbiAqIFRoZSBhZ2VudCdzIG1lc3NhZ2UgaXMgbm90IHRoZSBvbmx5IHVudHJ1c3RlZCB2YWx1ZSB0aG9zZSBib2RpZXMgY2Fycnk6IHRoZVxuICogZmFpbGluZyBjaGVjaydzIG5hbWUgaXMgZm9yay1jaG9zZW4gb24gYSBgcHVsbF9yZXF1ZXN0YC10cmlnZ2VyZWQgd29ya2Zsb3dcbiAqICh0aGUgam9iIG5hbWUgY29tZXMgZnJvbSB0aGUgaGVhZCByZWYpLCBhbmQgdGhlIENJLWZpeCByZXBsaWVzIGludGVycG9sYXRlXG4gKiBpdCBpbnRvIHRoZSBzYW1lIGZsZWV0LWF1dGhvcmVkIHByb3NlLiBJdCBydW5zIHRocm91Z2ggdGhpcyBzYW1lIGhlbHBlclxuICogKElzc3VlICMyMjYwKSDigJQgdGhlIHByb3BlcnRpZXMgYWJvdmUgYXJlIHdoeSBvbmUgaGVscGVyIHNlcnZlcyBib3RoLlxuICpcbiAqIFVzZXMgQXVzdHJhbGlhbiBFbmdsaXNoIHRocm91Z2hvdXQgKGJlaGF2aW91ciwgY29sb3VyLCBvcmdhbmlzYXRpb24pLlxuICovXG5cbi8qKiBNb3N0IG1hcmtlci1saWtlIG5hbWVzIGNhcnJpZWQgaW4gdGhlIHJlcG9ydDsgdGhlIHJlc3QgYXJlIGNvdW50ZWQgb25seS4gKi9cbmNvbnN0IE1BWF9SRVBPUlRFRF9OQU1FUyA9IDU7XG5cbi8qKiBMb25nZXN0IG5hbWUgcmVwb3J0ZWQsIHNvIGEgbG9nIGxpbmUgY2Fubm90IGJlIGZsb29kZWQuICovXG5jb25zdCBNQVhfTkFNRV9MRU5HVEggPSA2NDtcblxuLyoqIE9wZW5pbmcgZGVsaW1pdGVyIG9mIGFuIEhUTUwgY29tbWVudCDigJQgaG93IGV2ZXJ5IG1hcmtlciBzdGFydHMuICovXG5jb25zdCBDT01NRU5UX09QRU4gPSAvPCEtLS9nO1xuXG4vKipcbiAqIENsb3NpbmcgZGVsaW1pdGVyIOKAlCBob3cgZXZlcnkgbWFya2VyIGVuZHMuXG4gKlxuICogSFRNTCBwYXJzZXJzIGFsc28gY2xvc2UgYSBjb21tZW50IG9uIGAtLSE+YCwgc28gYSBmaWx0ZXIgdGhhdCBtYXRjaGVzIG9ubHlcbiAqIGAtLT5gIGxlYXZlcyBhIHdvcmtpbmcgY2xvc2VyIGJlaGluZCAoQ29kZVFMIGpzL2JhZC10YWctZmlsdGVyKS5cbiAqL1xuY29uc3QgQ09NTUVOVF9DTE9TRSA9IC8tLSE/Pi9nO1xuXG4vKipcbiAqIFRoZSBuYW1lIGRpcmVjdGx5IGFmdGVyIGFuIG9wZW5pbmcgZGVsaW1pdGVyLlxuICpcbiAqIFVzZWQgKipvbmx5KiogdG8gZGVzY3JpYmUgd2hhdCB3YXMgZGVmdXNlZCBpbiB0aGUgd2FybmluZzsgdGhlXG4gKiBuZXV0cmFsaXNhdGlvbiBpdHNlbGYgbmV2ZXIgY29uc3VsdHMgaXQuXG4gKi9cbmNvbnN0IE1BUktFUl9OQU1FX1JFID0gLzwhLS1cXHMqKFtBLVphLXpdW0EtWmEtejAtOV86Li1dKikvZztcblxuLyoqIFdoYXQge0BsaW5rIG5ldXRyYWxpc2VBZ2VudE1hcmtlcnN9IGRlZnVzZWQuICovXG5leHBvcnQgaW50ZXJmYWNlIEFnZW50TWFya2VyTmV1dHJhbGlzYXRpb24ge1xuICAvKiogVGhlIHRleHQgd2l0aCBldmVyeSBIVE1MLWNvbW1lbnQgZGVsaW1pdGVyIG1hZGUgaW5lcnQuICovXG4gIHRleHQ6IHN0cmluZztcbiAgLyoqIEhvdyBtYW55IGRlbGltaXRlcnMgd2VyZSBuZXV0cmFsaXNlZDsgYDBgIG1lYW5zIHRoZSB0ZXh0IGlzIHVuY2hhbmdlZC4gKi9cbiAgbmV1dHJhbGlzZWQ6IG51bWJlcjtcbiAgLyoqIE1hcmtlci1saWtlIG5hbWVzIHNlZW4sIGZvciB0aGUgd2FybmluZyDigJQgbmV2ZXIgdXNlZCBhcyBhIGZpbHRlci4gKi9cbiAgbmFtZXM6IHN0cmluZ1tdO1xufVxuXG4vKipcbiAqIE1ha2UgZXZlcnkgSFRNTC1jb21tZW50IGRlbGltaXRlciBpbiBhZ2VudC1hdXRob3JlZCB0ZXh0IGluZXJ0LlxuICpcbiAqIEEgc3BhY2UgaXMga2VwdCBpbnNpZGUgZWFjaCBuZXV0cmFsaXNlZCB0b2tlbiAoYDwhLSAtYCwgYC0gLT5gKSBzbyBhIGxvbmdlclxuICogcnVuIG9mIGRhc2hlcyBjYW5ub3QgcmUtZm9ybSB0aGUgZGVsaW1pdGVyLCBhbmQgdGhlIHRleHQgc3RheXMgcmVhZGFibGU6XG4gKiB0aGUgaW5qZWN0ZWQgbWFya2VyIGlzIHZpc2libGUgaW4gdGhlIHBvc3RlZCBjb21tZW50IHJhdGhlciB0aGFuIHNpbGVudGx5XG4gKiBkZWxldGVkLCB3aGljaCBpcyB3aGF0IG1ha2VzIGFuIGF0dGVtcHQgZXZpZGVudCB0byBhIHJldmlld2VyLlxuICpcbiAqIEBwYXJhbSB0ZXh0IC0gVGhlIGFnZW50J3Mgb3duIG1lc3NhZ2UuXG4gKiBAcmV0dXJucyBUaGUgaW5lcnQgdGV4dCwgcGx1cyB3aGF0IHdhcyBkZWZ1c2VkLlxuICovXG5leHBvcnQgZnVuY3Rpb24gbmV1dHJhbGlzZUFnZW50TWFya2VycyhcbiAgdGV4dDogc3RyaW5nLFxuKTogQWdlbnRNYXJrZXJOZXV0cmFsaXNhdGlvbiB7XG4gIGNvbnN0IG9wZW5zID0gdGV4dC5tYXRjaChDT01NRU5UX09QRU4pPy5sZW5ndGggPz8gMDtcbiAgY29uc3QgY2xvc2VzID0gdGV4dC5tYXRjaChDT01NRU5UX0NMT1NFKT8ubGVuZ3RoID8/IDA7XG4gIGlmIChvcGVucyA9PT0gMCAmJiBjbG9zZXMgPT09IDApIHtcbiAgICByZXR1cm4geyB0ZXh0LCBuZXV0cmFsaXNlZDogMCwgbmFtZXM6IFtdIH07XG4gIH1cblxuICBjb25zdCBuYW1lczogc3RyaW5nW10gPSBbXTtcbiAgZm9yIChjb25zdCBtYXRjaCBvZiB0ZXh0Lm1hdGNoQWxsKE1BUktFUl9OQU1FX1JFKSkge1xuICAgIGNvbnN0IG5hbWUgPSAobWF0Y2hbMV0gPz8gXCJcIikuc2xpY2UoMCwgTUFYX05BTUVfTEVOR1RIKTtcbiAgICBpZiAobmFtZS5sZW5ndGggPT09IDAgfHwgbmFtZXMuaW5jbHVkZXMobmFtZSkpIGNvbnRpbnVlO1xuICAgIGlmIChuYW1lcy5sZW5ndGggPj0gTUFYX1JFUE9SVEVEX05BTUVTKSBicmVhaztcbiAgICBuYW1lcy5wdXNoKG5hbWUpO1xuICB9XG5cbiAgcmV0dXJuIHtcbiAgICB0ZXh0OiBuZXV0cmFsaXNlQ29tbWVudERlbGltaXRlcnModGV4dCksXG4gICAgbmV1dHJhbGlzZWQ6IG9wZW5zICsgY2xvc2VzLFxuICAgIG5hbWVzLFxuICB9O1xufVxuXG4vKipcbiAqIE1ha2UgZXZlcnkgSFRNTC1jb21tZW50IG9wZW5lciBhbmQgY2xvc2VyIGluIGB0ZXh0YCBpbmVydC5cbiAqXG4gKiBUaGUgb25lIGNvcHkgb2YgdGhlIHJlcGxhY2VtZW50IGV2ZXJ5IGJvZHkgd3JpdGVyIHVzZXMgYmVmb3JlIGl0IGZlbmNlcyBvclxuICogZmlsZXMgdW50cnVzdGVkIG91dHB1dCwgc28gYSBjbG9zZXIgZm9ybSBhZGRlZCBoZXJlIGlzIGFkZGVkIGV2ZXJ5d2hlcmUuXG4gKiBBIHNwYWNlIGlzIGtlcHQgaW5zaWRlIGVhY2ggdG9rZW4gKGA8IS0gLWAsIGAtIC0+YCkgc28gYSBsb25nZXIgZGFzaCBydW5cbiAqIGNhbm5vdCByZS1mb3JtIHRoZSBkZWxpbWl0ZXIgZnJvbSB0aGUgc3Vydml2aW5nIGNoYXJhY3RlcnMuXG4gKlxuICogQHBhcmFtIHRleHQgLSBVbnRydXN0ZWQgdGV4dCBib3VuZCBmb3IgYW4gaXNzdWUgb3IgY29tbWVudCBib2R5XG4gKiBAcmV0dXJucyBUaGUgdGV4dCB3aXRoIG5vIGNvbW1lbnQgZGVsaW1pdGVyIGxlZnQgaW4gaXRcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIG5ldXRyYWxpc2VDb21tZW50RGVsaW1pdGVycyh0ZXh0OiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gdGV4dC5yZXBsYWNlKENPTU1FTlRfQ0xPU0UsIFwiLSAtPlwiKS5yZXBsYWNlKENPTU1FTlRfT1BFTiwgXCI8IS0gLVwiKTtcbn1cbiJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Q0FzQ0MsR0FFRCw2RUFBNkUsR0FDN0UsTUFBTSxxQkFBcUI7QUFFM0IsNERBQTRELEdBQzVELE1BQU0sa0JBQWtCO0FBRXhCLG9FQUFvRSxHQUNwRSxNQUFNLGVBQWU7QUFFckI7Ozs7O0NBS0MsR0FDRCxNQUFNLGdCQUFnQjtBQUV0Qjs7Ozs7Q0FLQyxHQUNELE1BQU0saUJBQWlCO0FBWXZCOzs7Ozs7Ozs7O0NBVUMsR0FDRCxPQUFPLFNBQVMsdUJBQ2QsSUFBWTtFQUVaLE1BQU0sUUFBUSxLQUFLLEtBQUssQ0FBQyxlQUFlLFVBQVU7RUFDbEQsTUFBTSxTQUFTLEtBQUssS0FBSyxDQUFDLGdCQUFnQixVQUFVO0VBQ3BELElBQUksVUFBVSxLQUFLLFdBQVcsR0FBRztJQUMvQixPQUFPO01BQUU7TUFBTSxhQUFhO01BQUcsT0FBTyxFQUFFO0lBQUM7RUFDM0M7RUFFQSxNQUFNLFFBQWtCLEVBQUU7RUFDMUIsS0FBSyxNQUFNLFNBQVMsS0FBSyxRQUFRLENBQUMsZ0JBQWlCO0lBQ2pELE1BQU0sT0FBTyxDQUFDLEtBQUssQ0FBQyxFQUFFLElBQUksRUFBRSxFQUFFLEtBQUssQ0FBQyxHQUFHO0lBQ3ZDLElBQUksS0FBSyxNQUFNLEtBQUssS0FBSyxNQUFNLFFBQVEsQ0FBQyxPQUFPO0lBQy9DLElBQUksTUFBTSxNQUFNLElBQUksb0JBQW9CO0lBQ3hDLE1BQU0sSUFBSSxDQUFDO0VBQ2I7RUFFQSxPQUFPO0lBQ0wsTUFBTSw0QkFBNEI7SUFDbEMsYUFBYSxRQUFRO0lBQ3JCO0VBQ0Y7QUFDRjtBQUVBOzs7Ozs7Ozs7O0NBVUMsR0FDRCxPQUFPLFNBQVMsNEJBQTRCLElBQVk7RUFDdEQsT0FBTyxLQUFLLE9BQU8sQ0FBQyxlQUFlLFFBQVEsT0FBTyxDQUFDLGNBQWM7QUFDbkUifQ==
// denoCacheMetadata=18134166717684994310,11841454626528020555