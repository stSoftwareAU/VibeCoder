/**
 * What the PR-path conflict fallback observed, read back off GitHub
 * (Issue #2310, part of #2298).
 *
 * The fallback closes a PR, and `merge_fallback_issue.ts` files the one record
 * of that event. This module gathers the three things that record needs and
 * neither the scan nor the abandon rung already holds:
 *
 * 1. **each run's stage timings and host**, parsed back out of the conclusion
 *    comments #2308 writes them onto — the run that measured them is long
 *    gone, so the comment is the only surviving source;
 * 2. **how far behind the base the head was, and since when** — `behind_by`
 *    from the compare API, and the `merge-conflict` `labeled` timeline event
 *    the stall watchdog already reads;
 * 3. **what the abandoned PR changed** — the diff summary that turns a flag
 *    issue into a re-do item when the PR's originating issue cannot be found.
 *
 * **Every reader here is best-effort by design, and never silent.** A flag
 * issue that could not be filed is a fallback nobody hears about, so a failed
 * read is logged at WARN and returns nothing — which the flag body renders as
 * `not recorded`, an honest statement rather than an invented number. What must
 * never happen is a read failure stopping the fallback itself.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */ import { getLabelLastAddInfoComplete } from "./issue_query.ts";
/**
 * Paths one flag issue lists for an abandoned PR.
 *
 * A GitHub issue body is capped, and a PR that touched thousands of files
 * would spend the whole body on paths and lose the analyses that explain the
 * conflict. The count beyond the cap is reported rather than dropped.
 */ export const MAX_DIFF_SUMMARY_PATHS = 200;
