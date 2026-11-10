/**
 * Process-wide secret redaction for direct `console.*` output (Issue #3661,
 * SEC-f684a9d954ff).
 *
 * `createLogger` wraps its sink in `redactSecrets` and its docstring claims
 * masking happens "regardless of which caller produced the string". That
 * invariant did not hold: roughly a hundred direct `console.log/warn/error`
 * calls across `worker/deno/lib/` write to the same stderr — captured into
 * `worker-*.log` — without passing through the logger. Several of them
 * interpolate raw subprocess error text (`quality_gate.ts`,
 * `repo_failure_tracker.ts`, `shared_cooldown.ts`), which is exactly the
 * shape that carries a tokenised clone URL or an `export FOO_TOKEN=…` line.
 *
 * Rather than rewrite every call site — a churn-heavy change that the next
 * new `console.log` would immediately undo — install the redaction at the
 * real chokepoint: the console itself. One call at process start makes the
 * guarantee structural, so a future direct `console.error` is covered by
 * construction.
 *
 * Redaction is conservative (specific secret shapes only), so ordinary log
 * text is untouched; see `secret_redaction.ts`.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */ import { redactSecrets } from "./secret_redaction.ts";
/** Console methods that write to stdout/stderr and so may leak a secret. */ const PATCHED_METHODS = [
  "log",
  "info",
  "warn",
  "error",
  "debug",
  "trace"
];
/** Original methods, kept so {@link restoreConsole} can undo the patch. */ let originals = {};
/**
 * Deepest `cause` chain redacted. A cap rather than a cycle set: `cause` is
 * self-referential in the wild (a rethrow that reuses the same error), and a
 * fixed depth terminates on that without tracking identity.
 */ const MAX_CAUSE_DEPTH = 4;
