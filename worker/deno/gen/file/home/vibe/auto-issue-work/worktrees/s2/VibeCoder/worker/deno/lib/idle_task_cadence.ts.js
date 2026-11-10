/**
 * Idle-task cadence policy — important vs busy work (Issues #4003, #4008).
 *
 * The steady-state filer picks one template for one repo at random per idle
 * tick (#2092), which is right for background work but leaves no floor under
 * the scans that actually matter. #4003 splits the registered templates in two:
 *
 *   - **important** — `security-scan`, `supply-chain-readiness` and
 *     `github-actions-audit` — each monitored repository is guaranteed a cheap
 *     `sonnet` scan at least **weekly** and an expensive `fable` scan at least
 *     **monthly**; and
 *   - **busy work** — every other registered template, untouched by cadence
 *     logic and still drawn at random.
 *
 * This module owns that policy and nothing else. It is **pure**: it imports
 * `IdleTaskFreshnessEntry` as a type only, performs no I/O, spawns no process,
 * and never reaches for `gh`. The freshness report (#3864, #4007) supplies the
 * history; the filer (#4009) consumes the due list. Neither is imported here.
 *
 * The rules, in one place:
 *
 *   - **Rolling windows.** Measured from the last **completed** scan, never
 *     calendar-anchored: 7 days for the weekly window, 30 for the monthly one.
 *   - **Boundaries are inclusive.** Exactly 7.0 / 30.0 days old counts as due
 *     (`>=`), matching the 168h cooldown boundary so a weekly pair is never
 *     blocked by its own cooldown.
 *   - **A fable run satisfies the week.** When both windows have lapsed the
 *     pair is emitted **once**, at the monthly tier — the expensive scan
 *     discharges both obligations.
 *   - **Pre-stamp wrappers count towards the week, not the month.** A wrapper
 *     filed before the tier stamp (#4007) sets `lastRunAt` but appears under no
 *     key in `lastRunAtByModel`, so it can never falsely satisfy the fable
 *     floor.
 *   - **`never-run` is maximally overdue** and sorts first.
 *   - **`unknown` yields nothing.** A repo whose history could not be read is
 *     fail-open: a failed read never biases the filer either way.
 *
 * Malformed input fails loud rather than being reconciled as "fresh": an
 * unparseable timestamp or a nonsensical window throws.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */ // ---------------------------------------------------------------------------
// Policy constants
// ---------------------------------------------------------------------------
/** Templates whose cadence is guaranteed per monitored repository (#4003). */ export const IMPORTANT_TEMPLATE_NAMES = [
  "security-scan",
  "supply-chain-readiness",
  "github-actions-audit"
];
/** Rolling window, in days, for the cheap scan. */ export const WEEKLY_WINDOW_DAYS = 7;
/** Rolling window, in days, for the expensive scan. */ export const MONTHLY_WINDOW_DAYS = 30;
/** Model tier the weekly scan runs on. */ export const WEEKLY_MODEL_TIER = "sonnet";
/** Model tier the monthly scan runs on. */ export const MONTHLY_MODEL_TIER = "fable";
/**
 * `overdueDays` for a window whose clock has no reading at all — the pair has
 * never run, or has never run at the tier the window governs.
 *
 * A finite sentinel rather than `Infinity` so the value survives a JSON round
 * trip (`JSON.stringify(Infinity)` is `null`, which would silently read back as
 * "not overdue").
 */ export const NEVER_RUN_OVERDUE_DAYS = Number.MAX_SAFE_INTEGER;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