/**
 * The timings line `formatStageTimings` renders (Issue #2308).
 *
 * Anchored to a line, and every group bounded, so a comment body of any size
 * costs one linear pass — an unbounded nested group here would be a ReDoS
 * surface on attacker-writable text.
 */ const TIMINGS_LINE = /^Timings \(host `([^`\n]*)`\): *([^\n]*)$/m;
/** `deepen 3s` — one timed stage. */ const STAGE_SECONDS = /^(\S{1,40}) (\d{1,9})s$/;
/** `agent unfinished` — a stage that started and never stopped. */ const STAGE_UNFINISHED = /^(\S{1,40}) unfinished$/;
/**
 * A git ref this module is willing to put in an API path.
 *
 * The refs come off GitHub's own listing, so this cannot fire in practice —
 * it is the defence that keeps it that way: a ref carrying `..`, a query
 * character or a space could redirect the compare call somewhere else
 * entirely, and a redirected read is worse than an unrecorded one.
 */ const SAFE_REF = /^[A-Za-z0-9._\-/]{1,255}$/;
/**
 * Read the stage timings and host back out of one conclusion comment.
 *
 * @param body - The comment body, as GitHub returns it
 * @returns The host and stages, or `undefined` when the body carries no
 *   timings line at all — an attempt from before #2308, or one whose run died
 *   before it could write one
 */ export function parseStageTimingsLine(body) {
  const match = TIMINGS_LINE.exec(body);
  if (match === null) return undefined;
  const host = (match[1] ?? "").trim();
  const timings = [];
  for (const segment of (match[2] ?? "").split("·")){
    const text = segment.trim();
    if (text.length === 0) continue;
    const timed = STAGE_SECONDS.exec(text);
    if (timed !== null) {
      timings.push({
        stage: timed[1],
        seconds: Number(timed[2])
      });
      continue;
    }
    const unfinished = STAGE_UNFINISHED.exec(text);
    if (unfinished !== null) {
      // `null` seconds renders as `unfinished`, which is the whole point of
      // the stage that died: an invented duration would hide it.
      timings.push({
        stage: unfinished[1],
        seconds: null
      });
    }
  // Anything else is the renderer's own "no stage was timed", or text a
  // later version added. It is not a stage, so it records none.
  }
  return {
    ...host.length > 0 ? {
      host
    } : {},
    timings
  };
}
/**
 * Read how far behind the base a conflicting head was, and since when.
 *
 * Never throws: each of the two reads is independent, and a failure in either
 * leaves its field unrecorded rather than costing the flag issue the other.
 *
 * @returns The fields that could be read; an empty object when neither could
 */ export async function readPrDivergence(options) {
  const { repo, prNumber, baseBranch, headBranch, gh, logger } = options;
  const divergence = {};
  const warn = (message, error)=>{
    logger?.warn?.(message, {
      repo,
      prNumber,
      error: error instanceof Error ? error.message : String(error)
    });
  };
  if (isSafeRef(baseBranch) && isSafeRef(headBranch)) {
    try {
      const raw = await gh([
        "api",
        `repos/${repo}/compare/${baseBranch}...${headBranch}`,
        "--jq",
        ".behind_by"
      ]);
      const behindBy = Number(raw.trim());
      if (Number.isSafeInteger(behindBy) && behindBy >= 0) {
        divergence.behindBy = behindBy;
      } else {
        warn("Conflict fallback: the compare API reported no usable `behind_by`", new Error(`read ${JSON.stringify(raw.trim())}`));
      }
    } catch (error) {
      warn("Conflict fallback: could not compare the head with its base", error);
    }
  } else {
    warn("Conflict fallback: refusing to compare an unusable ref", new Error(`base=${baseBranch} head=${headBranch}`));
  }
  try {
    const lastAdd = await getLabelLastAddInfoComplete(repo, prNumber, options.queueLabel, gh);
    if (lastAdd !== null) {
      divergence.behindSince = new Date(lastAdd.addedAt * 1000).toISOString();
    } else {
      warn(`Conflict fallback: no \`labeled\` event for \`${options.queueLabel}\`` + " — the flag cannot say since when", new Error("no timeline event"));
    }
  } catch (error) {
    warn("Conflict fallback: could not read the label timeline", error);
  }
  return divergence;
}
/**
 * Read the abandoned PR's diff summary — path, additions, deletions.
 *
 * This is what makes a flag issue a re-do item: the PR is closed, so the
 * summary is the only statement of what the work actually touched.
 *
 * @returns The capped summary, or `undefined` when it could not be read —
 *   which the flag body renders as `not recorded`
 */ export async function readPrDiffSummary(options) {
  const { repo, prNumber, gh, logger } = options;
  try {
    const raw = await gh([
      "pr",
      "view",
      String(prNumber),
      "--repo",
      repo,
      "--json",
      "files"
    ]);
    const parsed = JSON.parse(raw.trim() || "{}");
    const listed = parsed.files;
    if (!Array.isArray(listed)) {
      throw new Error("the response carried no `files` array");
    }
    const files = [];
    let seen = 0;
    for (const entry of listed){
      if (typeof entry !== "object" || entry === null) continue;
      const file = entry;
      if (typeof file.path !== "string" || file.path.length === 0) continue;
      seen++;
      if (files.length >= MAX_DIFF_SUMMARY_PATHS) continue;
      files.push({
        path: file.path,
        additions: typeof file.additions === "number" ? file.additions : 0,
        deletions: typeof file.deletions === "number" ? file.deletions : 0
      });
    }
    return {
      files,
      omitted: seen - files.length
    };
  } catch (error) {
    logger?.warn?.("Conflict fallback: could not read the PR's diff summary", {
      repo,
      prNumber,
      error: error instanceof Error ? error.message : String(error)
    });
    return undefined;
  }
}
/** Whether a ref is safe to interpolate into an API path. */ export function isSafeRef(ref) {
  return SAFE_REF.test(ref) && !ref.includes("..");
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9jb25mbGljdF9mYWxsYmFja19jb250ZXh0LnRzIl0sInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogV2hhdCB0aGUgUFItcGF0aCBjb25mbGljdCBmYWxsYmFjayBvYnNlcnZlZCwgcmVhZCBiYWNrIG9mZiBHaXRIdWJcbiAqIChJc3N1ZSAjMjMxMCwgcGFydCBvZiAjMjI5OCkuXG4gKlxuICogVGhlIGZhbGxiYWNrIGNsb3NlcyBhIFBSLCBhbmQgYG1lcmdlX2ZhbGxiYWNrX2lzc3VlLnRzYCBmaWxlcyB0aGUgb25lIHJlY29yZFxuICogb2YgdGhhdCBldmVudC4gVGhpcyBtb2R1bGUgZ2F0aGVycyB0aGUgdGhyZWUgdGhpbmdzIHRoYXQgcmVjb3JkIG5lZWRzIGFuZFxuICogbmVpdGhlciB0aGUgc2NhbiBub3IgdGhlIGFiYW5kb24gcnVuZyBhbHJlYWR5IGhvbGRzOlxuICpcbiAqIDEuICoqZWFjaCBydW4ncyBzdGFnZSB0aW1pbmdzIGFuZCBob3N0KiosIHBhcnNlZCBiYWNrIG91dCBvZiB0aGUgY29uY2x1c2lvblxuICogICAgY29tbWVudHMgIzIzMDggd3JpdGVzIHRoZW0gb250byDigJQgdGhlIHJ1biB0aGF0IG1lYXN1cmVkIHRoZW0gaXMgbG9uZ1xuICogICAgZ29uZSwgc28gdGhlIGNvbW1lbnQgaXMgdGhlIG9ubHkgc3Vydml2aW5nIHNvdXJjZTtcbiAqIDIuICoqaG93IGZhciBiZWhpbmQgdGhlIGJhc2UgdGhlIGhlYWQgd2FzLCBhbmQgc2luY2Ugd2hlbioqIOKAlCBgYmVoaW5kX2J5YFxuICogICAgZnJvbSB0aGUgY29tcGFyZSBBUEksIGFuZCB0aGUgYG1lcmdlLWNvbmZsaWN0YCBgbGFiZWxlZGAgdGltZWxpbmUgZXZlbnRcbiAqICAgIHRoZSBzdGFsbCB3YXRjaGRvZyBhbHJlYWR5IHJlYWRzO1xuICogMy4gKip3aGF0IHRoZSBhYmFuZG9uZWQgUFIgY2hhbmdlZCoqIOKAlCB0aGUgZGlmZiBzdW1tYXJ5IHRoYXQgdHVybnMgYSBmbGFnXG4gKiAgICBpc3N1ZSBpbnRvIGEgcmUtZG8gaXRlbSB3aGVuIHRoZSBQUidzIG9yaWdpbmF0aW5nIGlzc3VlIGNhbm5vdCBiZSBmb3VuZC5cbiAqXG4gKiAqKkV2ZXJ5IHJlYWRlciBoZXJlIGlzIGJlc3QtZWZmb3J0IGJ5IGRlc2lnbiwgYW5kIG5ldmVyIHNpbGVudC4qKiBBIGZsYWdcbiAqIGlzc3VlIHRoYXQgY291bGQgbm90IGJlIGZpbGVkIGlzIGEgZmFsbGJhY2sgbm9ib2R5IGhlYXJzIGFib3V0LCBzbyBhIGZhaWxlZFxuICogcmVhZCBpcyBsb2dnZWQgYXQgV0FSTiBhbmQgcmV0dXJucyBub3RoaW5nIOKAlCB3aGljaCB0aGUgZmxhZyBib2R5IHJlbmRlcnMgYXNcbiAqIGBub3QgcmVjb3JkZWRgLCBhbiBob25lc3Qgc3RhdGVtZW50IHJhdGhlciB0aGFuIGFuIGludmVudGVkIG51bWJlci4gV2hhdCBtdXN0XG4gKiBuZXZlciBoYXBwZW4gaXMgYSByZWFkIGZhaWx1cmUgc3RvcHBpbmcgdGhlIGZhbGxiYWNrIGl0c2VsZi5cbiAqXG4gKiBVc2VzIEF1c3RyYWxpYW4gRW5nbGlzaCB0aHJvdWdob3V0IChiZWhhdmlvdXIsIGNvbG91ciwgb3JnYW5pc2F0aW9uLCBldGMuKS5cbiAqL1xuXG5pbXBvcnQgdHlwZSB7IExvZ2dlciB9IGZyb20gXCIuLi90eXBlcy50c1wiO1xuaW1wb3J0IHsgZ2V0TGFiZWxMYXN0QWRkSW5mb0NvbXBsZXRlIH0gZnJvbSBcIi4vaXNzdWVfcXVlcnkudHNcIjtcbmltcG9ydCB0eXBlIHtcbiAgTWVyZ2VGYWxsYmFja0RpZmZGaWxlLFxuICBNZXJnZUZhbGxiYWNrU3RhZ2VUaW1pbmcsXG59IGZyb20gXCIuL21lcmdlX2ZhbGxiYWNrX2lzc3VlLnRzXCI7XG5cbi8qKlxuICogUGF0aHMgb25lIGZsYWcgaXNzdWUgbGlzdHMgZm9yIGFuIGFiYW5kb25lZCBQUi5cbiAqXG4gKiBBIEdpdEh1YiBpc3N1ZSBib2R5IGlzIGNhcHBlZCwgYW5kIGEgUFIgdGhhdCB0b3VjaGVkIHRob3VzYW5kcyBvZiBmaWxlc1xuICogd291bGQgc3BlbmQgdGhlIHdob2xlIGJvZHkgb24gcGF0aHMgYW5kIGxvc2UgdGhlIGFuYWx5c2VzIHRoYXQgZXhwbGFpbiB0aGVcbiAqIGNvbmZsaWN0LiBUaGUgY291bnQgYmV5b25kIHRoZSBjYXAgaXMgcmVwb3J0ZWQgcmF0aGVyIHRoYW4gZHJvcHBlZC5cbiAqL1xuZXhwb3J0IGNvbnN0IE1BWF9ESUZGX1NVTU1BUllfUEFUSFMgPSAyMDA7XG5cbi8qKlxuICogVGhlIHRpbWluZ3MgbGluZSBgZm9ybWF0U3RhZ2VUaW1pbmdzYCByZW5kZXJzIChJc3N1ZSAjMjMwOCkuXG4gKlxuICogQW5jaG9yZWQgdG8gYSBsaW5lLCBhbmQgZXZlcnkgZ3JvdXAgYm91bmRlZCwgc28gYSBjb21tZW50IGJvZHkgb2YgYW55IHNpemVcbiAqIGNvc3RzIG9uZSBsaW5lYXIgcGFzcyDigJQgYW4gdW5ib3VuZGVkIG5lc3RlZCBncm91cCBoZXJlIHdvdWxkIGJlIGEgUmVEb1NcbiAqIHN1cmZhY2Ugb24gYXR0YWNrZXItd3JpdGFibGUgdGV4dC5cbiAqL1xuY29uc3QgVElNSU5HU19MSU5FID0gL15UaW1pbmdzIFxcKGhvc3QgYChbXmBcXG5dKilgXFwpOiAqKFteXFxuXSopJC9tO1xuXG4vKiogYGRlZXBlbiAzc2Ag4oCUIG9uZSB0aW1lZCBzdGFnZS4gKi9cbmNvbnN0IFNUQUdFX1NFQ09ORFMgPSAvXihcXFN7MSw0MH0pIChcXGR7MSw5fSlzJC87XG5cbi8qKiBgYWdlbnQgdW5maW5pc2hlZGAg4oCUIGEgc3RhZ2UgdGhhdCBzdGFydGVkIGFuZCBuZXZlciBzdG9wcGVkLiAqL1xuY29uc3QgU1RBR0VfVU5GSU5JU0hFRCA9IC9eKFxcU3sxLDQwfSkgdW5maW5pc2hlZCQvO1xuXG4vKipcbiAqIEEgZ2l0IHJlZiB0aGlzIG1vZHVsZSBpcyB3aWxsaW5nIHRvIHB1dCBpbiBhbiBBUEkgcGF0aC5cbiAqXG4gKiBUaGUgcmVmcyBjb21lIG9mZiBHaXRIdWIncyBvd24gbGlzdGluZywgc28gdGhpcyBjYW5ub3QgZmlyZSBpbiBwcmFjdGljZSDigJRcbiAqIGl0IGlzIHRoZSBkZWZlbmNlIHRoYXQga2VlcHMgaXQgdGhhdCB3YXk6IGEgcmVmIGNhcnJ5aW5nIGAuLmAsIGEgcXVlcnlcbiAqIGNoYXJhY3RlciBvciBhIHNwYWNlIGNvdWxkIHJlZGlyZWN0IHRoZSBjb21wYXJlIGNhbGwgc29tZXdoZXJlIGVsc2VcbiAqIGVudGlyZWx5LCBhbmQgYSByZWRpcmVjdGVkIHJlYWQgaXMgd29yc2UgdGhhbiBhbiB1bnJlY29yZGVkIG9uZS5cbiAqL1xuY29uc3QgU0FGRV9SRUYgPSAvXltBLVphLXowLTkuX1xcLS9dezEsMjU1fSQvO1xuXG4vKiogV2hhdCBvbmUgY29uY2x1c2lvbiBjb21tZW50IHJlY29yZGVkIGFib3V0IHRoZSBydW4gdGhhdCB3cm90ZSBpdC4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgUGFyc2VkU3RhZ2VUaW1pbmdzIHtcbiAgLyoqIFRoZSBob3N0IHRoZSBydW4gcmVwb3J0ZWQsIHdoZW4gdGhlIGxpbmUgY2FycmllZCBvbmUuICovXG4gIGhvc3Q/OiBzdHJpbmc7XG4gIC8qKiBPbmUgZW50cnkgcGVyIHN0YWdlIHRoZSBsaW5lIG5hbWVkLCBpbiB0aGUgb3JkZXIgaXQgbmFtZWQgdGhlbS4gKi9cbiAgdGltaW5nczogTWVyZ2VGYWxsYmFja1N0YWdlVGltaW5nW107XG59XG5cbi8qKlxuICogUmVhZCB0aGUgc3RhZ2UgdGltaW5ncyBhbmQgaG9zdCBiYWNrIG91dCBvZiBvbmUgY29uY2x1c2lvbiBjb21tZW50LlxuICpcbiAqIEBwYXJhbSBib2R5IC0gVGhlIGNvbW1lbnQgYm9keSwgYXMgR2l0SHViIHJldHVybnMgaXRcbiAqIEByZXR1cm5zIFRoZSBob3N0IGFuZCBzdGFnZXMsIG9yIGB1bmRlZmluZWRgIHdoZW4gdGhlIGJvZHkgY2FycmllcyBub1xuICogICB0aW1pbmdzIGxpbmUgYXQgYWxsIOKAlCBhbiBhdHRlbXB0IGZyb20gYmVmb3JlICMyMzA4LCBvciBvbmUgd2hvc2UgcnVuIGRpZWRcbiAqICAgYmVmb3JlIGl0IGNvdWxkIHdyaXRlIG9uZVxuICovXG5leHBvcnQgZnVuY3Rpb24gcGFyc2VTdGFnZVRpbWluZ3NMaW5lKFxuICBib2R5OiBzdHJpbmcsXG4pOiBQYXJzZWRTdGFnZVRpbWluZ3MgfCB1bmRlZmluZWQge1xuICBjb25zdCBtYXRjaCA9IFRJTUlOR1NfTElORS5leGVjKGJvZHkpO1xuICBpZiAobWF0Y2ggPT09IG51bGwpIHJldHVybiB1bmRlZmluZWQ7XG5cbiAgY29uc3QgaG9zdCA9IChtYXRjaFsxXSA/PyBcIlwiKS50cmltKCk7XG4gIGNvbnN0IHRpbWluZ3M6IE1lcmdlRmFsbGJhY2tTdGFnZVRpbWluZ1tdID0gW107XG4gIGZvciAoY29uc3Qgc2VnbWVudCBvZiAobWF0Y2hbMl0gPz8gXCJcIikuc3BsaXQoXCLCt1wiKSkge1xuICAgIGNvbnN0IHRleHQgPSBzZWdtZW50LnRyaW0oKTtcbiAgICBpZiAodGV4dC5sZW5ndGggPT09IDApIGNvbnRpbnVlO1xuICAgIGNvbnN0IHRpbWVkID0gU1RBR0VfU0VDT05EUy5leGVjKHRleHQpO1xuICAgIGlmICh0aW1lZCAhPT0gbnVsbCkge1xuICAgICAgdGltaW5ncy5wdXNoKHsgc3RhZ2U6IHRpbWVkWzFdIGFzIHN0cmluZywgc2Vjb25kczogTnVtYmVyKHRpbWVkWzJdKSB9KTtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBjb25zdCB1bmZpbmlzaGVkID0gU1RBR0VfVU5GSU5JU0hFRC5leGVjKHRleHQpO1xuICAgIGlmICh1bmZpbmlzaGVkICE9PSBudWxsKSB7XG4gICAgICAvLyBgbnVsbGAgc2Vjb25kcyByZW5kZXJzIGFzIGB1bmZpbmlzaGVkYCwgd2hpY2ggaXMgdGhlIHdob2xlIHBvaW50IG9mXG4gICAgICAvLyB0aGUgc3RhZ2UgdGhhdCBkaWVkOiBhbiBpbnZlbnRlZCBkdXJhdGlvbiB3b3VsZCBoaWRlIGl0LlxuICAgICAgdGltaW5ncy5wdXNoKHsgc3RhZ2U6IHVuZmluaXNoZWRbMV0gYXMgc3RyaW5nLCBzZWNvbmRzOiBudWxsIH0pO1xuICAgIH1cbiAgICAvLyBBbnl0aGluZyBlbHNlIGlzIHRoZSByZW5kZXJlcidzIG93biBcIm5vIHN0YWdlIHdhcyB0aW1lZFwiLCBvciB0ZXh0IGFcbiAgICAvLyBsYXRlciB2ZXJzaW9uIGFkZGVkLiBJdCBpcyBub3QgYSBzdGFnZSwgc28gaXQgcmVjb3JkcyBub25lLlxuICB9XG4gIHJldHVybiB7IC4uLihob3N0Lmxlbmd0aCA+IDAgPyB7IGhvc3QgfSA6IHt9KSwgdGltaW5ncyB9O1xufVxuXG4vKiogSG93IGZhciB0aGUgaGVhZCBoYWQgZmFsbGVuIGJlaGluZCBpdHMgYmFzZSwgYW5kIHNpbmNlIHdoZW4uICovXG5leHBvcnQgaW50ZXJmYWNlIFByRGl2ZXJnZW5jZSB7XG4gIC8qKiBDb21taXRzIHRoZSBiYXNlIGhhZCB0aGF0IHRoZSBoZWFkIGRpZCBub3QuICovXG4gIGJlaGluZEJ5PzogbnVtYmVyO1xuICAvKiogSVNPIHRpbWVzdGFtcCB0aGUgYG1lcmdlLWNvbmZsaWN0YCBsYWJlbCBsYXN0IHdlbnQgb24uICovXG4gIGJlaGluZFNpbmNlPzogc3RyaW5nO1xufVxuXG4vKiogSW5wdXRzIGZvciB7QGxpbmsgcmVhZFByRGl2ZXJnZW5jZX0uICovXG5leHBvcnQgaW50ZXJmYWNlIFJlYWRQckRpdmVyZ2VuY2VPcHRpb25zIHtcbiAgcmVwbzogc3RyaW5nO1xuICBwck51bWJlcjogbnVtYmVyO1xuICAvKiogVGhlIGJhc2UgYnJhbmNoIHRoZSBQUiB0YXJnZXRzLiAqL1xuICBiYXNlQnJhbmNoOiBzdHJpbmc7XG4gIC8qKiBUaGUgUFIncyBoZWFkIGJyYW5jaC4gKi9cbiAgaGVhZEJyYW5jaDogc3RyaW5nO1xuICAvKiogVGhlIHF1ZXVlIGxhYmVsIHdob3NlIGBsYWJlbGVkYCBldmVudCBkYXRlcyB0aGUgZGl2ZXJnZW5jZS4gKi9cbiAgcXVldWVMYWJlbDogc3RyaW5nO1xuICBnaDogKGFyZ3M6IHN0cmluZ1tdKSA9PiBQcm9taXNlPHN0cmluZz47XG4gIGxvZ2dlcj86IExvZ2dlcjtcbn1cblxuLyoqXG4gKiBSZWFkIGhvdyBmYXIgYmVoaW5kIHRoZSBiYXNlIGEgY29uZmxpY3RpbmcgaGVhZCB3YXMsIGFuZCBzaW5jZSB3aGVuLlxuICpcbiAqIE5ldmVyIHRocm93czogZWFjaCBvZiB0aGUgdHdvIHJlYWRzIGlzIGluZGVwZW5kZW50LCBhbmQgYSBmYWlsdXJlIGluIGVpdGhlclxuICogbGVhdmVzIGl0cyBmaWVsZCB1bnJlY29yZGVkIHJhdGhlciB0aGFuIGNvc3RpbmcgdGhlIGZsYWcgaXNzdWUgdGhlIG90aGVyLlxuICpcbiAqIEByZXR1cm5zIFRoZSBmaWVsZHMgdGhhdCBjb3VsZCBiZSByZWFkOyBhbiBlbXB0eSBvYmplY3Qgd2hlbiBuZWl0aGVyIGNvdWxkXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiByZWFkUHJEaXZlcmdlbmNlKFxuICBvcHRpb25zOiBSZWFkUHJEaXZlcmdlbmNlT3B0aW9ucyxcbik6IFByb21pc2U8UHJEaXZlcmdlbmNlPiB7XG4gIGNvbnN0IHsgcmVwbywgcHJOdW1iZXIsIGJhc2VCcmFuY2gsIGhlYWRCcmFuY2gsIGdoLCBsb2dnZXIgfSA9IG9wdGlvbnM7XG4gIGNvbnN0IGRpdmVyZ2VuY2U6IFByRGl2ZXJnZW5jZSA9IHt9O1xuICBjb25zdCB3YXJuID0gKG1lc3NhZ2U6IHN0cmluZywgZXJyb3I6IHVua25vd24pID0+IHtcbiAgICBsb2dnZXI/Lndhcm4/LihtZXNzYWdlLCB7XG4gICAgICByZXBvLFxuICAgICAgcHJOdW1iZXIsXG4gICAgICBlcnJvcjogZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiBTdHJpbmcoZXJyb3IpLFxuICAgIH0pO1xuICB9O1xuXG4gIGlmIChpc1NhZmVSZWYoYmFzZUJyYW5jaCkgJiYgaXNTYWZlUmVmKGhlYWRCcmFuY2gpKSB7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHJhdyA9IGF3YWl0IGdoKFtcbiAgICAgICAgXCJhcGlcIixcbiAgICAgICAgYHJlcG9zLyR7cmVwb30vY29tcGFyZS8ke2Jhc2VCcmFuY2h9Li4uJHtoZWFkQnJhbmNofWAsXG4gICAgICAgIFwiLS1qcVwiLFxuICAgICAgICBcIi5iZWhpbmRfYnlcIixcbiAgICAgIF0pO1xuICAgICAgY29uc3QgYmVoaW5kQnkgPSBOdW1iZXIocmF3LnRyaW0oKSk7XG4gICAgICBpZiAoTnVtYmVyLmlzU2FmZUludGVnZXIoYmVoaW5kQnkpICYmIGJlaGluZEJ5ID49IDApIHtcbiAgICAgICAgZGl2ZXJnZW5jZS5iZWhpbmRCeSA9IGJlaGluZEJ5O1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgd2FybihcbiAgICAgICAgICBcIkNvbmZsaWN0IGZhbGxiYWNrOiB0aGUgY29tcGFyZSBBUEkgcmVwb3J0ZWQgbm8gdXNhYmxlIGBiZWhpbmRfYnlgXCIsXG4gICAgICAgICAgbmV3IEVycm9yKGByZWFkICR7SlNPTi5zdHJpbmdpZnkocmF3LnRyaW0oKSl9YCksXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgIHdhcm4oXG4gICAgICAgIFwiQ29uZmxpY3QgZmFsbGJhY2s6IGNvdWxkIG5vdCBjb21wYXJlIHRoZSBoZWFkIHdpdGggaXRzIGJhc2VcIixcbiAgICAgICAgZXJyb3IsXG4gICAgICApO1xuICAgIH1cbiAgfSBlbHNlIHtcbiAgICB3YXJuKFxuICAgICAgXCJDb25mbGljdCBmYWxsYmFjazogcmVmdXNpbmcgdG8gY29tcGFyZSBhbiB1bnVzYWJsZSByZWZcIixcbiAgICAgIG5ldyBFcnJvcihgYmFzZT0ke2Jhc2VCcmFuY2h9IGhlYWQ9JHtoZWFkQnJhbmNofWApLFxuICAgICk7XG4gIH1cblxuICB0cnkge1xuICAgIGNvbnN0IGxhc3RBZGQgPSBhd2FpdCBnZXRMYWJlbExhc3RBZGRJbmZvQ29tcGxldGUoXG4gICAgICByZXBvLFxuICAgICAgcHJOdW1iZXIsXG4gICAgICBvcHRpb25zLnF1ZXVlTGFiZWwsXG4gICAgICBnaCxcbiAgICApO1xuICAgIGlmIChsYXN0QWRkICE9PSBudWxsKSB7XG4gICAgICBkaXZlcmdlbmNlLmJlaGluZFNpbmNlID0gbmV3IERhdGUobGFzdEFkZC5hZGRlZEF0ICogMTAwMCkudG9JU09TdHJpbmcoKTtcbiAgICB9IGVsc2Uge1xuICAgICAgd2FybihcbiAgICAgICAgYENvbmZsaWN0IGZhbGxiYWNrOiBubyBcXGBsYWJlbGVkXFxgIGV2ZW50IGZvciBcXGAke29wdGlvbnMucXVldWVMYWJlbH1cXGBgICtcbiAgICAgICAgICBcIiDigJQgdGhlIGZsYWcgY2Fubm90IHNheSBzaW5jZSB3aGVuXCIsXG4gICAgICAgIG5ldyBFcnJvcihcIm5vIHRpbWVsaW5lIGV2ZW50XCIpLFxuICAgICAgKTtcbiAgICB9XG4gIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgd2FybihcIkNvbmZsaWN0IGZhbGxiYWNrOiBjb3VsZCBub3QgcmVhZCB0aGUgbGFiZWwgdGltZWxpbmVcIiwgZXJyb3IpO1xuICB9XG5cbiAgcmV0dXJuIGRpdmVyZ2VuY2U7XG59XG5cbi8qKiBXaGF0IGFuIGFiYW5kb25lZCBQUiBjaGFuZ2VkLCBib3VuZGVkIGZvciBvbmUgaXNzdWUgYm9keS4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgUHJEaWZmU3VtbWFyeSB7XG4gIC8qKiBVcCB0byB7QGxpbmsgTUFYX0RJRkZfU1VNTUFSWV9QQVRIU30gcGF0aHMsIGFzIEdpdEh1YiBsaXN0ZWQgdGhlbS4gKi9cbiAgZmlsZXM6IE1lcmdlRmFsbGJhY2tEaWZmRmlsZVtdO1xuICAvKiogUGF0aHMgYmV5b25kIHRoZSBjYXAsIGNvdW50ZWQgcmF0aGVyIHRoYW4gZHJvcHBlZCBpbiBzaWxlbmNlLiAqL1xuICBvbWl0dGVkOiBudW1iZXI7XG59XG5cbi8qKiBJbnB1dHMgZm9yIHtAbGluayByZWFkUHJEaWZmU3VtbWFyeX0uICovXG5leHBvcnQgaW50ZXJmYWNlIFJlYWRQckRpZmZTdW1tYXJ5T3B0aW9ucyB7XG4gIHJlcG86IHN0cmluZztcbiAgcHJOdW1iZXI6IG51bWJlcjtcbiAgZ2g6IChhcmdzOiBzdHJpbmdbXSkgPT4gUHJvbWlzZTxzdHJpbmc+O1xuICBsb2dnZXI/OiBMb2dnZXI7XG59XG5cbi8qKlxuICogUmVhZCB0aGUgYWJhbmRvbmVkIFBSJ3MgZGlmZiBzdW1tYXJ5IOKAlCBwYXRoLCBhZGRpdGlvbnMsIGRlbGV0aW9ucy5cbiAqXG4gKiBUaGlzIGlzIHdoYXQgbWFrZXMgYSBmbGFnIGlzc3VlIGEgcmUtZG8gaXRlbTogdGhlIFBSIGlzIGNsb3NlZCwgc28gdGhlXG4gKiBzdW1tYXJ5IGlzIHRoZSBvbmx5IHN0YXRlbWVudCBvZiB3aGF0IHRoZSB3b3JrIGFjdHVhbGx5IHRvdWNoZWQuXG4gKlxuICogQHJldHVybnMgVGhlIGNhcHBlZCBzdW1tYXJ5LCBvciBgdW5kZWZpbmVkYCB3aGVuIGl0IGNvdWxkIG5vdCBiZSByZWFkIOKAlFxuICogICB3aGljaCB0aGUgZmxhZyBib2R5IHJlbmRlcnMgYXMgYG5vdCByZWNvcmRlZGBcbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHJlYWRQckRpZmZTdW1tYXJ5KFxuICBvcHRpb25zOiBSZWFkUHJEaWZmU3VtbWFyeU9wdGlvbnMsXG4pOiBQcm9taXNlPFByRGlmZlN1bW1hcnkgfCB1bmRlZmluZWQ+IHtcbiAgY29uc3QgeyByZXBvLCBwck51bWJlciwgZ2gsIGxvZ2dlciB9ID0gb3B0aW9ucztcbiAgdHJ5IHtcbiAgICBjb25zdCByYXcgPSBhd2FpdCBnaChbXG4gICAgICBcInByXCIsXG4gICAgICBcInZpZXdcIixcbiAgICAgIFN0cmluZyhwck51bWJlciksXG4gICAgICBcIi0tcmVwb1wiLFxuICAgICAgcmVwbyxcbiAgICAgIFwiLS1qc29uXCIsXG4gICAgICBcImZpbGVzXCIsXG4gICAgXSk7XG4gICAgY29uc3QgcGFyc2VkOiB1bmtub3duID0gSlNPTi5wYXJzZShyYXcudHJpbSgpIHx8IFwie31cIik7XG4gICAgY29uc3QgbGlzdGVkID0gKHBhcnNlZCBhcyB7IGZpbGVzPzogdW5rbm93biB9KS5maWxlcztcbiAgICBpZiAoIUFycmF5LmlzQXJyYXkobGlzdGVkKSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFwidGhlIHJlc3BvbnNlIGNhcnJpZWQgbm8gYGZpbGVzYCBhcnJheVwiKTtcbiAgICB9XG4gICAgY29uc3QgZmlsZXM6IE1lcmdlRmFsbGJhY2tEaWZmRmlsZVtdID0gW107XG4gICAgbGV0IHNlZW4gPSAwO1xuICAgIGZvciAoY29uc3QgZW50cnkgb2YgbGlzdGVkKSB7XG4gICAgICBpZiAodHlwZW9mIGVudHJ5ICE9PSBcIm9iamVjdFwiIHx8IGVudHJ5ID09PSBudWxsKSBjb250aW51ZTtcbiAgICAgIGNvbnN0IGZpbGUgPSBlbnRyeSBhcyB7XG4gICAgICAgIHBhdGg/OiB1bmtub3duO1xuICAgICAgICBhZGRpdGlvbnM/OiB1bmtub3duO1xuICAgICAgICBkZWxldGlvbnM/OiB1bmtub3duO1xuICAgICAgfTtcbiAgICAgIGlmICh0eXBlb2YgZmlsZS5wYXRoICE9PSBcInN0cmluZ1wiIHx8IGZpbGUucGF0aC5sZW5ndGggPT09IDApIGNvbnRpbnVlO1xuICAgICAgc2VlbisrO1xuICAgICAgaWYgKGZpbGVzLmxlbmd0aCA+PSBNQVhfRElGRl9TVU1NQVJZX1BBVEhTKSBjb250aW51ZTtcbiAgICAgIGZpbGVzLnB1c2goe1xuICAgICAgICBwYXRoOiBmaWxlLnBhdGgsXG4gICAgICAgIGFkZGl0aW9uczogdHlwZW9mIGZpbGUuYWRkaXRpb25zID09PSBcIm51bWJlclwiID8gZmlsZS5hZGRpdGlvbnMgOiAwLFxuICAgICAgICBkZWxldGlvbnM6IHR5cGVvZiBmaWxlLmRlbGV0aW9ucyA9PT0gXCJudW1iZXJcIiA/IGZpbGUuZGVsZXRpb25zIDogMCxcbiAgICAgIH0pO1xuICAgIH1cbiAgICByZXR1cm4geyBmaWxlcywgb21pdHRlZDogc2VlbiAtIGZpbGVzLmxlbmd0aCB9O1xuICB9IGNhdGNoIChlcnJvcikge1xuICAgIGxvZ2dlcj8ud2Fybj8uKFxuICAgICAgXCJDb25mbGljdCBmYWxsYmFjazogY291bGQgbm90IHJlYWQgdGhlIFBSJ3MgZGlmZiBzdW1tYXJ5XCIsXG4gICAgICB7XG4gICAgICAgIHJlcG8sXG4gICAgICAgIHByTnVtYmVyLFxuICAgICAgICBlcnJvcjogZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiBTdHJpbmcoZXJyb3IpLFxuICAgICAgfSxcbiAgICApO1xuICAgIHJldHVybiB1bmRlZmluZWQ7XG4gIH1cbn1cblxuLyoqIFdoZXRoZXIgYSByZWYgaXMgc2FmZSB0byBpbnRlcnBvbGF0ZSBpbnRvIGFuIEFQSSBwYXRoLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGlzU2FmZVJlZihyZWY6IHN0cmluZyk6IGJvb2xlYW4ge1xuICByZXR1cm4gU0FGRV9SRUYudGVzdChyZWYpICYmICFyZWYuaW5jbHVkZXMoXCIuLlwiKTtcbn1cbiJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0NBd0JDLEdBR0QsU0FBUywyQkFBMkIsUUFBUSxtQkFBbUI7QUFNL0Q7Ozs7OztDQU1DLEdBQ0QsT0FBTyxNQUFNLHlCQUF5QixJQUFJO0FBRTFDOzs7Ozs7Q0FNQyxHQUNELE1BQU0sZUFBZTtBQUVyQixtQ0FBbUMsR0FDbkMsTUFBTSxnQkFBZ0I7QUFFdEIsaUVBQWlFLEdBQ2pFLE1BQU0sbUJBQW1CO0FBRXpCOzs7Ozs7O0NBT0MsR0FDRCxNQUFNLFdBQVc7QUFVakI7Ozs7Ozs7Q0FPQyxHQUNELE9BQU8sU0FBUyxzQkFDZCxJQUFZO0VBRVosTUFBTSxRQUFRLGFBQWEsSUFBSSxDQUFDO0VBQ2hDLElBQUksVUFBVSxNQUFNLE9BQU87RUFFM0IsTUFBTSxPQUFPLENBQUMsS0FBSyxDQUFDLEVBQUUsSUFBSSxFQUFFLEVBQUUsSUFB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
// denoCacheMetadata=14792055364488382125,4154051542057217994