/**
 * A redacted copy of `error` — the original is never mutated, because the
 * caller usually still needs the unmasked value for control flow.
 *
 * `message` and `stack` are both masked: the stack normally repeats the
 * message, so masking either alone still leaks. Own properties and the
 * prototype are carried over so a subclass keeps its identity and the
 * inspector renders the same shape.
 *
 * @param error - The error to copy.
 * @param depth - Current `cause` recursion depth.
 * @returns A copy with secret shapes masked.
 */ function redactError(error, depth = 0) {
  const copy = Object.create(Object.getPrototypeOf(error));
  for (const key of Object.getOwnPropertyNames(error)){
    const descriptor = Object.getOwnPropertyDescriptor(error, key);
    if (descriptor) Object.defineProperty(copy, key, descriptor);
  }
  const redactedText = (value)=>typeof value === "string" ? redactSecrets(value) : undefined;
  for (const key of [
    "message",
    "stack"
  ]){
    const masked = redactedText(error[key]);
    if (masked !== undefined) {
      Object.defineProperty(copy, key, {
        value: masked,
        writable: true,
        enumerable: false,
        configurable: true
      });
    }
  }
  const cause = error.cause;
  const maskedCause = cause instanceof Error ? depth < MAX_CAUSE_DEPTH ? redactError(cause, depth + 1) : undefined : redactedText(cause);
  if (maskedCause !== undefined) {
    Object.defineProperty(copy, "cause", {
      value: maskedCause,
      writable: true,
      enumerable: false,
      configurable: true
    });
  }
  return copy;
}
/**
 * Mask one `console.*` argument: strings and errors are redacted, every other
 * value passes through so structured output is preserved.
 *
 * @param arg - The argument as the caller passed it.
 * @returns The argument, redacted when it carries text.
 */ function redactArgument(arg) {
  if (typeof arg === "string") return redactSecrets(arg);
  if (arg instanceof Error) return redactError(arg);
  return arg;
}
/**
 * Route every `console.*` string argument — and every `Error` — through
 * `redactSecrets`.
 *
 * Idempotent: calling it twice does not double-wrap. Non-`Error` objects are
 * passed through untouched so `console.log(obj)` keeps its structured
 * formatting; an `Error` is rendered as text by the inspector anyway, so
 * masking its message and stack loses nothing (Issue #1260).
 *
 * @returns true when the patch was installed, false when already active.
 */ export function installConsoleRedaction() {
  if (Object.keys(originals).length > 0) return false;
  const target = globalThis.console;
  const captured = {};
  for (const method of PATCHED_METHODS){
    const original = target[method];
    if (typeof original !== "function") continue;
    captured[method] = original;
    target[method] = (...args)=>{
      original.apply(globalThis.console, args.map(redactArgument));
    };
  }
  originals = captured;
  return true;
}
/**
 * Restore the unpatched console methods.
 *
 * Exists for tests — production installs the patch once and leaves it.
 *
 * @returns true when a patch was removed, false when none was active.
 */ export function restoreConsole() {
  if (Object.keys(originals).length === 0) return false;
  const target = globalThis.console;
  for (const [method, original] of Object.entries(originals)){
    target[method] = original;
  }
  originals = {};
  return true;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9jb25zb2xlX3JlZGFjdGlvbi50cyJdLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIFByb2Nlc3Mtd2lkZSBzZWNyZXQgcmVkYWN0aW9uIGZvciBkaXJlY3QgYGNvbnNvbGUuKmAgb3V0cHV0IChJc3N1ZSAjMzY2MSxcbiAqIFNFQy1mNjg0YTlkOTU0ZmYpLlxuICpcbiAqIGBjcmVhdGVMb2dnZXJgIHdyYXBzIGl0cyBzaW5rIGluIGByZWRhY3RTZWNyZXRzYCBhbmQgaXRzIGRvY3N0cmluZyBjbGFpbXNcbiAqIG1hc2tpbmcgaGFwcGVucyBcInJlZ2FyZGxlc3Mgb2Ygd2hpY2ggY2FsbGVyIHByb2R1Y2VkIHRoZSBzdHJpbmdcIi4gVGhhdFxuICogaW52YXJpYW50IGRpZCBub3QgaG9sZDogcm91Z2hseSBhIGh1bmRyZWQgZGlyZWN0IGBjb25zb2xlLmxvZy93YXJuL2Vycm9yYFxuICogY2FsbHMgYWNyb3NzIGB3b3JrZXIvZGVuby9saWIvYCB3cml0ZSB0byB0aGUgc2FtZSBzdGRlcnIg4oCUIGNhcHR1cmVkIGludG9cbiAqIGB3b3JrZXItKi5sb2dgIOKAlCB3aXRob3V0IHBhc3NpbmcgdGhyb3VnaCB0aGUgbG9nZ2VyLiBTZXZlcmFsIG9mIHRoZW1cbiAqIGludGVycG9sYXRlIHJhdyBzdWJwcm9jZXNzIGVycm9yIHRleHQgKGBxdWFsaXR5X2dhdGUudHNgLFxuICogYHJlcG9fZmFpbHVyZV90cmFja2VyLnRzYCwgYHNoYXJlZF9jb29sZG93bi50c2ApLCB3aGljaCBpcyBleGFjdGx5IHRoZVxuICogc2hhcGUgdGhhdCBjYXJyaWVzIGEgdG9rZW5pc2VkIGNsb25lIFVSTCBvciBhbiBgZXhwb3J0IEZPT19UT0tFTj3igKZgIGxpbmUuXG4gKlxuICogUmF0aGVyIHRoYW4gcmV3cml0ZSBldmVyeSBjYWxsIHNpdGUg4oCUIGEgY2h1cm4taGVhdnkgY2hhbmdlIHRoYXQgdGhlIG5leHRcbiAqIG5ldyBgY29uc29sZS5sb2dgIHdvdWxkIGltbWVkaWF0ZWx5IHVuZG8g4oCUIGluc3RhbGwgdGhlIHJlZGFjdGlvbiBhdCB0aGVcbiAqIHJlYWwgY2hva2Vwb2ludDogdGhlIGNvbnNvbGUgaXRzZWxmLiBPbmUgY2FsbCBhdCBwcm9jZXNzIHN0YXJ0IG1ha2VzIHRoZVxuICogZ3VhcmFudGVlIHN0cnVjdHVyYWwsIHNvIGEgZnV0dXJlIGRpcmVjdCBgY29uc29sZS5lcnJvcmAgaXMgY292ZXJlZCBieVxuICogY29uc3RydWN0aW9uLlxuICpcbiAqIFJlZGFjdGlvbiBpcyBjb25zZXJ2YXRpdmUgKHNwZWNpZmljIHNlY3JldCBzaGFwZXMgb25seSksIHNvIG9yZGluYXJ5IGxvZ1xuICogdGV4dCBpcyB1bnRvdWNoZWQ7IHNlZSBgc2VjcmV0X3JlZGFjdGlvbi50c2AuXG4gKlxuICogVXNlcyBBdXN0cmFsaWFuIEVuZ2xpc2ggdGhyb3VnaG91dCAoYmVoYXZpb3VyLCBjb2xvdXIsIG9yZ2FuaXNhdGlvbiwgZXRjLikuXG4gKi9cblxuaW1wb3J0IHsgcmVkYWN0U2VjcmV0cyB9IGZyb20gXCIuL3NlY3JldF9yZWRhY3Rpb24udHNcIjtcblxuLyoqIENvbnNvbGUgbWV0aG9kcyB0aGF0IHdyaXRlIHRvIHN0ZG91dC9zdGRlcnIgYW5kIHNvIG1heSBsZWFrIGEgc2VjcmV0LiAqL1xuY29uc3QgUEFUQ0hFRF9NRVRIT0RTID0gW1xuICBcImxvZ1wiLFxuICBcImluZm9cIixcbiAgXCJ3YXJuXCIsXG4gIFwiZXJyb3JcIixcbiAgXCJkZWJ1Z1wiLFxuICBcInRyYWNlXCIsXG5dIGFzIGNvbnN0O1xuXG50eXBlIFBhdGNoZWRNZXRob2QgPSB0eXBlb2YgUEFUQ0hFRF9NRVRIT0RTW251bWJlcl07XG5cbi8qKiBPcmlnaW5hbCBtZXRob2RzLCBrZXB0IHNvIHtAbGluayByZXN0b3JlQ29uc29sZX0gY2FuIHVuZG8gdGhlIHBhdGNoLiAqL1xubGV0IG9yaWdpbmFsczogUGFydGlhbDxSZWNvcmQ8UGF0Y2hlZE1ldGhvZCwgKC4uLmFyZ3M6IHVua25vd25bXSkgPT4gdm9pZD4+ID1cbiAge307XG5cbi8qKlxuICogRGVlcGVzdCBgY2F1c2VgIGNoYWluIHJlZGFjdGVkLiBBIGNhcCByYXRoZXIgdGhhbiBhIGN5Y2xlIHNldDogYGNhdXNlYCBpc1xuICogc2VsZi1yZWZlcmVudGlhbCBpbiB0aGUgd2lsZCAoYSByZXRocm93IHRoYXQgcmV1c2VzIHRoZSBzYW1lIGVycm9yKSwgYW5kIGFcbiAqIGZpeGVkIGRlcHRoIHRlcm1pbmF0ZXMgb24gdGhhdCB3aXRob3V0IHRyYWNraW5nIGlkZW50aXR5LlxuICovXG5jb25zdCBNQVhfQ0FVU0VfREVQVEggPSA0O1xuXG4vKipcbiAqIEEgcmVkYWN0ZWQgY29weSBvZiBgZXJyb3JgIOKAlCB0aGUgb3JpZ2luYWwgaXMgbmV2ZXIgbXV0YXRlZCwgYmVjYXVzZSB0aGVcbiAqIGNhbGxlciB1c3VhbGx5IHN0aWxsIG5lZWRzIHRoZSB1bm1hc2tlZCB2YWx1ZSBmb3IgY29udHJvbCBmbG93LlxuICpcbiAqIGBtZXNzYWdlYCBhbmQgYHN0YWNrYCBhcmUgYm90aCBtYXNrZWQ6IHRoZSBzdGFjayBub3JtYWxseSByZXBlYXRzIHRoZVxuICogbWVzc2FnZSwgc28gbWFza2luZyBlaXRoZXIgYWxvbmUgc3RpbGwgbGVha3MuIE93biBwcm9wZXJ0aWVzIGFuZCB0aGVcbiAqIHByb3RvdHlwZSBhcmUgY2FycmllZCBvdmVyIHNvIGEgc3ViY2xhc3Mga2VlcHMgaXRzIGlkZW50aXR5IGFuZCB0aGVcbiAqIGluc3BlY3RvciByZW5kZXJzIHRoZSBzYW1lIHNoYXBlLlxuICpcbiAqIEBwYXJhbSBlcnJvciAtIFRoZSBlcnJvciB0byBjb3B5LlxuICogQHBhcmFtIGRlcHRoIC0gQ3VycmVudCBgY2F1c2VgIHJlY3Vyc2lvbiBkZXB0aC5cbiAqIEByZXR1cm5zIEEgY29weSB3aXRoIHNlY3JldCBzaGFwZXMgbWFza2VkLlxuICovXG5mdW5jdGlvbiByZWRhY3RFcnJvcihlcnJvcjogRXJyb3IsIGRlcHRoID0gMCk6IEVycm9yIHtcbiAgY29uc3QgY29weSA9IE9iamVjdC5jcmVhdGUoT2JqZWN0LmdldFByb3RvdHlwZU9mKGVycm9yKSkgYXMgRXJyb3I7XG4gIGZvciAoY29uc3Qga2V5IG9mIE9iamVjdC5nZXRPd25Qcm9wZXJ0eU5hbWVzKGVycm9yKSkge1xuICAgIGNvbnN0IGRlc2NyaXB0b3IgPSBPYmplY3QuZ2V0T3duUHJvcGVydHlEZXNjcmlwdG9yKGVycm9yLCBrZXkpO1xuICAgIGlmIChkZXNjcmlwdG9yKSBPYmplY3QuZGVmaW5lUHJvcGVydHkoY29weSwga2V5LCBkZXNjcmlwdG9yKTtcbiAgfVxuXG4gIGNvbnN0IHJlZGFjdGVkVGV4dCA9ICh2YWx1ZTogdW5rbm93bik6IHN0cmluZyB8IHVuZGVmaW5lZCA9PlxuICAgIHR5cGVvZiB2YWx1ZSA9PT0gXCJzdHJpbmdcIiA/IHJlZGFjdFNlY3JldHModmFsdWUpIDogdW5kZWZpbmVkO1xuXG4gIGZvciAoY29uc3Qga2V5IG9mIFtcIm1lc3NhZ2VcIiwgXCJzdGFja1wiXSBhcyBjb25zdCkge1xuICAgIGNvbnN0IG1hc2tlZCA9IHJlZGFjdGVkVGV4dChlcnJvcltrZXldKTtcbiAgICBpZiAobWFza2VkICE9PSB1bmRlZmluZWQpIHtcbiAgICAgIE9iamVjdC5kZWZpbmVQcm9wZXJ0eShjb3B5LCBrZXksIHtcbiAgICAgICAgdmFsdWU6IG1hc2tlZCxcbiAgICAgICAgd3JpdGFibGU6IHRydWUsXG4gICAgICAgIGVudW1lcmFibGU6IGZhbHNlLFxuICAgICAgICBjb25maWd1cmFibGU6IHRydWUsXG4gICAgICB9KTtcbiAgICB9XG4gIH1cblxuICBjb25zdCBjYXVzZSA9IChlcnJvciBhcyB7IGNhdXNlPzogdW5rbm93biB9KS5jYXVzZTtcbiAgY29uc3QgbWFza2VkQ2F1c2UgPSBjYXVzZSBpbnN0YW5jZW9mIEVycm9yXG4gICAgPyAoZGVwdGggPCBNQVhfQ0FVU0VfREVQVEggPyByZWRhY3RFcnJvcihjYXVzZSwgZGVwdGggKyAxKSA6IHVuZGVmaW5lZClcbiAgICA6IHJlZGFjdGVkVGV4dChjYXVzZSk7XG4gIGlmIChtYXNrZWRDYXVzZSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgT2JqZWN0LmRlZmluZVByb3BlcnR5KGNvcHksIFwiY2F1c2VcIiwge1xuICAgICAgdmFsdWU6IG1hc2tlZENhdXNlLFxuICAgICAgd3JpdGFibGU6IHRydWUsXG4gICAgICBlbnVtZXJhYmxlOiBmYWxzZSxcbiAgICAgIGNvbmZpZ3VyYWJsZTogdHJ1ZSxcbiAgICB9KTtcbiAgfVxuXG4gIHJldHVybiBjb3B5O1xufVxuXG4vKipcbiAqIE1hc2sgb25lIGBjb25zb2xlLipgIGFyZ3VtZW50OiBzdHJpbmdzIGFuZCBlcnJvcnMgYXJlIHJlZGFjdGVkLCBldmVyeSBvdGhlclxuICogdmFsdWUgcGFzc2VzIHRocm91Z2ggc28gc3RydWN0dXJlZCBvdXRwdXQgaXMgcHJlc2VydmVkLlxuICpcbiAqIEBwYXJhbSBhcmcgLSBUaGUgYXJndW1lbnQgYXMgdGhlIGNhbGxlciBwYXNzZWQgaXQuXG4gKiBAcmV0dXJucyBUaGUgYXJndW1lbnQsIHJlZGFjdGVkIHdoZW4gaXQgY2FycmllcyB0ZXh0LlxuICovXG5mdW5jdGlvbiByZWRhY3RBcmd1bWVudChhcmc6IHVua25vd24pOiB1bmtub3duIHtcbiAgaWYgKHR5cGVvZiBhcmcgPT09IFwic3RyaW5nXCIpIHJldHVybiByZWRhY3RTZWNyZXRzKGFyZyk7XG4gIGlmIChhcmcgaW5zdGFuY2VvZiBFcnJvcikgcmV0dXJuIHJlZGFjdEVycm9yKGFyZyk7XG4gIHJldHVybiBhcmc7XG59XG5cbi8qKlxuICogUm91dGUgZXZlcnkgYGNvbnNvbGUuKmAgc3RyaW5nIGFyZ3VtZW50IOKAlCBhbmQgZXZlcnkgYEVycm9yYCDigJQgdGhyb3VnaFxuICogYHJlZGFjdFNlY3JldHNgLlxuICpcbiAqIElkZW1wb3RlbnQ6IGNhbGxpbmcgaXQgdHdpY2UgZG9lcyBub3QgZG91YmxlLXdyYXAuIE5vbi1gRXJyb3JgIG9iamVjdHMgYXJlXG4gKiBwYXNzZWQgdGhyb3VnaCB1bnRvdWNoZWQgc28gYGNvbnNvbGUubG9nKG9iailgIGtlZXBzIGl0cyBzdHJ1Y3R1cmVkXG4gKiBmb3JtYXR0aW5nOyBhbiBgRXJyb3JgIGlzIHJlbmRlcmVkIGFzIHRleHQgYnkgdGhlIGluc3BlY3RvciBhbnl3YXksIHNvXG4gKiBtYXNraW5nIGl0cyBtZXNzYWdlIGFuZCBzdGFjayBsb3NlcyBub3RoaW5nIChJc3N1ZSAjMTI2MCkuXG4gKlxuICogQHJldHVybnMgdHJ1ZSB3aGVuIHRoZSBwYXRjaCB3YXMgaW5zdGFsbGVkLCBmYWxzZSB3aGVuIGFscmVhZHkgYWN0aXZlLlxuICovXG5leHBvcnQgZnVuY3Rpb24gaW5zdGFsbENvbnNvbGVSZWRhY3Rpb24oKTogYm9vbGVhbiB7XG4gIGlmIChPYmplY3Qua2V5cyhvcmlnaW5hbHMpLmxlbmd0aCA+IDApIHJldHVybiBmYWxzZTtcblxuICBjb25zdCB0YXJnZXQgPSBnbG9iYWxUaGlzLmNvbnNvbGUgYXMgdW5rbm93biBhcyBSZWNvcmQ8XG4gICAgc3RyaW5nLFxuICAgICguLi5hcmdzOiB1bmtub3duW10pID0+IHZvaWRcbiAgPjtcblxuICBjb25zdCBjYXB0dXJlZDogdHlwZW9mIG9yaWdpbmFscyA9IHt9O1xuICBmb3IgKGNvbnN0IG1ldGhvZCBvZiBQQVRDSEVEX01FVEhPRFMpIHtcbiAgICBjb25zdCBvcmlnaW5hbCA9IHRhcmdldFttZXRob2RdO1xuICAgIGlmICh0eXBlb2Ygb3JpZ2luYWwgIT09IFwiZnVuY3Rpb25cIikgY29udGludWU7XG4gICAgY2FwdHVyZWRbbWV0aG9kXSA9IG9yaWdpbmFsO1xuICAgIHRhcmdldFttZXRob2RdID0gKC4uLmFyZ3M6IHVua25vd25bXSk6IHZvaWQgPT4ge1xuICAgICAgb3JpZ2luYWwuYXBwbHkoXG4gICAgICAgIGdsb2JhbFRoaXMuY29uc29sZSxcbiAgICAgICAgYXJncy5tYXAocmVkYWN0QXJndW1lbnQpLFxuICAgICAgKTtcbiAgICB9O1xuICB9XG4gIG9yaWdpbmFscyA9IGNhcHR1cmVkO1xuICByZXR1cm4gdHJ1ZTtcbn1cblxuLyoqXG4gKiBSZXN0b3JlIHRoZSB1bnBhdGNoZWQgY29uc29sZSBtZXRob2RzLlxuICpcbiAqIEV4aXN0cyBmb3IgdGVzdHMg4oCUIHByb2R1Y3Rpb24gaW5zdGFsbHMgdGhlIHBhdGNoIG9uY2UgYW5kIGxlYXZlcyBpdC5cbiAqXG4gKiBAcmV0dXJucyB0cnVlIHdoZW4gYSBwYXRjaCB3YXMgcmVtb3ZlZCwgZmFsc2Ugd2hlbiBub25lIHdhcyBhY3RpdmUuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZXN0b3JlQ29uc29sZSgpOiBib29sZWFuIHtcbiAgaWYgKE9iamVjdC5rZXlzKG9yaWdpbmFscykubGVuZ3RoID09PSAwKSByZXR1cm4gZmFsc2U7XG5cbiAgY29uc3QgdGFyZ2V0ID0gZ2xvYmFsVGhpcy5jb25zb2xlIGFzIHVua25vd24gYXMgUmVjb3JkPFxuICAgIHN0cmluZyxcbiAgICAoLi4uYXJnczogdW5rbm93bltdKSA9PiB2b2lkXG4gID47XG4gIGZvciAoY29uc3QgW21ldGhvZCwgb3JpZ2luYWxdIG9mIE9iamVjdC5lbnRyaWVzKG9yaWdpbmFscykpIHtcbiAgICB0YXJnZXRbbWV0aG9kXSA9IG9yaWdpbmFsO1xuICB9XG4gIG9yaWdpbmFscyA9IHt9O1xuICByZXR1cm4gdHJ1ZTtcbn1cbiJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Q0F1QkMsR0FFRCxTQUFTLGFBQWEsUUFBUSx3QkFBd0I7QUFFdEQsMEVBQTBFLEdBQzFFLE1BQU0sa0JBQWtCO0VBQ3RCO0VBQ0E7RUFDQTtFQUNBO0VBQ0E7RUFDQTtDQUNEO0FBSUQseUVBQXlFLEdBQ3pFLElBQUksWUFDRixDQUFDO0FBRUg7Ozs7Q0FJQyxHQUNELE1BQU0sa0JBQWtCO0FBRXhCOzs7Ozs7Ozs7Ozs7Q0FZQyxHQUNELFNBQVMsWUFBWSxLQUFZLEVBQUUsUUFBUSxDQUFDO0VBQzFDLE1BQU0sT0FBTyxPQUFPLE1BQU0sQ0FBQyxPQUFPLGNBQWMsQ0FBQztFQUNqRCxLQUFLLE1BQU0sT0FBTyxPQUFPLG1CQUFtQixDQUFDLE9BQVE7SUFDbkQsTUFBTSxhQUFhLE9BQU8sd0JBQXdCLENBQUMsT0FBTztJQUMxRCxJQUFJLFlBQVksT0FBTyxjQUFjLENBQUMsTUFBTSxLQUFLO0VBQ25EO0VBRUEsTUFBTSxlQUFlLENBQUMsUUFDcEIsT0FBTyxVQUFVLFdBQVcsY0FBYyxTQUFTO0VBRXJELEtBQUssTUFBTSxPQUFPO0lBQUM7SUFBVztHQUFRLENBQVc7SUFDL0MsTUFBTSxTQUFTLGFBQWEsS0FBSyxDQUFDLElBQUk7SUFDdEMsSUFBSSxXQUFXLFdBQVc7TUFDeEIsT0FBTyxjQUFjLENBQUMsTUFBTSxLQUFLO1FBQy9CLE9BQU87UUFDUCxVQUFVO1FBQ1YsWUFBWTtRQUNaLGNBQWM7TUFDaEI7SUFDRjtFQUNGO0VBRUEsTUFBTSxRQUFRLEFBQUMsTUFBOEIsS0FBSztFQUNsRCxNQUFNLGNBQWMsaUJBQWlCLFFBQ2hDLFFBQVEsa0JBQWtCLFlBQVksT0FBTyxRQUFRLEtBQUssWUFDM0QsYUFBYTtFQUNqQixJQUFJLGdCQUFnQixXQUFXO0lBQzdCLE9BQU8sY0FBYyxDQUFDLE1BQU0sU0FBUztNQUNuQyxPQUFPO01BQ1AsVUFBVTtNQUNWLFlBQVk7TUFDWixjQUFjO0lBQ2hCO0VBQ0Y7RUFFQSxPQUFPO0FBQ1Q7QUFFQTs7Ozs7O0NBTUMsR0FDRCxTQUFTLGVBQWUsR0FBWTtFQUNsQyxJQUFJLE9BQU8sUUFBUSxVQUFVLE9BQU8sY0FBYztFQUNsRCxJQUFJLGVBQWUsT0FBTyxPQUFPLFlBQVk7RUFDN0MsT0FBTztBQUNUO0FBRUE7Ozs7Ozs7Ozs7Q0FVQyxHQUNELE9BQU8sU0FBUztFQUNkLElBQUksT0FBTyxJQUFJLENBQUMsV0FBVyxNQUFNLEdBQUcsR0FBRyxPQUFPO0VBRTlDLE1BQU0sU0FBUyxXQUFXLE9BQU87RUFLakMsTUFBTSxXQUE2QixDQUFDO0VBQ3BDLEtBQUssTUFBTSxVQUFVLGdCQUFpQjtJQUNwQyxNQUFNLFdBQVcsTUFBTSxDQUFDLE9BQU87SUFDL0IsSUFBSSxPQUFPLGFBQWEsWUFBWTtJQUNwQyxRQUFRLENBQUMsT0FBTyxHQUFHO0lBQ25CLE1BQU0sQ0FBQyxPQUFPLEdBQUcsQ0FBQyxHQUFHO01BQ25CLFNBQVMsS0FBSyxDQUNaLFdBQVcsT0FBTyxFQUNsQixLQUFLLEdBQUcsQ0FBQztJQUViO0VBQ0Y7RUFDQSxZQUFZO0VBQ1osT0FBTztBQUNUO0FBRUE7Ozs7OztDQU1DLEdBQ0QsT0FBTyxTQUFTO0VBQ2QsSUFBSSxPQUFPLElBQUksQ0FBQyxXQUFXLE1BQU0sS0FBSyxHQUFHLE9BQU87RUFFaEQsTUFBTSxTQUFTLFdBQVcsT0FBTztFQUlqQyxLQUFLLE1BQU0sQ0FBQyxRQUFRLFNBQVMsSUFBSSxPQUFPLE9BQU8sQ0FBQyxXQUFZO0lBQzFELE1BQU0sQ0FBQyxPQUFPLEdBQUc7RUFDbkI7RUFDQSxZQUFZLENBQUM7RUFDYixPQUFPO0FBQ1QifQ==
// denoCacheMetadata=10513717106123262061,17751830280859088564