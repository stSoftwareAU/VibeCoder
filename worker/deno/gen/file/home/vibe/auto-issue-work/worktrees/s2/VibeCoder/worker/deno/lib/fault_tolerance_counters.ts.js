/**
 * Structured fault tolerance event counters for observability (Issue #1168, #1173).
 *
 * Provides a centralised way to observe retry, backoff, circuit-breaker
 * activation, heartbeat failure, and timeout frequencies. Counters are
 * in-memory only (reset each worker cycle) and intended for diagnostic
 * logging at the end of a scan cycle.
 *
 * Issue #1173 adds the structured counter API (incrementCounter, getCounters,
 * resetCounters, writeSummary) and wires counters into all fault tolerance
 * source files.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */ import { redactSecrets } from "./secret_redaction.ts";
const faultEventCounters = new Map();
const namedCounters = new Map();
/**
 * Increment the counter for a fault tolerance event.
 *
 * Optionally logs a warning-level message for diagnostic purposes.
 *
 * Issue #3648: the diagnostic line goes to `console.warn`, which bypasses the
 * logger's redacting write path (`logger.ts`). Callers pass attacker- and
 * secret-adjacent text — `subprocess_timeout.ts` hands over a full interpolated
 * command line, which can carry a tokenised clone URL or a `--api-key` flag —
 * so the context is scrubbed here rather than relying on the sink.
 */ export function recordFaultEvent(event, context) {
  const current = faultEventCounters.get(event) ?? 0;
  faultEventCounters.set(event, current + 1);
  if (context) {
    console.warn(`[fault-tolerance] ${event}: ${redactSecrets(context)}`);
  }
}
/**
 * Get the current count for a specific event type.
 */ export function getFaultEventCount(event) {
  return faultEventCounters.get(event) ?? 0;
}
/**
 * Get a snapshot of all counters.
 */ export function getCounterSnapshot() {
  let total = 0;
  for (const count of faultEventCounters.values()){
    total += count;
  }
  return {
    counters: new Map(faultEventCounters),
    totalEvents: total
  };
}
/**
 * Reset all counters to zero. Call at the start of each scan cycle.
 */ export function resetFaultCounters() {
  faultEventCounters.clear();
}
/**
 * Format a summary of all non-zero counters for logging.
 *
 * Returns null if no events were recorded.
 */ export function formatCounterSummary() {
  const snapshot = getCounterSnapshot();
  if (snapshot.totalEvents === 0) return null;
  const lines = [
    "[fault-tolerance] Cycle summary:"
  ];
  for (const [event, count] of snapshot.counters){
    if (count > 0) {
      lines.push(`  ${event}: ${count}`);
    }
  }
  lines.push(`  total: ${snapshot.totalEvents}`);
  return lines.join("\n");
}
// ---------------------------------------------------------------------------
// Structured counter API (Issue #1173)
// ---------------------------------------------------------------------------
/**
 * Increment a named counter by one.
 *
 * Accepts any string name, allowing callers to use the issue-specified
 * counter names (retryAttempts, rateLimitBackoffs, etc.) directly.
 */ export function incrementCounter(name) {
  const current = namedCounters.get(name) ?? 0;
  namedCounters.set(name, current + 1);
}
/**
 * Get all non-zero named counters as a plain object.
 */ export function getCounters() {
  const result = {};
  for (const [name, count] of namedCounters){
    if (count > 0) {
      result[name] = count;
    }
  }
  return result;
}
/**
 * Reset all named counters to zero. Call at the start of each worker cycle.
 */ export function resetCounters() {
  namedCounters.clear();
}
/**
 * Write a JSON summary of all named counters to disk.
 *
 * Writes to `{workDir}/fault_tolerance_summary.json` with timestamp,
 * counters, and worker identity. This file is diagnostic only — it
 * does not affect worker behaviour.
 */ export async function writeSummary(workDir) {
  const counters = getCounters();
  let hostname = "unknown";
  try {
    hostname = Deno.hostname();
  } catch  {
  // hostname unavailable — use fallback
  }
  const summary = {
    timestamp: new Date().toISOString(),
    counters,
    workerIdentity: hostname
  };
  const path = `${workDir}/fault_tolerance_summary.json`;
  try {
    await Deno.writeTextFile(path, JSON.stringify(summary, null, 2));
    return {
      ok: true,
      value: undefined
    };
  } catch (err) {
    return {
      ok: false,
      error: new Error(`Failed to write fault tolerance summary to ${path}: ${err instanceof Error ? err.message : String(err)}`)
    };
  }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9mYXVsdF90b2xlcmFuY2VfY291bnRlcnMudHMiXSwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBTdHJ1Y3R1cmVkIGZhdWx0IHRvbGVyYW5jZSBldmVudCBjb3VudGVycyBmb3Igb2JzZXJ2YWJpbGl0eSAoSXNzdWUgIzExNjgsICMxMTczKS5cbiAqXG4gKiBQcm92aWRlcyBhIGNlbnRyYWxpc2VkIHdheSB0byBvYnNlcnZlIHJldHJ5LCBiYWNrb2ZmLCBjaXJjdWl0LWJyZWFrZXJcbiAqIGFjdGl2YXRpb24sIGhlYXJ0YmVhdCBmYWlsdXJlLCBhbmQgdGltZW91dCBmcmVxdWVuY2llcy4gQ291bnRlcnMgYXJlXG4gKiBpbi1tZW1vcnkgb25seSAocmVzZXQgZWFjaCB3b3JrZXIgY3ljbGUpIGFuZCBpbnRlbmRlZCBmb3IgZGlhZ25vc3RpY1xuICogbG9nZ2luZyBhdCB0aGUgZW5kIG9mIGEgc2NhbiBjeWNsZS5cbiAqXG4gKiBJc3N1ZSAjMTE3MyBhZGRzIHRoZSBzdHJ1Y3R1cmVkIGNvdW50ZXIgQVBJIChpbmNyZW1lbnRDb3VudGVyLCBnZXRDb3VudGVycyxcbiAqIHJlc2V0Q291bnRlcnMsIHdyaXRlU3VtbWFyeSkgYW5kIHdpcmVzIGNvdW50ZXJzIGludG8gYWxsIGZhdWx0IHRvbGVyYW5jZVxuICogc291cmNlIGZpbGVzLlxuICpcbiAqIFVzZXMgQXVzdHJhbGlhbiBFbmdsaXNoIHRocm91Z2hvdXQgKGJlaGF2aW91ciwgY29sb3VyLCBvcmdhbmlzYXRpb24sIGV0Yy4pLlxuICovXG5cbmltcG9ydCB0eXBlIHsgUmVzdWx0IH0gZnJvbSBcIi4uL3R5cGVzLnRzXCI7XG5pbXBvcnQgeyByZWRhY3RTZWNyZXRzIH0gZnJvbSBcIi4vc2VjcmV0X3JlZGFjdGlvbi50c1wiO1xuXG4vKiogQ2F0ZWdvcmllcyBvZiBmYXVsdCB0b2xlcmFuY2UgZXZlbnRzIHRoYXQgY2FuIGJlIGNvdW50ZWQuICovXG5leHBvcnQgdHlwZSBGYXVsdEV2ZW50ID1cbiAgfCBcImhlYXJ0YmVhdF9mYWlsdXJlXCJcbiAgfCBcImhlYXJ0YmVhdF9zdWNjZXNzXCJcbiAgfCBcImNpcmN1aXRfYnJlYWtlcl9vcGVuXCJcbiAgfCBcImNpcmN1aXRfYnJlYWtlcl9yZXNldFwiXG4gIHwgXCJyZXRyeV9hdHRlbXB0XCJcbiAgfCBcInJhdGVfbGltaXRfYmFja29mZlwiXG4gIHwgXCJ0aW1lb3V0XCJcbiAgfCBcImNyYXNoX3JlY292ZXJ5XCJcbiAgfCBcImNsYWltX2NvbmZsaWN0XCJcbiAgfCBcImRpc2tfc3BhY2VfY2xlYW51cFwiXG4gIHwgXCJjYXRjaF9ibG9ja193YXJuaW5nXCJcbiAgfCBcInByb21pc2Vfc2V0dGxlZF9yZWplY3Rpb25cIjtcblxuLyoqIFNuYXBzaG90IG9mIGFsbCBjb3VudGVycyBhdCBhIHBvaW50IGluIHRpbWUuICovXG5leHBvcnQgaW50ZXJmYWNlIENvdW50ZXJTbmFwc2hvdCB7XG4gIHJlYWRvbmx5IGNvdW50ZXJzOiBSZWFkb25seU1hcDxGYXVsdEV2ZW50LCBudW1iZXI+O1xuICByZWFkb25seSB0b3RhbEV2ZW50czogbnVtYmVyO1xufVxuXG5jb25zdCBmYXVsdEV2ZW50Q291bnRlcnMgPSBuZXcgTWFwPEZhdWx0RXZlbnQsIG51bWJlcj4oKTtcblxuY29uc3QgbmFtZWRDb3VudGVycyA9IG5ldyBNYXA8c3RyaW5nLCBudW1iZXI+KCk7XG5cbi8qKlxuICogSW5jcmVtZW50IHRoZSBjb3VudGVyIGZvciBhIGZhdWx0IHRvbGVyYW5jZSBldmVudC5cbiAqXG4gKiBPcHRpb25hbGx5IGxvZ3MgYSB3YXJuaW5nLWxldmVsIG1lc3NhZ2UgZm9yIGRpYWdub3N0aWMgcHVycG9zZXMuXG4gKlxuICogSXNzdWUgIzM2NDg6IHRoZSBkaWFnbm9zdGljIGxpbmUgZ29lcyB0byBgY29uc29sZS53YXJuYCwgd2hpY2ggYnlwYXNzZXMgdGhlXG4gKiBsb2dnZXIncyByZWRhY3Rpbmcgd3JpdGUgcGF0aCAoYGxvZ2dlci50c2ApLiBDYWxsZXJzIHBhc3MgYXR0YWNrZXItIGFuZFxuICogc2VjcmV0LWFkamFjZW50IHRleHQg4oCUIGBzdWJwcm9jZXNzX3RpbWVvdXQudHNgIGhhbmRzIG92ZXIgYSBmdWxsIGludGVycG9sYXRlZFxuICogY29tbWFuZCBsaW5lLCB3aGljaCBjYW4gY2FycnkgYSB0b2tlbmlzZWQgY2xvbmUgVVJMIG9yIGEgYC0tYXBpLWtleWAgZmxhZyDigJRcbiAqIHNvIHRoZSBjb250ZXh0IGlzIHNjcnViYmVkIGhlcmUgcmF0aGVyIHRoYW4gcmVseWluZyBvbiB0aGUgc2luay5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlY29yZEZhdWx0RXZlbnQoXG4gIGV2ZW50OiBGYXVsdEV2ZW50LFxuICBjb250ZXh0Pzogc3RyaW5nLFxuKTogdm9pZCB7XG4gIGNvbnN0IGN1cnJlbnQgPSBmYXVsdEV2ZW50Q291bnRlcnMuZ2V0KGV2ZW50KSA/PyAwO1xuICBmYXVsdEV2ZW50Q291bnRlcnMuc2V0KGV2ZW50LCBjdXJyZW50ICsgMSk7XG4gIGlmIChjb250ZXh0KSB7XG4gICAgY29uc29sZS53YXJuKGBbZmF1bHQtdG9sZXJhbmNlXSAke2V2ZW50fTogJHtyZWRhY3RTZWNyZXRzKGNvbnRleHQpfWApO1xuICB9XG59XG5cbi8qKlxuICogR2V0IHRoZSBjdXJyZW50IGNvdW50IGZvciBhIHNwZWNpZmljIGV2ZW50IHR5cGUuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBnZXRGYXVsdEV2ZW50Q291bnQoZXZlbnQ6IEZhdWx0RXZlbnQpOiBudW1iZXIge1xuICByZXR1cm4gZmF1bHRFdmVudENvdW50ZXJzLmdldChldmVudCkgPz8gMDtcbn1cblxuLyoqXG4gKiBHZXQgYSBzbmFwc2hvdCBvZiBhbGwgY291bnRlcnMuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBnZXRDb3VudGVyU25hcHNob3QoKTogQ291bnRlclNuYXBzaG90IHtcbiAgbGV0IHRvdGFsID0gMDtcbiAgZm9yIChjb25zdCBjb3VudCBvZiBmYXVsdEV2ZW50Q291bnRlcnMudmFsdWVzKCkpIHtcbiAgICB0b3RhbCArPSBjb3VudDtcbiAgfVxuICByZXR1cm4ge1xuICAgIGNvdW50ZXJzOiBuZXcgTWFwKGZhdWx0RXZlbnRDb3VudGVycyksXG4gICAgdG90YWxFdmVudHM6IHRvdGFsLFxuICB9O1xufVxuXG4vKipcbiAqIFJlc2V0IGFsbCBjb3VudGVycyB0byB6ZXJvLiBDYWxsIGF0IHRoZSBzdGFydCBvZiBlYWNoIHNjYW4gY3ljbGUuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZXNldEZhdWx0Q291bnRlcnMoKTogdm9pZCB7XG4gIGZhdWx0RXZlbnRDb3VudGVycy5jbGVhcigpO1xufVxuXG4vKipcbiAqIEZvcm1hdCBhIHN1bW1hcnkgb2YgYWxsIG5vbi16ZXJvIGNvdW50ZXJzIGZvciBsb2dnaW5nLlxuICpcbiAqIFJldHVybnMgbnVsbCBpZiBubyBldmVudHMgd2VyZSByZWNvcmRlZC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGZvcm1hdENvdW50ZXJTdW1tYXJ5KCk6IHN0cmluZyB8IG51bGwge1xuICBjb25zdCBzbmFwc2hvdCA9IGdldENvdW50ZXJTbmFwc2hvdCgpO1xuICBpZiAoc25hcHNob3QudG90YWxFdmVudHMgPT09IDApIHJldHVybiBudWxsO1xuXG4gIGNvbnN0IGxpbmVzOiBzdHJpbmdbXSA9IFtcIltmYXVsdC10b2xlcmFuY2VdIEN5Y2xlIHN1bW1hcnk6XCJdO1xuICBmb3IgKGNvbnN0IFtldmVudCwgY291bnRdIG9mIHNuYXBzaG90LmNvdW50ZXJzKSB7XG4gICAgaWYgKGNvdW50ID4gMCkge1xuICAgICAgbGluZXMucHVzaChgICAke2V2ZW50fTogJHtjb3VudH1gKTtcbiAgICB9XG4gIH1cbiAgbGluZXMucHVzaChgICB0b3RhbDogJHtzbmFwc2hvdC50b3RhbEV2ZW50c31gKTtcbiAgcmV0dXJuIGxpbmVzLmpvaW4oXCJcXG5cIik7XG59XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gU3RydWN0dXJlZCBjb3VudGVyIEFQSSAoSXNzdWUgIzExNzMpXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuLyoqXG4gKiBJbmNyZW1lbnQgYSBuYW1lZCBjb3VudGVyIGJ5IG9uZS5cbiAqXG4gKiBBY2NlcHRzIGFueSBzdHJpbmcgbmFtZSwgYWxsb3dpbmcgY2FsbGVycyB0byB1c2UgdGhlIGlzc3VlLXNwZWNpZmllZFxuICogY291bnRlciBuYW1lcyAocmV0cnlBdHRlbXB0cywgcmF0ZUxpbWl0QmFja29mZnMsIGV0Yy4pIGRpcmVjdGx5LlxuICovXG5leHBvcnQgZnVuY3Rpb24gaW5jcmVtZW50Q291bnRlcihuYW1lOiBzdHJpbmcpOiB2b2lkIHtcbiAgY29uc3QgY3VycmVudCA9IG5hbWVkQ291bnRlcnMuZ2V0KG5hbWUpID8/IDA7XG4gIG5hbWVkQ291bnRlcnMuc2V0KG5hbWUsIGN1cnJlbnQgKyAxKTtcbn1cblxuLyoqXG4gKiBHZXQgYWxsIG5vbi16ZXJvIG5hbWVkIGNvdW50ZXJzIGFzIGEgcGxhaW4gb2JqZWN0LlxuICovXG5leHBvcnQgZnVuY3Rpb24gZ2V0Q291bnRlcnMoKTogUmVjb3JkPHN0cmluZywgbnVtYmVyPiB7XG4gIGNvbnN0IHJlc3VsdDogUmVjb3JkPHN0cmluZywgbnVtYmVyPiA9IHt9O1xuICBmb3IgKGNvbnN0IFtuYW1lLCBjb3VudF0gb2YgbmFtZWRDb3VudGVycykge1xuICAgIGlmIChjb3VudCA+IDApIHtcbiAgICAgIHJlc3VsdFtuYW1lXSA9IGNvdW50O1xuICAgIH1cbiAgfVxuICByZXR1cm4gcmVzdWx0O1xufVxuXG4vKipcbiAqIFJlc2V0IGFsbCBuYW1lZCBjb3VudGVycyB0byB6ZXJvLiBDYWxsIGF0IHRoZSBzdGFydCBvZiBlYWNoIHdvcmtlciBjeWNsZS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlc2V0Q291bnRlcnMoKTogdm9pZCB7XG4gIG5hbWVkQ291bnRlcnMuY2xlYXIoKTtcbn1cblxuLyoqXG4gKiBXcml0ZSBhIEpTT04gc3VtbWFyeSBvZiBhbGwgbmFtZWQgY291bnRlcnMgdG8gZGlzay5cbiAqXG4gKiBXcml0ZXMgdG8gYHt3b3JrRGlyfS9mYXVsdF90b2xlcmFuY2Vfc3VtbWFyeS5qc29uYCB3aXRoIHRpbWVzdGFtcCxcbiAqIGNvdW50ZXJzLCBhbmQgd29ya2VyIGlkZW50aXR5LiBUaGlzIGZpbGUgaXMgZGlhZ25vc3RpYyBvbmx5IOKAlCBpdFxuICogZG9lcyBub3QgYWZmZWN0IHdvcmtlciBiZWhhdmlvdXIuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiB3cml0ZVN1bW1hcnkod29ya0Rpcjogc3RyaW5nKTogUHJvbWlzZTxSZXN1bHQ8dm9pZD4+IHtcbiAgY29uc3QgY291bnRlcnMgPSBnZXRDb3VudGVycygpO1xuICBsZXQgaG9zdG5hbWUgPSBcInVua25vd25cIjtcbiAgdHJ5IHtcbiAgICBob3N0bmFtZSA9IERlbm8uaG9zdG5hbWUoKTtcbiAgfSBjYXRjaCB7XG4gICAgLy8gaG9zdG5hbWUgdW5hdmFpbGFibGUg4oCUIHVzZSBmYWxsYmFja1xuICB9XG5cbiAgY29uc3Qgc3VtbWFyeSA9IHtcbiAgICB0aW1lc3RhbXA6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSxcbiAgICBjb3VudGVycyxcbiAgICB3b3JrZXJJZGVudGl0eTogaG9zdG5hbWUsXG4gIH07XG5cbiAgY29uc3QgcGF0aCA9IGAke3dvcmtEaXJ9L2ZhdWx0X3RvbGVyYW5jZV9zdW1tYXJ5Lmpzb25gO1xuICB0cnkge1xuICAgIGF3YWl0IERlbm8ud3JpdGVUZXh0RmlsZShwYXRoLCBKU09OLnN0cmluZ2lmeShzdW1tYXJ5LCBudWxsLCAyKSk7XG4gICAgcmV0dXJuIHsgb2s6IHRydWUsIHZhbHVlOiB1bmRlZmluZWQgfTtcbiAgfSBjYXRjaCAoZXJyKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIG9rOiBmYWxzZSxcbiAgICAgIGVycm9yOiBuZXcgRXJyb3IoXG4gICAgICAgIGBGYWlsZWQgdG8gd3JpdGUgZmF1bHQgdG9sZXJhbmNlIHN1bW1hcnkgdG8gJHtwYXRofTogJHtcbiAgICAgICAgICBlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVycilcbiAgICAgICAgfWAsXG4gICAgICApLFxuICAgIH07XG4gIH1cbn1cbiJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTs7Ozs7Ozs7Ozs7OztDQWFDLEdBR0QsU0FBUyxhQUFhLFFBQVEsd0JBQXdCO0FBdUJ0RCxNQUFNLHFCQUFxQixJQUFJO0FBRS9CLE1BQU0sZ0JBQWdCLElBQUk7QUFFMUI7Ozs7Ozs7Ozs7Q0FVQyxHQUNELE9BQU8sU0FBUyxpQkFDZCxLQUFpQixFQUNqQixPQUFnQjtFQUVoQixNQUFNLFVBQVUsbUJBQW1CLEdBQUcsQ0FBQyxVQUFVO0VBQ2pELG1CQUFtQixHQUFHLENBQUMsT0FBTyxVQUFVO0VBQ3hDLElBQUksU0FBUztJQUNYLFFBQVEsSUFBSSxDQUFDLENBQUMsa0JBQWtCLEVBQUUsTUFBTSxFQUFFLEVBQUUsY0FBYyxVQUFVO0VBQ3RFO0FBQ0Y7QUFFQTs7Q0FFQyxHQUNELE9BQU8sU0FBUyxtQkFBbUIsS0FBaUI7RUFDbEQsT0FBTyxtQkFBbUIsR0FBRyxDQUFDLFVBQVU7QUFDMUM7QUFFQTs7Q0FFQyxHQUNELE9BQU8sU0FBUztFQUNkLElBQUksUUFBUTtFQUNaLEtBQUssTUFBTSxTQUFTLG1CQUFtQixNQUFNLEdBQUk7SUFDL0MsU0FBUztFQUNYO0VBQ0EsT0FBTztJQUNMLFVBQVUsSUFBSSxJQUFJO0lBQ2xCLGFBQWE7RUFDZjtBQUNGO0FBRUE7O0NBRUMsR0FDRCxPQUFPLFNBQVM7RUFDZCxtQkFBbUIsS0FBSztBQUMxQjtBQUVBOzs7O0NBSUMsR0FDRCxPQUFPLFNBQVM7RUFDZCxNQUFNLFdBQVc7RUFDakIsSUFBSSxTQUFTLFdBQVcsS0FBSyxHQUFHLE9BQU87RUFFdkMsTUFBTSxRQUFrQjtJQUFDO0dBQW1DO0VBQzVELEtBQUssTUFBTSxDQUFDLE9BQU8sTUFBTSxJQUFJLFNBQVMsUUFBUSxDQUFFO0lBQzlDLElBQUksUUFBUSxHQUFHO01BQ2IsTUFBTSxJQUFJLENBQUMsQ0FBQyxFQUFFLEVBQUUsTUFBTSxFQUFFLEVBQUUsT0FBTztJQUNuQztFQUNGO0VBQ0EsTUFBTSxJQUFJLENBQUMsQ0FBQyxTQUFTLEVBQUUsU0FBUyxXQUFXLEVBQUU7RUFDN0MsT0FBTyxNQUFNLElBQUksQ0FBQztBQUNwQjtBQUVBLDhFQUE4RTtBQUM5RSx1Q0FBdUM7QUFDdkMsOEVBQThFO0FBRTlFOzs7OztDQUtDLEdBQ0QsT0FBTyxTQUFTLGlCQUFpQixJQUFZO0VBQzNDLE1BQU0sVUFBVSxjQUFjLEdBQUcsQ0FBQyxTQUFTO0VBQzNDLGNBQWMsR0FBRyxDQUFDLE1BQU0sVUFBVTtBQUNwQztBQUVBOztDQUVDLEdBQ0QsT0FBTyxTQUFTO0VBQ2QsTUFBTSxTQUFpQyxDQUFDO0VBQ3hDLEtBQUssTUFBTSxDQUFDLE1BQU0sTUFBTSxJQUFJLGNBQWU7SUFDekMsSUFBSSxRQUFRLEdBQUc7TUFDYixNQUFNLENBQUMsS0FBSyxHQUFHO0lBQ2pCO0VBQ0Y7RUFDQSxPQUFPO0FBQ1Q7QUFFQTs7Q0FFQyxHQUNELE9BQU8sU0FBUztFQUNkLGNBQWMsS0FBSztBQUNyQjtBQUVBOzs7Ozs7Q0FNQyxHQUNELE9BQU8sZUFBZSxhQUFhLE9BQWU7RUFDaEQsTUFBTSxXQUFXO0VBQ2pCLElBQUksV0FBVztFQUNmLElBQUk7SUFDRixXQUFXLEtBQUssUUFBUTtFQUMxQixFQUFFLE9BQU07RUFDTixzQ0FBc0M7RUFDeEM7RUFFQSxNQUFNLFVBQVU7SUFDZCxXQUFXLElBQUksT0FBTyxXQUFXO0lBQ2pDO0lBQ0EsZ0JBQWdCO0VBQ2xCO0VBRUEsTUFBTSxPQUFPLEdBQUcsUUFBUSw2QkFBNkIsQ0FBQztFQUN0RCxJQUFJO0lBQ0YsTUFBTSxLQUFLLGFBQWEsQ0FBQyxNQUFNLEtBQUssU0FBUyxDQUFDLFNBQVMsTUFBTTtJQUM3RCxPQUFPO01BQUUsSUFBSTtNQUFNLE9BQU87SUFBVTtFQUN0QyxFQUFFLE9BQU8sS0FBSztJQUNaLE9BQU87TUFDTCxJQUFJO01BQ0osT0FBTyxJQUFJLE1BQ1QsQ0FBQywyQ0FBMkMsRUFBRSxLQUFLLEVBQUUsRUFDbkQsZUFBZSxRQUFRLElBQUksT0FBTyxHQUFHLE9BQU8sTUFDNUM7SUFFTjtFQUNGO0FBQ0YifQ==
// denoCacheMetadata=7398037207040289671,1337910596752097040