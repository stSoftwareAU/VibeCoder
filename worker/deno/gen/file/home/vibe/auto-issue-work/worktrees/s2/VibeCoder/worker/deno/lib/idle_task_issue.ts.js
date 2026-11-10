/**
 * Idle-task issue dedup helper.
 *
 * The idle-task framework files a real GitHub issue carrying the
 * `idle-task` label whenever the worker has nothing else to do (parent
 * #1959). This module is the dedup gate that prevents two
 * simultaneously-idle workers from filing more than one idle-task issue
 * per repo — any open `idle-task` issue blocks further filing.
 *
 * Issue #2077: filed wrappers are now human-style — title and body
 * read like an issue a person would type, with no hidden
 * `<!-- idle-task: ... -->` marker. Dispatch matches issues to
 * templates by title (see `idle_task_claim_handler.ts`), so the marker
 * is no longer required. As a consequence, dedup is pure label-only:
 * any open `idle-task` issue in the repo counts as a hit, whether the
 * worker or a human filed it.
 *
 * The `idle-task-pending` label (Issue #2055) was retired alongside
 * the `requiresApproval` template flag — `idle-task` is already the
 * lowest priority in the queue, so a separate approval gate added
 * complexity without changing pickup behaviour.
 *
 * Australian English spelling used throughout (behaviour,
 * organisation, etc.).
 */ import { runGhCommand } from "./github.ts";
// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
/** Label every filed idle-task issue carries. */ export const IDLE_TASK_LABEL = "idle-task";
// ---------------------------------------------------------------------------
// Dedup query
// ---------------------------------------------------------------------------
/**
 * Parses the JSON printed by
 * `gh issue list --label idle-task --state open --json number[,title],url` into the
 * well-formed entries it holds (Issue #2750). Shared so every open-idle-task
 * gate reads that payload the same way.
 *
 * Fails closed: output that is not JSON, or JSON that is not an array, throws
 * with `repo` in the message rather than reading as "no open issue". Entries
 * lacking a numeric `number` or string `url` are skipped. A string `title` is
 * kept when the query asked for it (Issue #2752).
 */ export function parseOpenIdleTaskIssues(raw, repo) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`open idle-task lookup for ${repo} returned non-JSON output: ${message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`open idle-task lookup for ${repo} returned a non-array JSON value`);
  }
  const issues = [];
  for (const entry of parsed){
    if (entry === null || typeof entry !== "object") continue;
    const r = entry;
    if (typeof r.number !== "number" || typeof r.url !== "string") continue;
    issues.push(typeof r.title === "string" ? {
      number: r.number,
      url: r.url,
      title: r.title
    } : {
      number: r.number,
      url: r.url
    });
  }
  return issues;
}
/**
 * Returns the first open `idle-task` issue in `opts.repo`, or null when
 * there is none. Any open `idle-task`-labelled issue blocks further
 * idle-task filing — there is no per-template dedup, and no marker is
 * required (Issue #2077).
 *
 * Throws when `gh` fails or prints malformed output (Issue #2750): only a
 * well-formed empty list means "no open issue".
 */ export async function findExistingIdleTaskIssue(opts) {
  const gh = opts.ghCommandFn ?? runGhCommand;
  const raw = await gh([
    "issue",
    "list",
    "--repo",
    opts.repo,
    "--label",
    IDLE_TASK_LABEL,
    "--state",
    "open",
    "--json",
    "number,url",
    "--limit",
    "200"
  ]);
  return parseOpenIdleTaskIssues(raw, opts.repo)[0] ?? null;
}
/**
 * Shared scan behind {@link findOpenIdleTaskWrappers} and
 * {@link findAnyOpenIdleTaskWrapper}.
 *
 * Per-repo lookup failures are logged via `warn` and reported in
 * `failedRepos` (Issue #2750): the failing repo's state is unknown, so it is
 * never treated as clean. The scan still continues, so one repo's hiccup does
 * not hide the state of the others.
 */ async function scanForOpenIdleTaskWrappers(repos, opts, stopAtFirst) {
  const gh = opts.ghCommandFn ?? runGhCommand;
  const warn = opts.warn ?? ((m)=>console.warn(m));
  const found = [];
  const failedRepos = [];
  for (const repo of repos){
    let existing;
    try {
      existing = await findExistingIdleTaskIssue({
        repo,
        ghCommandFn: gh
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      warn(`[idle-task] repo=${repo} action=warn reason=cross_repo_check_failed message=${message}`);
      failedRepos.push(repo);
      continue;
    }
    if (existing !== null) {
      found.push({
        repo,
        number: existing.number,
        url: existing.url
      });
      if (stopAtFirst) break;
    }
  }
  return {
    wrappers: found,
    failedRepos
  };
}
/**
 * Per-repo wrapper census (Issue #1083). Scans every repo in `repos` and
 * returns one entry for **each** repo already holding an open
 * `idle-task`-labelled issue, in caller order, plus every repo whose lookup
 * failed (`failedRepos`, Issue #2750). Only a repo in neither list is clean.
 *
 * The filer subtracts this from the monitored set rather than short-circuiting
 * on it: the operator's concurrency rule is *one issue in flight per work
 * stream*, and applied to idle work that reads "at most one open wrapper **per
 * repository**". The previous fleet-wide maximum of one (Issue #2092) was a
 * far stronger constraint than the rule asks for, and it capped the fleet at a
 * single filled idle slot however many empty repositories were available:
 * measured live at four Vibe Coders, eight slots, two issues in flight and
 * exactly one idle task (Issue #1083).
 *
 * #2089's protection is kept, because its fault was **fan-out from a
 * shuffle** rather than plurality: a repository still never accumulates two
 * open wrappers (this census excludes it), and a single idle tick still files
 * at most one wrapper, so the next tick re-decides from fresh state.
 */ export function findOpenIdleTaskWrappers(repos, opts = {}) {
  return scanForOpenIdleTaskWrappers(repos, opts, false);
}
/**
 * Cross-repo dedup query (Issue #2092). Returns the first open
 * `idle-task`-labelled issue found anywhere in `repos`, or `null` when the
 * entire set is confirmed clean. Throws when no wrapper was found but at least
 * one repo's lookup failed (Issue #2750) — an unknown repo is never clean. The
 * first match in caller order wins — the result is deterministic for a fixed
 * input list, and the scan stops at it.
 *
 * This answers "does the monitored set hold **any** wrapper?". It is no
 * longer what gates filing — see {@link findOpenIdleTaskWrappers} for why —
 * and remains for callers that only need existence, at one `gh` call rather
 * than one per repository.
 */ export async function findAnyOpenIdleTaskWrapper(repos, opts = {}) {
  const census = await scanForOpenIdleTaskWrappers(repos, opts, true);
  const first = census.wrappers[0];
  if (first !== undefined) return first;
  if (census.failedRepos.length > 0) {
    throw new Error(`open idle-task lookup failed for: ${census.failedRepos.join(", ")}`);
  }
  return null;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9pZGxlX3Rhc2tfaXNzdWUudHMiXSwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBJZGxlLXRhc2sgaXNzdWUgZGVkdXAgaGVscGVyLlxuICpcbiAqIFRoZSBpZGxlLXRhc2sgZnJhbWV3b3JrIGZpbGVzIGEgcmVhbCBHaXRIdWIgaXNzdWUgY2FycnlpbmcgdGhlXG4gKiBgaWRsZS10YXNrYCBsYWJlbCB3aGVuZXZlciB0aGUgd29ya2VyIGhhcyBub3RoaW5nIGVsc2UgdG8gZG8gKHBhcmVudFxuICogIzE5NTkpLiBUaGlzIG1vZHVsZSBpcyB0aGUgZGVkdXAgZ2F0ZSB0aGF0IHByZXZlbnRzIHR3b1xuICogc2ltdWx0YW5lb3VzbHktaWRsZSB3b3JrZXJzIGZyb20gZmlsaW5nIG1vcmUgdGhhbiBvbmUgaWRsZS10YXNrIGlzc3VlXG4gKiBwZXIgcmVwbyDigJQgYW55IG9wZW4gYGlkbGUtdGFza2AgaXNzdWUgYmxvY2tzIGZ1cnRoZXIgZmlsaW5nLlxuICpcbiAqIElzc3VlICMyMDc3OiBmaWxlZCB3cmFwcGVycyBhcmUgbm93IGh1bWFuLXN0eWxlIOKAlCB0aXRsZSBhbmQgYm9keVxuICogcmVhZCBsaWtlIGFuIGlzc3VlIGEgcGVyc29uIHdvdWxkIHR5cGUsIHdpdGggbm8gaGlkZGVuXG4gKiBgPCEtLSBpZGxlLXRhc2s6IC4uLiAtLT5gIG1hcmtlci4gRGlzcGF0Y2ggbWF0Y2hlcyBpc3N1ZXMgdG9cbiAqIHRlbXBsYXRlcyBieSB0aXRsZSAoc2VlIGBpZGxlX3Rhc2tfY2xhaW1faGFuZGxlci50c2ApLCBzbyB0aGUgbWFya2VyXG4gKiBpcyBubyBsb25nZXIgcmVxdWlyZWQuIEFzIGEgY29uc2VxdWVuY2UsIGRlZHVwIGlzIHB1cmUgbGFiZWwtb25seTpcbiAqIGFueSBvcGVuIGBpZGxlLXRhc2tgIGlzc3VlIGluIHRoZSByZXBvIGNvdW50cyBhcyBhIGhpdCwgd2hldGhlciB0aGVcbiAqIHdvcmtlciBvciBhIGh1bWFuIGZpbGVkIGl0LlxuICpcbiAqIFRoZSBgaWRsZS10YXNrLXBlbmRpbmdgIGxhYmVsIChJc3N1ZSAjMjA1NSkgd2FzIHJldGlyZWQgYWxvbmdzaWRlXG4gKiB0aGUgYHJlcXVpcmVzQXBwcm92YWxgIHRlbXBsYXRlIGZsYWcg4oCUIGBpZGxlLXRhc2tgIGlzIGFscmVhZHkgdGhlXG4gKiBsb3dlc3QgcHJpb3JpdHkgaW4gdGhlIHF1ZXVlLCBzbyBhIHNlcGFyYXRlIGFwcHJvdmFsIGdhdGUgYWRkZWRcbiAqIGNvbXBsZXhpdHkgd2l0aG91dCBjaGFuZ2luZyBwaWNrdXAgYmVoYXZpb3VyLlxuICpcbiAqIEF1c3RyYWxpYW4gRW5nbGlzaCBzcGVsbGluZyB1c2VkIHRocm91Z2hvdXQgKGJlaGF2aW91cixcbiAqIG9yZ2FuaXNhdGlvbiwgZXRjLikuXG4gKi9cblxuaW1wb3J0IHsgcnVuR2hDb21tYW5kIH0gZnJvbSBcIi4vZ2l0aHViLnRzXCI7XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gUHVibGljIHR5cGVzXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuZXhwb3J0IGludGVyZmFjZSBGaW5kRXhpc3RpbmdJZGxlVGFza09wdGlvbnMge1xuICAvKiogVGFyZ2V0IHJlcG9zaXRvcnkgaW4gYG93bmVyL3JlcG9gIGZvcm0uICovXG4gIHJlcG86IHN0cmluZztcbiAgLyoqXG4gICAqIElkbGUtdGFzayB0ZW1wbGF0ZSBuYW1lIOKAlCBhY2NlcHRlZCBmb3IgYmFja3dhcmRzIGNvbXBhdGliaWxpdHkgYnV0XG4gICAqICoqaWdub3JlZCoqICgjMTk4NCkuIERlZHVwIGlzIGxhYmVsLW9ubHk6IGFueSBvcGVuIGBpZGxlLXRhc2tgXG4gICAqIGlzc3VlIGluIGByZXBvYCBibG9ja3MgZnVydGhlciBmaWxpbmcuXG4gICAqL1xuICB0ZW1wbGF0ZT86IHN0cmluZztcbiAgLyoqIEluamVjdGFibGUgZ2ggcnVubmVyIOKAlCBkZWZhdWx0cyB0byB0aGUgcHJvZHVjdGlvbiByZXRyeSB3cmFwcGVyLiAqL1xuICBnaENvbW1hbmRGbj86IChhcmdzOiBzdHJpbmdbXSkgPT4gUHJvbWlzZTxzdHJpbmc+O1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIEV4aXN0aW5nSWRsZVRhc2tJc3N1ZSB7XG4gIG51bWJlcjogbnVtYmVyO1xuICB1cmw6IHN0cmluZztcbiAgLyoqIFByZXNlbnQgd2hlbiB0aGUgbG9va3VwIGFza2VkIGZvciBgdGl0bGVgIGFuZCBnaCByZXR1cm5lZCBhIHN0cmluZy4gKi9cbiAgdGl0bGU/OiBzdHJpbmc7XG59XG5cbi8qKlxuICogUmVzdWx0IG9mIHRoZSBwZXItcmVwbyB3cmFwcGVyIGNlbnN1cyAoSXNzdWVzICMxMDgzLCAjMjc1MCkuIGB3cmFwcGVyc2BcbiAqIGxpc3RzIHRoZSByZXBvcyBjb25maXJtZWQgdG8gaG9sZCBhbiBvcGVuIGBpZGxlLXRhc2tgIGlzc3VlOyBgZmFpbGVkUmVwb3NgXG4gKiBsaXN0cyB0aGUgcmVwb3Mgd2hvc2UgbG9va3VwIGZhaWxlZCwgaW4gY2FsbGVyIG9yZGVyLiBBIGZhaWxlZCByZXBvIGlzXG4gKiB1bmtub3duLCBuZXZlciBjbGVhbiDigJQgY2FsbGVycyBtdXN0IG5vdCBmaWxlIGludG8gaXQuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgSWRsZVRhc2tXcmFwcGVyQ2Vuc3VzIHtcbiAgd3JhcHBlcnM6IEV4aXN0aW5nSWRsZVRhc2tXcmFwcGVyW107XG4gIGZhaWxlZFJlcG9zOiBzdHJpbmdbXTtcbn1cblxuLyoqIENyb3NzLXJlcG8gbG9va3VwIHJlc3VsdCAoIzIwOTIpLiAqL1xuZXhwb3J0IGludGVyZmFjZSBFeGlzdGluZ0lkbGVUYXNrV3JhcHBlciB7XG4gIC8qKiBSZXBvc2l0b3J5IHdoZXJlIHRoZSBvcGVuIGBpZGxlLXRhc2tgIHdyYXBwZXIgd2FzIGZvdW5kLiAqL1xuICByZXBvOiBzdHJpbmc7XG4gIG51bWJlcjogbnVtYmVyO1xuICB1cmw6IHN0cmluZztcbn1cblxuZXhwb3J0IGludGVyZmFjZSBGaW5kQW55T3BlbklkbGVUYXNrT3B0aW9ucyB7XG4gIC8qKiBJbmplY3RhYmxlIGdoIHJ1bm5lciDigJQgZGVmYXVsdHMgdG8gdGhlIHByb2R1Y3Rpb24gcmV0cnkgd3JhcHBlci4gKi9cbiAgZ2hDb21tYW5kRm4/OiAoYXJnczogc3RyaW5nW10pID0+IFByb21pc2U8c3RyaW5nPjtcbiAgLyoqXG4gICAqIE9wdGlvbmFsIHdhcm5pbmcgc2luayBmb3IgcGVyLXJlcG8gYGdoYCBmYWlsdXJlcy4gRGVmYXVsdHMgdG9cbiAgICogYGNvbnNvbGUud2FybmAuIFdoZW4gYSBzaW5nbGUgcmVwbyBsb29rdXAgZmFpbHMgdGhlIHNjYW4gY29udGludWVzXG4gICAqIHdpdGggdGhlIHJlbWFpbmluZyByZXBvcyBhbmQgdGhlIGZhaWxlZCByZXBvIGlzIHJlcG9ydGVkIGluXG4gICAqIGBmYWlsZWRSZXBvc2Ag4oCUIGl0cyBzdGF0ZSBpcyB1bmtub3duLCBzbyBpdCBpcyBuZXZlciB0cmVhdGVkIGFzIGNsZWFuXG4gICAqIChmYWlsIGNsb3NlZCwgSXNzdWUgIzI3NTApLlxuICAgKi9cbiAgd2Fybj86IChtZXNzYWdlOiBzdHJpbmcpID0+IHZvaWQ7XG59XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gQ29uc3RhbnRzXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuLyoqIExhYmVsIGV2ZXJ5IGZpbGVkIGlkbGUtdGFzayBpc3N1ZSBjYXJyaWVzLiAqL1xuZXhwb3J0IGNvbnN0IElETEVfVEFTS19MQUJFTCA9IFwiaWRsZS10YXNrXCI7XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gRGVkdXAgcXVlcnlcbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG4vKipcbiAqIFBhcnNlcyB0aGUgSlNPTiBwcmludGVkIGJ5XG4gKiBgZ2ggaXNzdWUgbGlzdCAtLWxhYmVsIGlkbGUtdGFzayAtLXN0YXRlIG9wZW4gLS1qc29uIG51bWJlclssdGl0bGVdLHVybGAgaW50byB0aGVcbiAqIHdlbGwtZm9ybWVkIGVudHJpZXMgaXQgaG9sZHMgKElzc3VlICMyNzUwKS4gU2hhcmVkIHNvIGV2ZXJ5IG9wZW4taWRsZS10YXNrXG4gKiBnYXRlIHJlYWRzIHRoYXQgcGF5bG9hZCB0aGUgc2FtZSB3YXkuXG4gKlxuICogRmFpbHMgY2xvc2VkOiBvdXRwdXQgdGhhdCBpcyBub3QgSlNPTiwgb3IgSlNPTiB0aGF0IGlzIG5vdCBhbiBhcnJheSwgdGhyb3dzXG4gKiB3aXRoIGByZXBvYCBpbiB0aGUgbWVzc2FnZSByYXRoZXIgdGhhbiByZWFkaW5nIGFzIFwibm8gb3BlbiBpc3N1ZVwiLiBFbnRyaWVzXG4gKiBsYWNraW5nIGEgbnVtZXJpYyBgbnVtYmVyYCBvciBzdHJpbmcgYHVybGAgYXJlIHNraXBwZWQuIEEgc3RyaW5nIGB0aXRsZWAgaXNcbiAqIGtlcHQgd2hlbiB0aGUgcXVlcnkgYXNrZWQgZm9yIGl0IChJc3N1ZSAjMjc1MikuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBwYXJzZU9wZW5JZGxlVGFza0lzc3VlcyhcbiAgcmF3OiBzdHJpbmcsXG4gIHJlcG86IHN0cmluZyxcbik6IEV4aXN0aW5nSWRsZVRhc2tJc3N1ZVtdIHtcbiAgbGV0IHBhcnNlZDogdW5rbm93bjtcbiAgdHJ5IHtcbiAgICBwYXJzZWQgPSBKU09OLnBhcnNlKHJhdyk7XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIGNvbnN0IG1lc3NhZ2UgPSBlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVycik7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgYG9wZW4gaWRsZS10YXNrIGxvb2t1cCBmb3IgJHtyZXBvfSByZXR1cm5lZCBub24tSlNPTiBvdXRwdXQ6ICR7bWVzc2FnZX1gLFxuICAgICk7XG4gIH1cbiAgaWYgKCFBcnJheS5pc0FycmF5KHBhcnNlZCkpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBgb3BlbiBpZGxlLXRhc2sgbG9va3VwIGZvciAke3JlcG99IHJldHVybmVkIGEgbm9uLWFycmF5IEpTT04gdmFsdWVgLFxuICAgICk7XG4gIH1cblxuICBjb25zdCBpc3N1ZXM6IEV4aXN0aW5nSWRsZVRhc2tJc3N1ZVtdID0gW107XG4gIGZvciAoY29uc3QgZW50cnkgb2YgcGFyc2VkKSB7XG4gICAgaWYgKGVudHJ5ID09PSBudWxsIHx8IHR5cGVvZiBlbnRyeSAhPT0gXCJvYmplY3RcIikgY29udGludWU7XG4gICAgY29uc3QgciA9IGVudHJ5IGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuICAgIGlmICh0eXBlb2Ygci5udW1iZXIgIT09IFwibnVtYmVyXCIgfHwgdHlwZW9mIHIudXJsICE9PSBcInN0cmluZ1wiKSBjb250aW51ZTtcbiAgICBpc3N1ZXMucHVzaChcbiAgICAgIHR5cGVvZiByLnRpdGxlID09PSBcInN0cmluZ1wiXG4gICAgICAgID8geyBudW1iZXI6IHIubnVtYmVyLCB1cmw6IHIudXJsLCB0aXRsZTogci50aXRsZSB9XG4gICAgICAgIDogeyBudW1iZXI6IHIubnVtYmVyLCB1cmw6IHIudXJsIH0sXG4gICAgKTtcbiAgfVxuICByZXR1cm4gaXNzdWVzO1xufVxuXG4vKipcbiAqIFJldHVybnMgdGhlIGZpcnN0IG9wZW4gYGlkbGUtdGFza2AgaXNzdWUgaW4gYG9wdHMucmVwb2AsIG9yIG51bGwgd2hlblxuICogdGhlcmUgaXMgbm9uZS4gQW55IG9wZW4gYGlkbGUtdGFza2AtbGFiZWxsZWQgaXNzdWUgYmxvY2tzIGZ1cnRoZXJcbiAqIGlkbGUtdGFzayBmaWxpbmcg4oCUIHRoZXJlIGlzIG5vIHBlci10ZW1wbGF0ZSBkZWR1cCwgYW5kIG5vIG1hcmtlciBpc1xuICogcmVxdWlyZWQgKElzc3VlICMyMDc3KS5cbiAqXG4gKiBUaHJvd3Mgd2hlbiBgZ2hgIGZhaWxzIG9yIHByaW50cyBtYWxmb3JtZWQgb3V0cHV0IChJc3N1ZSAjMjc1MCk6IG9ubHkgYVxuICogd2VsbC1mb3JtZWQgZW1wdHkgbGlzdCBtZWFucyBcIm5vIG9wZW4gaXNzdWVcIi5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGZpbmRFeGlzdGluZ0lkbGVUYXNrSXNzdWUoXG4gIG9wdHM6IEZpbmRFeGlzdGluZ0lkbGVUYXNrT3B0aW9ucyxcbik6IFByb21pc2U8RXhpc3RpbmdJZGxlVGFza0lzc3VlIHwgbnVsbD4ge1xuICBjb25zdCBnaCA9IG9wdHMuZ2hDb21tYW5kRm4gPz8gcnVuR2hDb21tYW5kO1xuICBjb25zdCByYXcgPSBhd2FpdCBnaChbXG4gICAgXCJpc3N1ZVwiLFxuICAgIFwibGlzdFwiLFxuICAgIFwiLS1yZXBvXCIsXG4gICAgb3B0cy5yZXBvLFxuICAgIFwiLS1sYWJlbFwiLFxuICAgIElETEVfVEFTS19MQUJFTCxcbiAgICBcIi0tc3RhdGVcIixcbiAgICBcIm9wZW5cIixcbiAgICBcIi0tanNvblwiLFxuICAgIFwibnVtYmVyLHVybFwiLFxuICAgIFwiLS1saW1pdFwiLFxuICAgIFwiMjAwXCIsXG4gIF0pO1xuICByZXR1cm4gcGFyc2VPcGVuSWRsZVRhc2tJc3N1ZXMocmF3LCBvcHRzLnJlcG8pWzBdID8/IG51bGw7XG59XG5cbi8qKlxuICogU2hhcmVkIHNjYW4gYmVoaW5kIHtAbGluayBmaW5kT3BlbklkbGVUYXNrV3JhcHBlcnN9IGFuZFxuICoge0BsaW5rIGZpbmRBbnlPcGVuSWRsZVRhc2tXcmFwcGVyfS5cbiAqXG4gKiBQZXItcmVwbyBsb29rdXAgZmFpbHVyZXMgYXJlIGxvZ2dlZCB2aWEgYHdhcm5gIGFuZCByZXBvcnRlZCBpblxuICogYGZhaWxlZFJlcG9zYCAoSXNzdWUgIzI3NTApOiB0aGUgZmFpbGluZyByZXBvJ3Mgc3RhdGUgaXMgdW5rbm93biwgc28gaXQgaXNcbiAqIG5ldmVyIHRyZWF0ZWQgYXMgY2xlYW4uIFRoZSBzY2FuIHN0aWxsIGNvbnRpbnVlcywgc28gb25lIHJlcG8ncyBoaWNjdXAgZG9lc1xuICogbm90IGhpZGUgdGhlIHN0YXRlIG9mIHRoZSBvdGhlcnMuXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIHNjYW5Gb3JPcGVuSWRsZVRhc2tXcmFwcGVycyhcbiAgcmVwb3M6IHJlYWRvbmx5IHN0cmluZ1tdLFxuICBvcHRzOiBGaW5kQW55T3BlbklkbGVUYXNrT3B0aW9ucyxcbiAgc3RvcEF0Rmlyc3Q6IGJvb2xlYW4sXG4pOiBQcm9taXNlPElkbGVUYXNrV3JhcHBlckNlbnN1cz4ge1xuICBjb25zdCBnaCA9IG9wdHMuZ2hDb21tYW5kRm4gPz8gcnVuR2hDb21tYW5kO1xuICBjb25zdCB3YXJuID0gb3B0cy53YXJuID8/ICgobTogc3RyaW5nKSA9PiBjb25zb2xlLndhcm4obSkpO1xuICBjb25zdCBmb3VuZDogRXhpc3RpbmdJZGxlVGFza1dyYXBwZXJbXSA9IFtdO1xuICBjb25zdCBmYWlsZWRSZXBvczogc3RyaW5nW10gPSBbXTtcbiAgZm9yIChjb25zdCByZXBvIG9mIHJlcG9zKSB7XG4gICAgbGV0IGV4aXN0aW5nOiBFeGlzdGluZ0lkbGVUYXNrSXNzdWUgfCBudWxsO1xuICAgIHRyeSB7XG4gICAgICBleGlzdGluZyA9IGF3YWl0IGZpbmRFeGlzdGluZ0lkbGVUYXNrSXNzdWUoeyByZXBvLCBnaENvbW1hbmRGbjogZ2ggfSk7XG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICBjb25zdCBtZXNzYWdlID0gZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpO1xuICAgICAgd2FybihcbiAgICAgICAgYFtpZGxlLXRhc2tdIHJlcG89JHtyZXBvfSBhY3Rpb249d2FybiByZWFzb249Y3Jvc3NfcmVwb19jaGVja19mYWlsZWQgbWVzc2FnZT0ke21lc3NhZ2V9YCxcbiAgICAgICk7XG4gICAgICBmYWlsZWRSZXBvcy5wdXNoKHJlcG8pO1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGlmIChleGlzdGluZyAhPT0gbnVsbCkge1xuICAgICAgZm91bmQucHVzaCh7IHJlcG8sIG51bWJlcjogZXhpc3RpbmcubnVtYmVyLCB1cmw6IGV4aXN0aW5nLnVybCB9KTtcbiAgICAgIGlmIChzdG9wQXRGaXJzdCkgYnJlYWs7XG4gICAgfVxuICB9XG4gIHJldHVybiB7IHdyYXBwZXJzOiBmb3VuZCwgZmFpbGVkUmVwb3MgfTtcbn1cblxuLyoqXG4gKiBQZXItcmVwbyB3cmFwcGVyIGNlbnN1cyAoSXNzdWUgIzEwODMpLiBTY2FucyBldmVyeSByZXBvIGluIGByZXBvc2AgYW5kXG4gKiByZXR1cm5zIG9uZSBlbnRyeSBmb3IgKiplYWNoKiogcmVwbyBhbHJlYWR5IGhvbGRpbmcgYW4gb3BlblxuICogYGlkbGUtdGFza2AtbGFiZWxsZWQgaXNzdWUsIGluIGNhbGxlciBvcmRlciwgcGx1cyBldmVyeSByZXBvIHdob3NlIGxvb2t1cFxuICogZmFpbGVkIChgZmFpbGVkUmVwb3NgLCBJc3N1ZSAjMjc1MCkuIE9ubHkgYSByZXBvIGluIG5laXRoZXIgbGlzdCBpcyBjbGVhbi5cbiAqXG4gKiBUaGUgZmlsZXIgc3VidHJhY3RzIHRoaXMgZnJvbSB0aGUgbW9uaXRvcmVkIHNldCByYXRoZXIgdGhhbiBzaG9ydC1jaXJjdWl0aW5nXG4gKiBvbiBpdDogdGhlIG9wZXJhdG9yJ3MgY29uY3VycmVuY3kgcnVsZSBpcyAqb25lIGlzc3VlIGluIGZsaWdodCBwZXIgd29ya1xuICogc3RyZWFtKiwgYW5kIGFwcGxpZWQgdG8gaWRsZSB3b3JrIHRoYXQgcmVhZHMgXCJhdCBtb3N0IG9uZSBvcGVuIHdyYXBwZXIgKipwZXJcbiAqIHJlcG9zaXRvcnkqKlwiLiBUaGUgcHJldmlvdXMgZmxlZXQtd2lkZSBtYXhpbXVtIG9mIG9uZSAoSXNzdWUgIzIwOTIpIHdhcyBhXG4gKiBmYXIgc3Ryb25nZXIgY29uc3RyYWludCB0aGFuIHRoZSBydWxlIGFza3MgZm9yLCBhbmQgaXQgY2FwcGVkIHRoZSBmbGVldCBhdCBhXG4gKiBzaW5nbGUgZmlsbGVkIGlkbGUgc2xvdCBob3dldmVyIG1hbnkgZW1wdHkgcmVwb3NpdG9yaWVzIHdlcmUgYXZhaWxhYmxlOlxuICogbWVhc3VyZWQgbGl2ZSBhdCBmb3VyIFZpYmUgQ29kZXJzLCBlaWdodCBzbG90cywgdHdvIGlzc3VlcyBpbiBmbGlnaHQgYW5kXG4gKiBleGFjdGx5IG9uZSBpZGxlIHRhc2sgKElzc3VlICMxMDgzKS5cbiAqXG4gKiAjMjA4OSdzIHByb3RlY3Rpb24gaXMga2VwdCwgYmVjYXVzZSBpdHMgZmF1bHQgd2FzICoqZmFuLW91dCBmcm9tIGFcbiAqIHNodWZmbGUqKiByYXRoZXIgdGhhbiBwbHVyYWxpdHk6IGEgcmVwb3NpdG9yeSBzdGlsbCBuZXZlciBhY2N1bXVsYXRlcyB0d29cbiAqIG9wZW4gd3JhcHBlcnMgKHRoaXMgY2Vuc3VzIGV4Y2x1ZGVzIGl0KSwgYW5kIGEgc2luZ2xlIGlkbGUgdGljayBzdGlsbCBmaWxlc1xuICogYXQgbW9zdCBvbmUgd3JhcHBlciwgc28gdGhlIG5leHQgdGljayByZS1kZWNpZGVzIGZyb20gZnJlc2ggc3RhdGUuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBmaW5kT3BlbklkbGVUYXNrV3JhcHBlcnMoXG4gIHJlcG9zOiByZWFkb25seSBzdHJpbmdbXSxcbiAgb3B0czogRmluZEFueU9wZW5JZGxlVGFza09wdGlvbnMgPSB7fSxcbik6IFByb21pc2U8SWRsZVRhc2tXcmFwcGVyQ2Vuc3VzPiB7XG4gIHJldHVybiBzY2FuRm9yT3BlbklkbGVUYXNrV3JhcHBlcnMocmVwb3MsIG9wdHMsIGZhbHNlKTtcbn1cblxuLyoqXG4gKiBDcm9zcy1yZXBvIGRlZHVwIHF1ZXJ5IChJc3N1ZSAjMjA5MikuIFJldHVybnMgdGhlIGZpcnN0IG9wZW5cbiAqIGBpZGxlLXRhc2tgLWxhYmVsbGVkIGlzc3VlIGZvdW5kIGFueXdoZXJlIGluIGByZXBvc2AsIG9yIGBudWxsYCB3aGVuIHRoZVxuICogZW50aXJlIHNldCBpcyBjb25maXJtZWQgY2xlYW4uIFRocm93cyB3aGVuIG5vIHdyYXBwZXIgd2FzIGZvdW5kIGJ1dCBhdCBsZWFzdFxuICogb25lIHJlcG8ncyBsb29rdXAgZmFpbGVkIChJc3N1ZSAjMjc1MCkg4oCUIGFuIHVua25vd24gcmVwbyBpcyBuZXZlciBjbGVhbi4gVGhlXG4gKiBmaXJzdCBtYXRjaCBpbiBjYWxsZXIgb3JkZXIgd2lucyDigJQgdGhlIHJlc3VsdCBpcyBkZXRlcm1pbmlzdGljIGZvciBhIGZpeGVkXG4gKiBpbnB1dCBsaXN0LCBhbmQgdGhlIHNjYW4gc3RvcHMgYXQgaXQuXG4gKlxuICogVGhpcyBhbnN3ZXJzIFwiZG9lcyB0aGUgbW9uaXRvcmVkIHNldCBob2xkICoqYW55Kiogd3JhcHBlcj9cIi4gSXQgaXMgbm9cbiAqIGxvbmdlciB3aGF0IGdhdGVzIGZpbGluZyDigJQgc2VlIHtAbGluayBmaW5kT3BlbklkbGVUYXNrV3JhcHBlcnN9IGZvciB3aHkg4oCUXG4gKiBhbmQgcmVtYWlucyBmb3IgY2FsbGVycyB0aGF0IG9ubHkgbmVlZCBleGlzdGVuY2UsIGF0IG9uZSBgZ2hgIGNhbGwgcmF0aGVyXG4gKiB0aGFuIG9uZSBwZXIgcmVwb3NpdG9yeS5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGZpbmRBbnlPcGVuSWRsZVRhc2tXcmFwcGVyKFxuICByZXBvczogcmVhZG9ubHkgc3RyaW5nW10sXG4gIG9wdHM6IEZpbmRBbnlPcGVuSWRsZVRhc2tPcHRpb25zID0ge30sXG4pOiBQcm9taXNlPEV4aXN0aW5nSWRsZVRhc2tXcmFwcGVyIHwgbnVsbD4ge1xuICBjb25zdCBjZW5zdXMgPSBhd2FpdCBzY2FuRm9yT3BlbklkbGVUYXNrV3JhcHBlcnMocmVwb3MsIG9wdHMsIHRydWUpO1xuICBjb25zdCBmaXJzdCA9IGNlbnN1cy53cmFwcGVyc1swXTtcbiAgaWYgKGZpcnN0ICE9PSB1bmRlZmluZWQpIHJldHVybiBmaXJzdDtcbiAgaWYgKGNlbnN1cy5mYWlsZWRSZXBvcy5sZW5ndGggPiAwKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgYG9wZW4gaWRsZS10YXNrIGxvb2t1cCBmYWlsZWQgZm9yOiAke2NlbnN1cy5mYWlsZWRSZXBvcy5qb2luKFwiLCBcIil9YCxcbiAgICApO1xuICB9XG4gIHJldHVybiBudWxsO1xufVxuIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Q0F3QkMsR0FFRCxTQUFTLFlBQVksUUFBUSxjQUFjO0FBMEQzQyw4RUFBOEU7QUFDOUUsWUFBWTtBQUNaLDhFQUE4RTtBQUU5RSwrQ0FBK0MsR0FDL0MsT0FBTyxNQUFNLGtCQUFrQixZQUFZO0FBRTNDLDhFQUE4RTtBQUM5RSxjQUFjO0FBQ2QsOEVBQThFO0FBRTlFOzs7Ozs7Ozs7O0NBVUMsR0FDRCxPQUFPLFNBQVMsd0JBQ2QsR0FBVyxFQUNYLElBQVk7RUFFWixJQUFJO0VBQ0osSUFBSTtJQUNGLFNBQVMsS0FBSyxLQUFLLENBQUM7RUFDdEIsRUFBRSxPQUFPLEtBQUs7SUFDWixNQUFNLFVBQVUsZUFBZSxRQUFRLElBQUksT0FBTyxHQUFHLE9BQU87SUFDNUQsTUFBTSxJQUFJLE1BQ1IsQ0FBQywwQkFBMEIsRUFBRSxLQUFLLDJCQUEyQixFQUFFLFNBQVM7RUFFNUU7RUFDQSxJQUFJLENBQUMsTUFBTSxPQUFPLENBQUMsU0FBUztJQUMxQixNQUFNLElBQUksTUFDUixDQUFDLDBCQUEwQixFQUFFLEtBQUssZ0NBQWdDLENBQUM7RUFFdkU7RUFFQSxNQUFNLFNB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
// denoCacheMetadata=9948902243916826854,14061308893197917335