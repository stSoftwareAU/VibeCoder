/**
 * Location of the content-approval baseline store (Issue #3717).
 *
 * The TOCTOU baseline used to live at `${workDir}/.content_approval_state.json`
 * — inside the directory the agent works in and the directory `nukeWorkDir()`
 * deletes wholesale when disk pressure bites. Losing it read as `no_snapshot`,
 * so the gate captured whatever content was in hand and proceeded: a deletion
 * disarmed the gate (SEC-25fca7187089).
 *
 * The store is therefore a *sibling* of `workDir`, never a child. Deriving it
 * from `workDir` keeps each worker identity isolated (fleet members have
 * separate `HOME`s and so separate work directories) without depending on
 * `HOME` being set, and puts it beyond both `nukeWorkDir()` and an
 * agent-driven `rm` inside the work tree.
 *
 * Uses Australian English throughout (behaviour, organisation).
 */

/** Suffix appended to `workDir` to name the approval-state store. */
const STATE_DIR_SUFFIX = "-approval-state";

/**
 * Resolve the directory holding the content-approval state.
 *
 * `""` is the explicit *unconfigured-store* sentinel (Issue #3874): `workDir`
 * names no directory the store can sit beside, so no baseline can be read or
 * written. Every consumer must fail closed on it — an unconfigured store is a
 * configuration fault, never a successful read of an empty store. Surrounding
 * whitespace is stripped first, so a blank-but-not-empty `workDir` resolves to
 * the same sentinel instead of a bogus relative store directory.
 *
 * @param workDir - The agent-writable work directory (`config.workDir`)
 * @returns The store directory, or `""` when `workDir` names no directory
 *          (unset, whitespace-only, or `/`)
 */
export function resolveContentApprovalStateDir(workDir: string): string {
  const trimmed = workDir.trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  return `${trimmed}${STATE_DIR_SUFFIX}`;
}
