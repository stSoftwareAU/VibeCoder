/**
 * Guarded `--label` arguments for `gh issue create` (Issue #1276).
 *
 * `worker_label_guard.ts` documents a single invariant: every label the
 * worker applies passes its positive allowlist. Until #1276 that invariant
 * only held for labels applied to an **existing** issue — `addLabelToIssue`
 * and `escalateToHuman` were the guard's only two call sites. The scan and
 * idle-task templates apply their labels at *creation* time, pushing
 * `"--label", <value>` straight into the `gh issue create` argv, so nothing
 * checked them.
 *
 * This module is the creation-time chokepoint that closes that half. Every
 * `gh issue create` argv in `worker/deno/` builds its label arguments here,
 * and the `issue-create label guard` quality check
 * (`issue_create_label_check.ts`) fails the build on any new `--label`
 * argument that skips it.
 *
 * Fail loud: a refused label throws rather than being silently dropped, so a
 * future template that derives a label from scan data cannot quietly file an
 * issue carrying an operational or reserved label. The refusal is also
 * recorded on stderr by the guard itself as a `[SECURITY]` audit line.
 *
 * Australian English spelling used throughout (behaviour, colour, etc.).
 */ import { assertWorkerCanApplyLabel } from "./worker_label_guard.ts";
/**
 * Build the `--label` arguments for a `gh issue create` invocation, asserting
 * every label against the worker label allowlist first.
 *
 * @param labels - Labels to attach to the issue being created. Empty entries
 *   are a programming error and are refused like any other off-list label.
 * @param caller - Callsite hint (repo-relative file path) recorded in the
 *   `[SECURITY] [WORKER_LABEL_REFUSED]` audit line.
 * @returns A flat `["--label", a, "--label", b, …]` argument list.
 * @throws Error naming every refused label, if any label is not appliable.
 */ export function guardedLabelArgs(labels, caller) {
  const refused = [];
  const args = [];
  for (const label of labels){
    const check = assertWorkerCanApplyLabel(label, {
      caller
    });
    if (!check.ok) {
      refused.push(label);
      continue;
    }
    args.push("--label", label);
  }
  if (refused.length > 0) {
    throw new Error(`Refusing to create an issue with label(s) the worker may not apply: ` + `${refused.map((l)=>`'${l}'`).join(", ")} (caller=${caller}). ` + `Add the label to worker/deno/lib/worker_label_guard.ts if it is ` + `legitimate worker content.`);
  }
  return args;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9ndWFyZGVkX2lzc3VlX2xhYmVscy50cyJdLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIEd1YXJkZWQgYC0tbGFiZWxgIGFyZ3VtZW50cyBmb3IgYGdoIGlzc3VlIGNyZWF0ZWAgKElzc3VlICMxMjc2KS5cbiAqXG4gKiBgd29ya2VyX2xhYmVsX2d1YXJkLnRzYCBkb2N1bWVudHMgYSBzaW5nbGUgaW52YXJpYW50OiBldmVyeSBsYWJlbCB0aGVcbiAqIHdvcmtlciBhcHBsaWVzIHBhc3NlcyBpdHMgcG9zaXRpdmUgYWxsb3dsaXN0LiBVbnRpbCAjMTI3NiB0aGF0IGludmFyaWFudFxuICogb25seSBoZWxkIGZvciBsYWJlbHMgYXBwbGllZCB0byBhbiAqKmV4aXN0aW5nKiogaXNzdWUg4oCUIGBhZGRMYWJlbFRvSXNzdWVgXG4gKiBhbmQgYGVzY2FsYXRlVG9IdW1hbmAgd2VyZSB0aGUgZ3VhcmQncyBvbmx5IHR3byBjYWxsIHNpdGVzLiBUaGUgc2NhbiBhbmRcbiAqIGlkbGUtdGFzayB0ZW1wbGF0ZXMgYXBwbHkgdGhlaXIgbGFiZWxzIGF0ICpjcmVhdGlvbiogdGltZSwgcHVzaGluZ1xuICogYFwiLS1sYWJlbFwiLCA8dmFsdWU+YCBzdHJhaWdodCBpbnRvIHRoZSBgZ2ggaXNzdWUgY3JlYXRlYCBhcmd2LCBzbyBub3RoaW5nXG4gKiBjaGVja2VkIHRoZW0uXG4gKlxuICogVGhpcyBtb2R1bGUgaXMgdGhlIGNyZWF0aW9uLXRpbWUgY2hva2Vwb2ludCB0aGF0IGNsb3NlcyB0aGF0IGhhbGYuIEV2ZXJ5XG4gKiBgZ2ggaXNzdWUgY3JlYXRlYCBhcmd2IGluIGB3b3JrZXIvZGVuby9gIGJ1aWxkcyBpdHMgbGFiZWwgYXJndW1lbnRzIGhlcmUsXG4gKiBhbmQgdGhlIGBpc3N1ZS1jcmVhdGUgbGFiZWwgZ3VhcmRgIHF1YWxpdHkgY2hlY2tcbiAqIChgaXNzdWVfY3JlYXRlX2xhYmVsX2NoZWNrLnRzYCkgZmFpbHMgdGhlIGJ1aWxkIG9uIGFueSBuZXcgYC0tbGFiZWxgXG4gKiBhcmd1bWVudCB0aGF0IHNraXBzIGl0LlxuICpcbiAqIEZhaWwgbG91ZDogYSByZWZ1c2VkIGxhYmVsIHRocm93cyByYXRoZXIgdGhhbiBiZWluZyBzaWxlbnRseSBkcm9wcGVkLCBzbyBhXG4gKiBmdXR1cmUgdGVtcGxhdGUgdGhhdCBkZXJpdmVzIGEgbGFiZWwgZnJvbSBzY2FuIGRhdGEgY2Fubm90IHF1aWV0bHkgZmlsZSBhblxuICogaXNzdWUgY2FycnlpbmcgYW4gb3BlcmF0aW9uYWwgb3IgcmVzZXJ2ZWQgbGFiZWwuIFRoZSByZWZ1c2FsIGlzIGFsc29cbiAqIHJlY29yZGVkIG9uIHN0ZGVyciBieSB0aGUgZ3VhcmQgaXRzZWxmIGFzIGEgYFtTRUNVUklUWV1gIGF1ZGl0IGxpbmUuXG4gKlxuICogQXVzdHJhbGlhbiBFbmdsaXNoIHNwZWxsaW5nIHVzZWQgdGhyb3VnaG91dCAoYmVoYXZpb3VyLCBjb2xvdXIsIGV0Yy4pLlxuICovXG5cbmltcG9ydCB7IGFzc2VydFdvcmtlckNhbkFwcGx5TGFiZWwgfSBmcm9tIFwiLi93b3JrZXJfbGFiZWxfZ3VhcmQudHNcIjtcblxuLyoqXG4gKiBCdWlsZCB0aGUgYC0tbGFiZWxgIGFyZ3VtZW50cyBmb3IgYSBgZ2ggaXNzdWUgY3JlYXRlYCBpbnZvY2F0aW9uLCBhc3NlcnRpbmdcbiAqIGV2ZXJ5IGxhYmVsIGFnYWluc3QgdGhlIHdvcmtlciBsYWJlbCBhbGxvd2xpc3QgZmlyc3QuXG4gKlxuICogQHBhcmFtIGxhYmVscyAtIExhYmVscyB0byBhdHRhY2ggdG8gdGhlIGlzc3VlIGJlaW5nIGNyZWF0ZWQuIEVtcHR5IGVudHJpZXNcbiAqICAgYXJlIGEgcHJvZ3JhbW1pbmcgZXJyb3IgYW5kIGFyZSByZWZ1c2VkIGxpa2UgYW55IG90aGVyIG9mZi1saXN0IGxhYmVsLlxuICogQHBhcmFtIGNhbGxlciAtIENhbGxzaXRlIGhpbnQgKHJlcG8tcmVsYXRpdmUgZmlsZSBwYXRoKSByZWNvcmRlZCBpbiB0aGVcbiAqICAgYFtTRUNVUklUWV0gW1dPUktFUl9MQUJFTF9SRUZVU0VEXWAgYXVkaXQgbGluZS5cbiAqIEByZXR1cm5zIEEgZmxhdCBgW1wiLS1sYWJlbFwiLCBhLCBcIi0tbGFiZWxcIiwgYiwg4oCmXWAgYXJndW1lbnQgbGlzdC5cbiAqIEB0aHJvd3MgRXJyb3IgbmFtaW5nIGV2ZXJ5IHJlZnVzZWQgbGFiZWwsIGlmIGFueSBsYWJlbCBpcyBub3QgYXBwbGlhYmxlLlxuICovXG5leHBvcnQgZnVuY3Rpb24gZ3VhcmRlZExhYmVsQXJncyhcbiAgbGFiZWxzOiByZWFkb25seSBzdHJpbmdbXSxcbiAgY2FsbGVyOiBzdHJpbmcsXG4pOiBzdHJpbmdbXSB7XG4gIGNvbnN0IHJlZnVzZWQ6IHN0cmluZ1tdID0gW107XG4gIGNvbnN0IGFyZ3M6IHN0cmluZ1tdID0gW107XG5cbiAgZm9yIChjb25zdCBsYWJlbCBvZiBsYWJlbHMpIHtcbiAgICBjb25zdCBjaGVjayA9IGFzc2VydFdvcmtlckNhbkFwcGx5TGFiZWwobGFiZWwsIHsgY2FsbGVyIH0pO1xuICAgIGlmICghY2hlY2sub2spIHtcbiAgICAgIHJlZnVzZWQucHVzaChsYWJlbCk7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgYXJncy5wdXNoKFwiLS1sYWJlbFwiLCBsYWJlbCk7XG4gIH1cblxuICBpZiAocmVmdXNlZC5sZW5ndGggPiAwKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgYFJlZnVzaW5nIHRvIGNyZWF0ZSBhbiBpc3N1ZSB3aXRoIGxhYmVsKHMpIHRoZSB3b3JrZXIgbWF5IG5vdCBhcHBseTogYCArXG4gICAgICAgIGAke3JlZnVzZWQubWFwKChsKSA9PiBgJyR7bH0nYCkuam9pbihcIiwgXCIpfSAoY2FsbGVyPSR7Y2FsbGVyfSkuIGAgK1xuICAgICAgICBgQWRkIHRoZSBsYWJlbCB0byB3b3JrZXIvZGVuby9saWIvd29ya2VyX2xhYmVsX2d1YXJkLnRzIGlmIGl0IGlzIGAgK1xuICAgICAgICBgbGVnaXRpbWF0ZSB3b3JrZXIgY29udGVudC5gLFxuICAgICk7XG4gIH1cblxuICByZXR1cm4gYXJncztcbn1cbiJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Q0F1QkMsR0FFRCxTQUFTLHlCQUF5QixRQUFRLDBCQUEwQjtBQUVwRTs7Ozs7Ozs7OztDQVVDLEdBQ0QsT0FBTyxTQUFTLGlCQUNkLE1BQXlCLEVBQ3pCLE1BQWM7RUFFZCxNQUFNLFVBQW9CLEVBQUU7RUFDNUIsTUFBTSxPQUFpQixFQUFFO0VBRXpCLEtBQUssTUFBTSxTQUFTLE9BQVE7SUFDMUIsTUFBTSxRQUFRLDBCQUEwQixPQUFPO01BQUU7SUFBTztJQUN4RCxJQUFJLENBQUMsTUFBTSxFQUFFLEVBQUU7TUFDYixRQUFRLElBQUksQ0FBQztNQUNiO0lBQ0Y7SUFDQSxLQUFLLElBQUksQ0FBQyxXQUFXO0VBQ3ZCO0VBRUEsSUFBSSxRQUFRLE1BQU0sR0FBRyxHQUFHO0lBQ3RCLE1BQU0sSUFBSSxNQUNSLENBQUMsb0VBQW9FLENBQUMsR0FDcEUsR0FBRyxRQUFRLEdBQUcsQ0FBQyxDQUFDLElBQU0sQ0FBQyxDQUFDLEVBQUUsRUFBRSxDQUFDLENBQUMsRUFBRSxJQUFJLENBQUMsTUFBTSxTQUFTLEVBQUUsT0FBTyxHQUFHLENBQUMsR0FDakUsQ0FBQyxnRUFBZ0UsQ0FBQyxHQUNsRSxDQUFDLDBCQUEwQixDQUFDO0VBRWxDO0VBRUEsT0FBTztBQUNUIn0=
// denoCacheMetadata=12467708638333619641,125741761445477685