/**
 * Model aliases a cadence window may be pinned to (cf. `ModelTier` in
 * `token_usage.ts`). Exported as a runtime list so the `.config.json` parser
 * (#4011) validates an operator's value against the same single source of
 * truth the type expresses.
 */ export const CADENCE_MODEL_TIERS = [
  "fable",
  "opus",
  "sonnet",
  "haiku"
];
/** The #4003 policy: three important templates, 7-day sonnet, 30-day fable. */ export const DEFAULT_CADENCE_POLICY = {
  enabled: true,
  weeklyDays: WEEKLY_WINDOW_DAYS,
  monthlyDays: MONTHLY_WINDOW_DAYS,
  templates: Object.fromEntries(IMPORTANT_TEMPLATE_NAMES.map((name)=>[
      name,
      {
        weeklyModel: WEEKLY_MODEL_TIER,
        monthlyModel: MONTHLY_MODEL_TIER
      }
    ]))
};
// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------
/**
 * Whether a template is on the important list — i.e. subject to the cadence
 * floor. Classification is independent of {@link CadencePolicy.enabled}: the
 * kill switch stops scans being *reported as due*, it does not reclassify a
 * template as busy work.
 */ export function isImportantTemplate(name, policy = DEFAULT_CADENCE_POLICY) {
  return Object.hasOwn(policy.templates, name);
}
// ---------------------------------------------------------------------------
// Due computation
// ---------------------------------------------------------------------------
/** Days between `then` and `now`, or null when `then` is absent. */ function daysSince(now, then, entry) {
  if (then === null || then === undefined || then.length === 0) return null;
  const ms = Date.parse(then);
  if (Number.isNaN(ms)) {
    throw new Error(`idle-task cadence: unparseable timestamp "${then}" for ` + `${entry.repo} / ${entry.template}`);
  }
  return (now.getTime() - ms) / MS_PER_DAY;
}
/** Reject a policy whose windows cannot express the intended cadence. */ function assertUsableWindows(policy) {
  const check = (label, value)=>{
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`idle-task cadence: ${label} must be a finite positive number, got ${value}`);
    }
  };
  check("weeklyDays", policy.weeklyDays);
  check("monthlyDays", policy.monthlyDays);
  if (policy.monthlyDays <= policy.weeklyDays) {
    throw new Error(`idle-task cadence: monthlyDays (${policy.monthlyDays}) must exceed ` + `weeklyDays (${policy.weeklyDays})`);
  }
}
/**
 * Compute the (repo, template, tier) pairs whose cadence floor has lapsed,
 * most-overdue first.
 *
 * Busy-work templates and `unknown` freshness readings are absent from the
 * output. A pair overdue on both windows is emitted once, at the monthly tier.
 *
 * @param entries Freshness readings, one per (repo, template) pair.
 * @param now Reference instant — injected so the caller owns the clock.
 * @param policy Cadence policy; defaults to {@link DEFAULT_CADENCE_POLICY}.
 * @throws Error when a timestamp is unparseable or the windows are unusable.
 */ export function computeDueScans(entries, now, policy = DEFAULT_CADENCE_POLICY) {
  if (!policy.enabled) return [];
  assertUsableWindows(policy);
  const due = [];
  const neverRun = new Set();
  for (const entry of entries){
    const templatePolicy = policy.templates[entry.template];
    if (templatePolicy === undefined) continue; // busy work
    // Fail-open: a repo whose history could not be read never biases the pick.
    if (entry.status === "unknown") continue;
    // The weekly window counts any completed scan, including pre-stamp
    // wrappers; the monthly window counts only scans stamped with its tier.
    const sinceAny = daysSince(now, entry.lastRunAt, entry);
    const sinceMonthlyTier = daysSince(now, entry.lastRunAtByModel?.[templatePolicy.monthlyModel], entry);
    const monthlyOverdue = sinceMonthlyTier === null ? NEVER_RUN_OVERDUE_DAYS : sinceMonthlyTier - policy.monthlyDays;
    const weeklyOverdue = sinceAny === null ? NEVER_RUN_OVERDUE_DAYS : sinceAny - policy.weeklyDays;
    // The expensive tier wins when both windows have lapsed — one fable run
    // discharges the month and the week together.
    let scan = null;
    if (monthlyOverdue >= 0) {
      scan = {
        repo: entry.repo,
        template: entry.template,
        tier: templatePolicy.monthlyModel,
        overdueDays: monthlyOverdue
      };
    } else if (weeklyOverdue >= 0) {
      scan = {
        repo: entry.repo,
        template: entry.template,
        tier: templatePolicy.weeklyModel,
        overdueDays: weeklyOverdue
      };
    }
    if (scan === null) continue;
    due.push(scan);
    if (sinceAny === null) neverRun.add(scan);
  }
  // Most overdue first; a pair that has never run at all outranks one that has
  // merely never run at the monthly tier. Repo then template break the rest.
  return due.sort((a, b)=>{
    if (a.overdueDays !== b.overdueDays) return b.overdueDays - a.overdueDays;
    const rank = Number(neverRun.has(b)) - Number(neverRun.has(a));
    if (rank !== 0) return rank;
    if (a.repo !== b.repo) return a.repo < b.repo ? -1 : 1;
    return a.template < b.template ? -1 : a.template > b.template ? 1 : 0;
  });
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9pZGxlX3Rhc2tfY2FkZW5jZS50cyJdLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIElkbGUtdGFzayBjYWRlbmNlIHBvbGljeSDigJQgaW1wb3J0YW50IHZzIGJ1c3kgd29yayAoSXNzdWVzICM0MDAzLCAjNDAwOCkuXG4gKlxuICogVGhlIHN0ZWFkeS1zdGF0ZSBmaWxlciBwaWNrcyBvbmUgdGVtcGxhdGUgZm9yIG9uZSByZXBvIGF0IHJhbmRvbSBwZXIgaWRsZVxuICogdGljayAoIzIwOTIpLCB3aGljaCBpcyByaWdodCBmb3IgYmFja2dyb3VuZCB3b3JrIGJ1dCBsZWF2ZXMgbm8gZmxvb3IgdW5kZXJcbiAqIHRoZSBzY2FucyB0aGF0IGFjdHVhbGx5IG1hdHRlci4gIzQwMDMgc3BsaXRzIHRoZSByZWdpc3RlcmVkIHRlbXBsYXRlcyBpbiB0d286XG4gKlxuICogICAtICoqaW1wb3J0YW50Kiog4oCUIGBzZWN1cml0eS1zY2FuYCwgYHN1cHBseS1jaGFpbi1yZWFkaW5lc3NgIGFuZFxuICogICAgIGBnaXRodWItYWN0aW9ucy1hdWRpdGAg4oCUIGVhY2ggbW9uaXRvcmVkIHJlcG9zaXRvcnkgaXMgZ3VhcmFudGVlZCBhIGNoZWFwXG4gKiAgICAgYHNvbm5ldGAgc2NhbiBhdCBsZWFzdCAqKndlZWtseSoqIGFuZCBhbiBleHBlbnNpdmUgYGZhYmxlYCBzY2FuIGF0IGxlYXN0XG4gKiAgICAgKiptb250aGx5Kio7IGFuZFxuICogICAtICoqYnVzeSB3b3JrKiog4oCUIGV2ZXJ5IG90aGVyIHJlZ2lzdGVyZWQgdGVtcGxhdGUsIHVudG91Y2hlZCBieSBjYWRlbmNlXG4gKiAgICAgbG9naWMgYW5kIHN0aWxsIGRyYXduIGF0IHJhbmRvbS5cbiAqXG4gKiBUaGlzIG1vZHVsZSBvd25zIHRoYXQgcG9saWN5IGFuZCBub3RoaW5nIGVsc2UuIEl0IGlzICoqcHVyZSoqOiBpdCBpbXBvcnRzXG4gKiBgSWRsZVRhc2tGcmVzaG5lc3NFbnRyeWAgYXMgYSB0eXBlIG9ubHksIHBlcmZvcm1zIG5vIEkvTywgc3Bhd25zIG5vIHByb2Nlc3MsXG4gKiBhbmQgbmV2ZXIgcmVhY2hlcyBmb3IgYGdoYC4gVGhlIGZyZXNobmVzcyByZXBvcnQgKCMzODY0LCAjNDAwNykgc3VwcGxpZXMgdGhlXG4gKiBoaXN0b3J5OyB0aGUgZmlsZXIgKCM0MDA5KSBjb25zdW1lcyB0aGUgZHVlIGxpc3QuIE5laXRoZXIgaXMgaW1wb3J0ZWQgaGVyZS5cbiAqXG4gKiBUaGUgcnVsZXMsIGluIG9uZSBwbGFjZTpcbiAqXG4gKiAgIC0gKipSb2xsaW5nIHdpbmRvd3MuKiogTWVhc3VyZWQgZnJvbSB0aGUgbGFzdCAqKmNvbXBsZXRlZCoqIHNjYW4sIG5ldmVyXG4gKiAgICAgY2FsZW5kYXItYW5jaG9yZWQ6IDcgZGF5cyBmb3IgdGhlIHdlZWtseSB3aW5kb3csIDMwIGZvciB0aGUgbW9udGhseSBvbmUuXG4gKiAgIC0gKipCb3VuZGFyaWVzIGFyZSBpbmNsdXNpdmUuKiogRXhhY3RseSA3LjAgLyAzMC4wIGRheXMgb2xkIGNvdW50cyBhcyBkdWVcbiAqICAgICAoYD49YCksIG1hdGNoaW5nIHRoZSAxNjhoIGNvb2xkb3duIGJvdW5kYXJ5IHNvIGEgd2Vla2x5IHBhaXIgaXMgbmV2ZXJcbiAqICAgICBibG9ja2VkIGJ5IGl0cyBvd24gY29vbGRvd24uXG4gKiAgIC0gKipBIGZhYmxlIHJ1biBzYXRpc2ZpZXMgdGhlIHdlZWsuKiogV2hlbiBib3RoIHdpbmRvd3MgaGF2ZSBsYXBzZWQgdGhlXG4gKiAgICAgcGFpciBpcyBlbWl0dGVkICoqb25jZSoqLCBhdCB0aGUgbW9udGhseSB0aWVyIOKAlCB0aGUgZXhwZW5zaXZlIHNjYW5cbiAqICAgICBkaXNjaGFyZ2VzIGJvdGggb2JsaWdhdGlvbnMuXG4gKiAgIC0gKipQcmUtc3RhbXAgd3JhcHBlcnMgY291bnQgdG93YXJkcyB0aGUgd2Vlaywgbm90IHRoZSBtb250aC4qKiBBIHdyYXBwZXJcbiAqICAgICBmaWxlZCBiZWZvcmUgdGhlIHRpZXIgc3RhbXAgKCM0MDA3KSBzZXRzIGBsYXN0UnVuQXRgIGJ1dCBhcHBlYXJzIHVuZGVyIG5vXG4gKiAgICAga2V5IGluIGBsYXN0UnVuQXRCeU1vZGVsYCwgc28gaXQgY2FuIG5ldmVyIGZhbHNlbHkgc2F0aXNmeSB0aGUgZmFibGVcbiAqICAgICBmbG9vci5cbiAqICAgLSAqKmBuZXZlci1ydW5gIGlzIG1heGltYWxseSBvdmVyZHVlKiogYW5kIHNvcnRzIGZpcnN0LlxuICogICAtICoqYHVua25vd25gIHlpZWxkcyBub3RoaW5nLioqIEEgcmVwbyB3aG9zZSBoaXN0b3J5IGNvdWxkIG5vdCBiZSByZWFkIGlzXG4gKiAgICAgZmFpbC1vcGVuOiBhIGZhaWxlZCByZWFkIG5ldmVyIGJpYXNlcyB0aGUgZmlsZXIgZWl0aGVyIHdheS5cbiAqXG4gKiBNYWxmb3JtZWQgaW5wdXQgZmFpbHMgbG91ZCByYXRoZXIgdGhhbiBiZWluZyByZWNvbmNpbGVkIGFzIFwiZnJlc2hcIjogYW5cbiAqIHVucGFyc2VhYmxlIHRpbWVzdGFtcCBvciBhIG5vbnNlbnNpY2FsIHdpbmRvdyB0aHJvd3MuXG4gKlxuICogQXVzdHJhbGlhbiBFbmdsaXNoIHNwZWxsaW5nIHVzZWQgdGhyb3VnaG91dCAoYmVoYXZpb3VyLCBvcmdhbmlzYXRpb24pLlxuICovXG5cbmltcG9ydCB0eXBlIHsgSWRsZVRhc2tGcmVzaG5lc3NFbnRyeSB9IGZyb20gXCIuL2lkbGVfdGFza19mcmVzaG5lc3MudHNcIjtcblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBQb2xpY3kgY29uc3RhbnRzXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuLyoqIFRlbXBsYXRlcyB3aG9zZSBjYWRlbmNlIGlzIGd1YXJhbnRlZWQgcGVyIG1vbml0b3JlZCByZXBvc2l0b3J5ICgjNDAwMykuICovXG5leHBvcnQgY29uc3QgSU1QT1JUQU5UX1RFTVBMQVRFX05BTUVTOiByZWFkb25seSBzdHJpbmdbXSA9IFtcbiAgXCJzZWN1cml0eS1zY2FuXCIsXG4gIFwic3VwcGx5LWNoYWluLXJlYWRpbmVzc1wiLFxuICBcImdpdGh1Yi1hY3Rpb25zLWF1ZGl0XCIsXG5dO1xuXG4vKiogUm9sbGluZyB3aW5kb3csIGluIGRheXMsIGZvciB0aGUgY2hlYXAgc2Nhbi4gKi9cbmV4cG9ydCBjb25zdCBXRUVLTFlfV0lORE9XX0RBWVMgPSA3O1xuXG4vKiogUm9sbGluZyB3aW5kb3csIGluIGRheXMsIGZvciB0aGUgZXhwZW5zaXZlIHNjYW4uICovXG5leHBvcnQgY29uc3QgTU9OVEhMWV9XSU5ET1dfREFZUyA9IDMwO1xuXG4vKiogTW9kZWwgdGllciB0aGUgd2Vla2x5IHNjYW4gcnVucyBvbi4gKi9cbmV4cG9ydCBjb25zdCBXRUVLTFlfTU9ERUxfVElFUiA9IFwic29ubmV0XCI7XG5cbi8qKiBNb2RlbCB0aWVyIHRoZSBtb250aGx5IHNjYW4gcnVucyBvbi4gKi9cbmV4cG9ydCBjb25zdCBNT05USExZX01PREVMX1RJRVIgPSBcImZhYmxlXCI7XG5cbi8qKlxuICogYG92ZXJkdWVEYXlzYCBmb3IgYSB3aW5kb3cgd2hvc2UgY2xvY2sgaGFzIG5vIHJlYWRpbmcgYXQgYWxsIOKAlCB0aGUgcGFpciBoYXNcbiAqIG5ldmVyIHJ1biwgb3IgaGFzIG5ldmVyIHJ1biBhdCB0aGUgdGllciB0aGUgd2luZG93IGdvdmVybnMuXG4gKlxuICogQSBmaW5pdGUgc2VudGluZWwgcmF0aGVyIHRoYW4gYEluZmluaXR5YCBzbyB0aGUgdmFsdWUgc3Vydml2ZXMgYSBKU09OIHJvdW5kXG4gKiB0cmlwIChgSlNPTi5zdHJpbmdpZnkoSW5maW5pdHkpYCBpcyBgbnVsbGAsIHdoaWNoIHdvdWxkIHNpbGVudGx5IHJlYWQgYmFjayBhc1xuICogXCJub3Qgb3ZlcmR1ZVwiKS5cbiAqL1xuZXhwb3J0IGNvbnN0IE5FVkVSX1JVTl9PVkVSRFVFX0RBWVMgPSBOdW1iZXIuTUFYX1NBRkVfSU5URUdFUjtcblxuY29uc3QgTVNfUEVSX0RBWSA9IDI0ICogNjAgKiA2MCAqIDEwMDA7XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gVHlwZXNcbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG4vKipcbiAqIE1vZGVsIGFsaWFzZXMgYSBjYWRlbmNlIHdpbmRvdyBtYXkgYmUgcGlubmVkIHRvIChjZi4gYE1vZGVsVGllcmAgaW5cbiAqIGB0b2tlbl91c2FnZS50c2ApLiBFeHBvcnRlZCBhcyBhIHJ1bnRpbWUgbGlzdCBzbyB0aGUgYC5jb25maWcuanNvbmAgcGFyc2VyXG4gKiAoIzQwMTEpIHZhbGlkYXRlcyBhbiBvcGVyYXRvcidzIHZhbHVlIGFnYWluc3QgdGhlIHNhbWUgc2luZ2xlIHNvdXJjZSBvZlxuICogdHJ1dGggdGhlIHR5cGUgZXhwcmVzc2VzLlxuICovXG5leHBvcnQgY29uc3QgQ0FERU5DRV9NT0RFTF9USUVSUyA9IFtcbiAgXCJmYWJsZVwiLFxuICBcIm9wdXNcIixcbiAgXCJzb25uZXRcIixcbiAgXCJoYWlrdVwiLFxuXSBhcyBjb25zdDtcblxuLyoqIE1vZGVsIGFsaWFzZXMgYSBjYWRlbmNlIHdpbmRvdyBtYXkgYmUgcGlubmVkIHRvIChjZi4gYE1vZGVsVGllcmApLiAqL1xuZXhwb3J0IHR5cGUgQ2FkZW5jZU1vZGVsVGllciA9IHR5cGVvZiBDQURFTkNFX01PREVMX1RJRVJTW251bWJlcl07XG5cbi8qKiBQZXItdGVtcGxhdGUgdGllciBhc3NpZ25tZW50IGZvciB0aGUgdHdvIHdpbmRvd3MuICovXG5leHBvcnQgaW50ZXJmYWNlIENhZGVuY2VUZW1wbGF0ZVBvbGljeSB7XG4gIC8qKiBUaWVyIHRoZSB3ZWVrbHkgc2NhbiBydW5zIG9uLiAqL1xuICB3ZWVrbHlNb2RlbDogQ2FkZW5jZU1vZGVsVGllcjtcbiAgLyoqIFRpZXIgdGhlIG1vbnRobHkgc2NhbiBydW5zIG9uLiAqL1xuICBtb250aGx5TW9kZWw6IENhZGVuY2VNb2RlbFRpZXI7XG59XG5cbi8qKlxuICogVGhlIHdob2xlIGNhZGVuY2UgcG9saWN5LiBNaXJyb3JzIHRoZSBgaWRsZV90YXNrX2NhZGVuY2VgIGNvbmZpZyBibG9ja1xuICogKCM0MDExKSBzbyB3aXJpbmcgdGhlIG9wZXJhdG9yJ3MgYC5jb25maWcuanNvbmAgdGhyb3VnaCBpcyBtZWNoYW5pY2FsOyB1bnRpbFxuICogdGhhdCBsYW5kcywge0BsaW5rIERFRkFVTFRfQ0FERU5DRV9QT0xJQ1l9IGlzIHRoZSBwb2xpY3kgaW4gZm9yY2UuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQ2FkZW5jZVBvbGljeSB7XG4gIC8qKiBLaWxsIHN3aXRjaCDigJQgd2hlbiBmYWxzZSwgbm8gcGFpciBpcyBldmVyIHJlcG9ydGVkIGFzIGR1ZS4gKi9cbiAgZW5hYmxlZDogYm9vbGVhbjtcbiAgLyoqIFdlZWtseSByb2xsaW5nIHdpbmRvdywgaW4gZGF5cy4gKi9cbiAgd2Vla2x5RGF5czogbnVtYmVyO1xuICAvKiogTW9udGhseSByb2xsaW5nIHdpbmRvdywgaW4gZGF5cy4gKi9cbiAgbW9udGhseURheXM6IG51bWJlcjtcbiAgLyoqIEltcG9ydGFudCB0ZW1wbGF0ZXMsIGtleWVkIGJ5IHRlbXBsYXRlIG5hbWUuIEFueXRoaW5nIGFic2VudCBpcyBidXN5IHdvcmsuICovXG4gIHRlbXBsYXRlczogUmVhZG9ubHk8UmVjb3JkPHN0cmluZywgQ2FkZW5jZVRlbXBsYXRlUG9saWN5Pj47XG59XG5cbi8qKiBPbmUgKHJlcG8sIHRlbXBsYXRlKSBwYWlyIHRoYXQgaXMgb3ZlcmR1ZSwgYW5kIHRoZSB0aWVyIG93ZWQgdG8gaXQuICovXG5leHBvcnQgaW50ZXJmYWNlIER1ZVNjYW4ge1xuICByZXBvOiBzdHJpbmc7XG4gIHRlbXBsYXRlOiBzdHJpbmc7XG4gIC8qKiBUaWVyIHRoZSBvd2VkIHNjYW4gc2hvdWxkIHJ1biBvbi4gKi9cbiAgdGllcjogQ2FkZW5jZU1vZGVsVGllcjtcbiAgLyoqXG4gICAqIERheXMgcGFzdCB0aGUgd2luZG93J3MgZGVhZGxpbmUsIGZyYWN0aW9uYWwuIHtAbGluayBORVZFUl9SVU5fT1ZFUkRVRV9EQVlTfVxuICAgKiB3aGVuIHRoZSB3aW5kb3cncyBjbG9jayBoYXMgbm8gcmVhZGluZyBhdCBhbGwuXG4gICAqL1xuICBvdmVyZHVlRGF5czogbnVtYmVyO1xufVxuXG4vKiogVGhlICM0MDAzIHBvbGljeTogdGhyZWUgaW1wb3J0YW50IHRlbXBsYXRlcywgNy1kYXkgc29ubmV0LCAzMC1kYXkgZmFibGUuICovXG5leHBvcnQgY29uc3QgREVGQVVMVF9DQURFTkNFX1BPTElDWTogQ2FkZW5jZVBvbGljeSA9IHtcbiAgZW5hYmxlZDogdHJ1ZSxcbiAgd2Vla2x5RGF5czogV0VFS0xZX1dJTkRPV19EQVlTLFxuICBtb250aGx5RGF5czogTU9OVEhMWV9XSU5ET1dfREFZUyxcbiAgdGVtcGxhdGVzOiBPYmplY3QuZnJvbUVudHJpZXMoXG4gICAgSU1QT1JUQU5UX1RFTVBMQVRFX05BTUVTLm1hcCgobmFtZSkgPT4gW25hbWUsIHtcbiAgICAgIHdlZWtseU1vZGVsOiBXRUVLTFlfTU9ERUxfVElFUixcbiAgICAgIG1vbnRobHlNb2RlbDogTU9OVEhMWV9NT0RFTF9USUVSLFxuICAgIH0gYXMgQ2FkZW5jZVRlbXBsYXRlUG9saWN5XSksXG4gICksXG59O1xuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIENsYXNzaWZpY2F0aW9uXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuLyoqXG4gKiBXaGV0aGVyIGEgdGVtcGxhdGUgaXMgb24gdGhlIGltcG9ydGFudCBsaXN0IOKAlCBpLmUuIHN1YmplY3QgdG8gdGhlIGNhZGVuY2VcbiAqIGZsb29yLiBDbGFzc2lmaWNhdGlvbiBpcyBpbmRlcGVuZGVudCBvZiB7QGxpbmsgQ2FkZW5jZVBvbGljeS5lbmFibGVkfTogdGhlXG4gKiBraWxsIHN3aXRjaCBzdG9wcyBzY2FucyBiZWluZyAqcmVwb3J0ZWQgYXMgZHVlKiwgaXQgZG9lcyBub3QgcmVjbGFzc2lmeSBhXG4gKiB0ZW1wbGF0ZSBhcyBidXN5IHdvcmsuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBpc0ltcG9ydGFudFRlbXBsYXRlKFxuICBuYW1lOiBzdHJpbmcsXG4gIHBvbGljeTogQ2FkZW5jZVBvbGljeSA9IERFRkFVTFRfQ0FERU5DRV9QT0xJQ1ksXG4pOiBib29sZWFuIHtcbiAgcmV0dXJuIE9iamVjdC5oYXNPd24ocG9saWN5LnRlbXBsYXRlcywgbmFtZSk7XG59XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gRHVlIGNvbXB1dGF0aW9uXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuLyoqIERheXMgYmV0d2VlbiBgdGhlbmAgYW5kIGBub3dgLCBvciBudWxsIHdoZW4gYHRoZW5gIGlzIGFic2VudC4gKi9cbmZ1bmN0aW9uIGRheXNTaW5jZShcbiAgbm93OiBEYXRlLFxuICB0aGVuOiBzdHJpbmcgfCBudWxsIHwgdW5kZWZpbmVkLFxuICBlbnRyeTogSWRsZVRhc2tGcmVzaG5lc3NFbnRyeSxcbik6IG51bWJlciB8IG51bGwge1xuICBpZiAodGhlbiA9PT0gbnVsbCB8fCB0aGVuID09PSB1bmRlZmluZWQgfHwgdGhlbi5sZW5ndGggPT09IDApIHJldHVybiBudWxsO1xuICBjb25zdCBtcyA9IERhdGUucGFyc2UodGhlbik7XG4gIGlmIChOdW1iZXIuaXNOYU4obXMpKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgYGlkbGUtdGFzayBjYWRlbmNlOiB1bnBhcnNlYWJsZSB0aW1lc3RhbXAgXCIke3RoZW59XCIgZm9yIGAgK1xuICAgICAgICBgJHtlbnRyeS5yZXBvfSAvICR7ZW50cnkudGVtcGxhdGV9YCxcbiAgICApO1xuICB9XG4gIHJldHVybiAobm93LmdldFRpbWUoKSAtIG1zKSAvIE1TX1BFUl9EQVk7XG59XG5cbi8qKiBSZWplY3QgYSBwb2xpY3kgd2hvc2Ugd2luZG93cyBjYW5ub3QgZXhwcmVzcyB0aGUgaW50ZW5kZWQgY2FkZW5jZS4gKi9cbmZ1bmN0aW9uIGFzc2VydFVzYWJsZVdpbmRvd3MocG9saWN5OiBDYWRlbmNlUG9saWN5KTogdm9pZCB7XG4gIGNvbnN0IGNoZWNrID0gKGxhYmVsOiBzdHJpbmcsIHZhbHVlOiBudW1iZXIpID0+IHtcbiAgICBpZiAoIU51bWJlci5pc0Zpbml0ZSh2YWx1ZSkgfHwgdmFsdWUgPD0gMCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBgaWRsZS10YXNrIGNhZGVuY2U6ICR7bGFiZWx9IG11c3QgYmUgYSBmaW5pdGUgcG9zaXRpdmUgbnVtYmVyLCBnb3QgJHt2YWx1ZX1gLFxuICAgICAgKTtcbiAgICB9XG4gIH07XG4gIGNoZWNrKFwid2Vla2x5RGF5c1wiLCBwb2xpY3kud2Vla2x5RGF5cyk7XG4gIGNoZWNrKFwibW9udGhseURheXNcIiwgcG9saWN5Lm1vbnRobHlEYXlzKTtcbiAgaWYgKHBvbGljeS5tb250aGx5RGF5cyA8PSBwb2xpY3kud2Vla2x5RGF5cykge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIGBpZGxlLXRhc2sgY2FkZW5jZTogbW9udGhseURheXMgKCR7cG9saWN5Lm1vbnRobHlEYXlzfSkgbXVzdCBleGNlZWQgYCArXG4gICAgICAgIGB3ZWVrbHlEYXlzICgke3BvbGljeS53ZWVrbHlEYXlzfSlgLFxuICAgICk7XG4gIH1cbn1cblxuLyoqXG4gKiBDb21wdXRlIHRoZSAocmVwbywgdGVtcGxhdGUsIHRpZXIpIHBhaXJzIHdob3NlIGNhZGVuY2UgZmxvb3IgaGFzIGxhcHNlZCxcbiAqIG1vc3Qtb3ZlcmR1ZSBmaXJzdC5cbiAqXG4gKiBCdXN5LXdvcmsgdGVtcGxhdGVzIGFuZCBgdW5rbm93bmAgZnJlc2huZXNzIHJlYWRpbmdzIGFyZSBhYnNlbnQgZnJvbSB0aGVcbiAqIG91dHB1dC4gQSBwYWlyIG92ZXJkdWUgb24gYm90aCB3aW5kb3dzIGlzIGVtaXR0ZWQgb25jZSwgYXQgdGhlIG1vbnRobHkgdGllci5cbiAqXG4gKiBAcGFyYW0gZW50cmllcyBGcmVzaG5lc3MgcmVhZGluZ3MsIG9uZSBwZXIgKHJlcG8sIHRlbXBsYXRlKSBwYWlyLlxuICogQHBhcmFtIG5vdyBSZWZlcmVuY2UgaW5zdGFudCDigJQgaW5qZWN0ZWQgc28gdGhlIGNhbGxlciBvd25zIHRoZSBjbG9jay5cbiAqIEBwYXJhbSBwb2xpY3kgQ2FkZW5jZSBwb2xpY3k7IGRlZmF1bHRzIHRvIHtAbGluayBERUZBVUxUX0NBREVOQ0VfUE9MSUNZfS5cbiAqIEB0aHJvd3MgRXJyb3Igd2hlbiBhIHRpbWVzdGFtcCBpcyB1bnBhcnNlYWJsZSBvciB0aGUgd2luZG93cyBhcmUgdW51c2FibGUuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBjb21wdXRlRHVlU2NhbnMoXG4gIGVudHJpZXM6IHJlYWRvbmx5IElkbGVUYXNrRnJlc2huZXNzRW50cnlbXSxcbiAgbm93OiBEYXRlLFxuICBwb2xpY3k6IENhZGVuY2VQb2xpY3kgPSBERUZBVUxUX0NBREVOQ0VfUE9MSUNZLFxuKTogRHVlU2NhbltdIHtcbiAgaWYgKCFwb2xpY3kuZW5hYmxlZCkgcmV0dXJuIFtdO1xuICBhc3NlcnRVc2FibGVXaW5kb3dzKHBvbGljeSk7XG5cbiAgY29uc3QgZHVlOiBEdWVTY2FuW10gPSBbXTtcbiAgY29uc3QgbmV2ZXJSdW4gPSBuZXcgU2V0PER1ZVNjYW4+KCk7XG5cbiAgZm9yIChjb25zdCBlbnRyeSBvZiBlbnRyaWVzKSB7XG4gICAgY29uc3QgdGVtcGxhdGVQb2xpY3kgPSBwb2xpY3kudGVtcGxhdGVzW2VudHJ5LnRlbXBsYXRlXTtcbiAgICBpZiAodGVtcGxhdGVQb2xpY3kgPT09IHVuZGVmaW5lZCkgY29udGludWU7IC8vIGJ1c3kgd29ya1xuICAgIC8vIEZhaWwtb3BlbjogYSByZXBvIHdob3NlIGhpc3RvcnkgY291bGQgbm90IGJlIHJlYWQgbmV2ZXIgYmlhc2VzIHRoZSBwaWNrLlxuICAgIGlmIChlbnRyeS5zdGF0dXMgPT09IFwidW5rbm93blwiKSBjb250aW51ZTtcblxuICAgIC8vIFRoZSB3ZWVrbHkgd2luZG93IGNvdW50cyBhbnkgY29tcGxldGVkIHNjYW4sIGluY2x1ZGluZyBwcmUtc3RhbXBcbiAgICAvLyB3cmFwcGVyczsgdGhlIG1vbnRobHkgd2luZG93IGNvdW50cyBvbmx5IHNjYW5zIHN0YW1wZWQgd2l0aCBpdHMgdGllci5cbiAgICBjb25zdCBzaW5jZUFueSA9IGRheXNTaW5jZShub3csIGVudHJ5Lmxhc3RSdW5BdCwgZW50cnkpO1xuICAgIGNvbnN0IHNpbmNlTW9udGhseVRpZXIgPSBkYXlzU2luY2UoXG4gICAgICBub3csXG4gICAgICBlbnRyeS5sYXN0UnVuQXRCeU1vZGVsPy5bdGVtcGxhdGVQb2xpY3kubW9udGhseU1vZGVsXSxcbiAgICAgIGVudHJ5LFxuICAgICk7XG5cbiAgICBjb25zdCBtb250aGx5T3ZlcmR1ZSA9IHNpbmNlTW9udGhseVRpZXIgPT09IG51bGxcbiAgICAgID8gTkVWRVJfUlVOX09WRVJEVUVfREFZU1xuICAgICAgOiBzaW5jZU1vbnRobHlUaWVyIC0gcG9saWN5Lm1vbnRobHlEYXlzO1xuICAgIGNvbnN0IHdlZWtseU92ZXJkdWUgPSBzaW5jZUFueSA9PT0gbnVsbFxuICAgICAgPyBORVZFUl9SVU5fT1ZFUkRVRV9EQVlTXG4gICAgICA6IHNpbmNlQW55IC0gcG9saWN5LndlZWtseURheXM7XG5cbiAgICAvLyBUaGUgZXhwZW5zaXZlIHRpZXIgd2lucyB3aGVuIGJvdGggd2luZG93cyBoYXZlIGxhcHNlZCDigJQgb25lIGZhYmxlIHJ1blxuICAgIC8vIGRpc2NoYXJnZXMgdGhlIG1vbnRoIGFuZCB0aGUgd2VlayB0b2dldGhlci5cbiAgICBsZXQgc2NhbjogRHVlU2NhbiB8IG51bGwgPSBudWxsO1xuICAgIGlmIChtb250aGx5T3ZlcmR1ZSA+PSAwKSB7XG4gICAgICBzY2FuID0ge1xuICAgICAgICByZXBvOiBlbnRyeS5yZXBvLFxuICAgICAgICB0ZW1wbGF0ZTogZW50cnkudGVtcGxhdGUsXG4gICAgICAgIHRpZXI6IHRlbXBsYXRlUG9saWN5Lm1vbnRobHlNb2RlbCxcbiAgICAgICAgb3ZlcmR1ZURheXM6IG1vbnRobHlPdmVyZHVlLFxuICAgICAgfTtcbiAgICB9IGVsc2UgaWYgKHdlZWtseU92ZXJkdWUgPj0gMCkge1xuICAgICAgc2NhbiA9IHtcbiAgICAgICAgcmVwbzogZW50cnkucmVwbyxcbiAgICAgICAgdGVtcGxhdGU6IGVudHJ5LnRlbXBsYXRlLFxuICAgICAgICB0aWVyOiB0ZW1wbGF0ZVBvbGljeS53ZWVrbHlNb2RlbCxcbiAgICAgICAgb3ZlcmR1ZURheXM6IHdlZWtseU92ZXJkdWUsXG4gICAgICB9O1xuICAgIH1cbiAgICBpZiAoc2NhbiA9PT0gbnVsbCkgY29udGludWU7XG5cbiAgICBkdWUucHVzaChzY2FuKTtcbiAgICBpZiAoc2luY2VBbnkgPT09IG51bGwpIG5ldmVyUnVuLmFkZChzY2FuKTtcbiAgfVxuXG4gIC8vIE1vc3Qgb3ZlcmR1ZSBmaXJzdDsgYSBwYWlyIHRoYXQgaGFzIG5ldmVyIHJ1biBhdCBhbGwgb3V0cmFua3Mgb25lIHRoYXQgaGFzXG4gIC8vIG1lcmVseSBuZXZlciBydW4gYXQgdGhlIG1vbnRobHkgdGllci4gUmVwbyB0aGVuIHRlbXBsYXRlIGJyZWFrIHRoZSByZXN0LlxuICByZXR1cm4gZHVlLnNvcnQoKGEsIGIpID0+IHtcbiAgICBpZiAoYS5vdmVyZHVlRGF5cyAhPT0gYi5vdmVyZHVlRGF5cykgcmV0dXJuIGIub3ZlcmR1ZURheXMgLSBhLm92ZXJkdWVEYXlzO1xuICAgIGNvbnN0IHJhbmsgPSBOdW1iZXIobmV2ZXJSdW4uaGFzKGIpKSAtIE51bWJlcihuZXZlclJ1bi5oYXMoYSkpO1xuICAgIGlmIChyYW5rICE9PSAwKSByZXR1cm4gcmFuaztcbiAgICBpZiAoYS5yZXBvICE9PSBiLnJlcG8pIHJldHVybiBhLnJlcG8gPCBiLnJlcG8gPyAtMSA6IDE7XG4gICAgcmV0dXJuIGEudGVtcGxhdGUgPCBiLnRlbXBsYXRlID8gLTEgOiBhLnRlbXBsYXRlID4gYi50ZW1wbGF0ZSA/IDEgOiAwO1xuICB9KTtcbn1cbiJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Q0F5Q0MsR0FJRCw4RUFBOEU7QUFDOUUsbUJBQW1CO0FBQ25CLDhFQUE4RTtBQUU5RSw0RUFBNEUsR0FDNUUsT0FBTyxNQUFNLDJCQUE4QztFQUN6RDtFQUNBO0VBQ0E7Q0FDRCxDQUFDO0FBRUYsaURBQWlELEdBQ2pELE9BQU8sTUFBTSxxQkFBcUIsRUFBRTtBQUVwQyxxREFBcUQsR0FDckQsT0FBTyxNQUFNLHNCQUFzQixHQUFHO0FBRXRDLHdDQUF3QyxHQUN4QyxPQUFPLE1BQU0sb0JBQW9CLFNBQVM7QUFFMUMseUNBQXlDLEdBQ3pDLE9BQU8sTUFBTSxxQkFBcUIsUUFBUTtBQUUxQzs7Ozs7OztDQU9DLEdBQ0QsT0FBTyxNQUFNLHlCQUF5QixPQUFPLGdCQUFnQixDQUFDO0FBRTlELE1BQU0sYUFBYSxLQUFLLEtBQUssS0FBSztBQUVsQyw4RUFBOEU7QUFDOUUsUUFBUTtBQUNSLDhFQUE4RTtBQUU5RTs7Ozs7Q0FLQyxHQUNELE9B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
// denoCacheMetadata=2491116660569589077,8213133281526483689