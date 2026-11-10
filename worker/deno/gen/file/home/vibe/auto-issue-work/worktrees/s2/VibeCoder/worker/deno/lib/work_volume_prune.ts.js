/**
 * Bound the work volume's growth (Issue #228).
 *
 * ## What went wrong
 *
 * Host GRQ-23 crashed out of disk on 2026-08-21. Its 39 GB work volume
 * held ~20 GB of Rust `target/` directories across six repos, a 1.5 GB
 * `.bench-history-*` and a copied `.before-src` repo an agent had dumped
 * in the work root (outside any clone), and 14 stale heartbeat-marker
 * state files going back days. Nothing aged any of it out: the per-issue
 * cleanup resets the clone it worked in, and the stale-workdir scanner
 * skips dot-prefixed entries by design.
 *
 * ## The rules
 *
 * 1. **Build artefacts.** A `target/` directory beside a `Cargo.toml`
 *    (the repo root or one level down) is disposable — `cargo` rebuilds
 *    it. It goes when it has not been touched for `maxAgeDays`, or, when
 *    the artefacts across all repos exceed `maxTotalBytes`, oldest first
 *    until they fit. A repo with a live heartbeat is never touched. The
 *    scan covers the shared clones **and** every lane worktree under
 *    `worktrees/<lane>/<repo>` (Issue #1725): a lane builds in its own
 *    worktree, and the per-repo clean at setup only reaches a worktree the
 *    lane next reuses for that repo — 36 GB of `target/` sat in idle lane
 *    worktrees on GRQ-25 while the host fell to 6 GB free, invisible to a
 *    reclaim that treated `worktrees` as a reserved name and looked away.
 * 2. **Scratch in the work root.** A dot-prefixed *directory* in the work
 *    root that is not one of the worker's own state directories and has
 *    not been modified for `scratchMaxAgeHours` is an agent's leftover
 *    and is removed. Files are left alone (the worker keeps state files
 *    there).
 * 3. **Marker state files.** `.heartbeat-marker_*` files older than
 *    `markerMaxAgeDays` belong to claims long released; a live claim
 *    refreshes its file every few minutes.
 *
 * Every removal is named in the result; every failure is recorded, never
 * thrown — housekeeping must not abort a launch.
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */ import { runWithTimeout } from "./subprocess_timeout.ts";
import { recordFaultEvent } from "./fault_tolerance_counters.ts";
import { isReservedWorkRootEntry } from "./stale_workdir.ts";
import { LANE_WORKTREE_ROOT } from "./lane_worktree.ts";
import { DEFAULT_HEARTBEAT_LIVE_WINDOW_SECONDS, isHeartbeatFileLive } from "./heartbeat_freshness.ts";
const GIB = 1_073_741_824;
const DU_TIMEOUT_MS = 120_000;
/** Defaults, overridable through the housekeeping env knobs. */ export const DEFAULT_ARTEFACT_MAX_AGE_DAYS = 2;
export const DEFAULT_ARTEFACT_MAX_TOTAL_BYTES = 10 * GIB;
export const DEFAULT_SCRATCH_MAX_AGE_HOURS = 24;
export const DEFAULT_MARKER_MAX_AGE_DAYS = 2;
/**
 * Dot-prefixed directories the worker itself keeps in the work root.
 * Anything else dot-prefixed and old is scratch.
 */ export const WORK_ROOT_STATE_DIRS = new Set([
  ".claude-sessions",
  ".claude-config",
  ".deno-cache",
  ".vibe-cache",
  ".gh-scan-cache",
  ".gh-timeline-cache",
  ".runlogs",
  ".github",
  ".git",
  ".resume-state",
  // The container-managed writable roots (Issue #515): the entrypoint's
  // per-launch scratch and durable tool caches, and the crash-notification
  // rate-limit state. All three belong to a LIVE launch, so the scratch rule
  // must not age them out from under it — the entrypoint clears its own
  // scratch on every start.
  ".container-scratch",
  ".container-state",
  ".crash-state"
]);
/**
 * Bytes from a `du -sk` line, or null when the output said nothing usable
 * (Issue #345).
 *
 * Empty or non-numeric output is **not** zero. The old parser ran
 * `Number("")`, which is a finite 0, so a `du` that printed nothing was
 * reported as a directory holding no bytes — a confident zero from a probe
 * that had measured nothing.
 */ export function parseDuBytes(stdout) {
  const field = stdout.trim().split(/\s+/)[0] ?? "";
  if (!/^\d+$/.test(field)) return null;
  const kb = Number(field);
  return Number.isFinite(kb) ? kb * 1024 : null;
}
/** `du -sk` in bytes, or null when it cannot be measured. */ export async function duBytes(path) {
  // No `quiet: true` (Issue #345): `quiet` sets `stdout: "null"` and returns
  // an empty string, and stdout *is* the reading here. Every size on every
  // host came back 0 because of it. Nothing is echoed either way — piped
  // output is captured, not printed.
  const result = await runWithTimeout("du", [
    "-sk",
    path
  ], {
    timeoutMs: DU_TIMEOUT_MS
  });
  if (!result.ok || result.value.timedOut || !result.value.success) {
    return null;
  }
  return parseDuBytes(result.value.stdout);
}
/**
 * Default liveness check: a `.heartbeat_*_<repo>_<n>` file in the root whose
 * recorded beat is live.
 *
 * The filename alone is not evidence (Issue #1232). The work root is
 * agent-writable, so matching on the name meant any file called
 * `.heartbeat_a_<repo>_1` exempted that repo's artefacts from the prune for
 * ever — nothing here removes it, so the exemption never expired. The beat
 * inside the file is what counts, and it counts only inside a bounded
 * window (see {@link isHeartbeatFileLive}).
 */ export async function repoHasHeartbeat(workDir, repoName, now = Math.floor(Date.now() / 1000), windowSeconds = DEFAULT_HEARTBEAT_LIVE_WINDOW_SECONDS) {
  try {
    for await (const entry of Deno.readDir(workDir)){
      if (!entry.isFile || !entry.name.startsWith(".heartbeat_")) continue;
      // `.heartbeat_<owner>_<repo>_<issue>` — the repo name sits before the
      // trailing issue number.
      const stem = entry.name.slice(".heartbeat_".length);
      const withoutIssue = stem.replace(/_\d+$/, "");
      if (!withoutIssue.endsWith(`_${repoName}`) && withoutIssue !== repoName) {
        continue;
      }
      if (await isHeartbeatFileLive(`${workDir}/${entry.name}`, now, windowSeconds)) {
        return true;
      }
    }
  } catch  {
    // Unreadable root — treat as active (fail safe).
    return true;
  }
  return false;
}
async function mtimeEpoch(path) {
  try {
    const stat = await Deno.stat(path);
    return stat.mtime ? Math.floor(stat.mtime.getTime() / 1000) : null;
  } catch  {
    return null;
  }
}
/**
 * Newest modification time under a target dir, two levels deep — the
 * directory's own mtime does not move when cargo writes inside `debug/`.
 */ async function newestMtimeShallow(path) {
  let newest = await mtimeEpoch(path);
  try {
    for await (const entry of Deno.readDir(path)){
      const child = `${path}/${entry.name}`;
      const m = await mtimeEpoch(child);
      if (m !== null && (newest === null || m > newest)) newest = m;
      if (!entry.isDirectory) continue;
      try {
        for await (const grand of Deno.readDir(child)){
          const gm = await mtimeEpoch(`${child}/${grand.name}`);
          if (gm !== null && (newest === null || gm > newest)) newest = gm;
        }
      } catch  {
      // Unreadable subdirectory — its parent's mtime stands.
      }
    }
  } catch  {
  // Unreadable — the dir's own mtime stands.
  }
  return newest;
}
async function exists(path) {
  try {
    await Deno.stat(path);
    return true;
  } catch  {
    return false;
  }
}
/**
 * Every `worktrees/<lane>/<repo>` directory that is a git worktree
 * (Issue #1725). A worktree's `.git` is a *file* pointing at the clone, so
 * the check is for existence, not for a directory. Unreadable or absent
 * roots yield nothing — a missing worktree root is the common case.
 */ export async function listLaneWorktrees(workDir) {
  const root = `${workDir}/${LANE_WORKTREE_ROOT}`;
  const found = [];
  let lanes = [];
  try {
    for await (const lane of Deno.readDir(root))lanes.push(lane);
  } catch  {
    return found;
  }
  lanes = lanes.filter((l)=>l.isDirectory && !l.name.startsWith("."));
  for (const lane of lanes){
    try {
      for await (const repo of Deno.readDir(`${root}/${lane.name}`)){
        if (!repo.isDirectory || repo.name.startsWith(".")) continue;
        const path = `${root}/${lane.name}/${repo.name}`;
        if (!await exists(`${path}/.git`)) continue;
        found.push({
          repo: repo.name,
          label: `${LANE_WORKTREE_ROOT}/${lane.name}/${repo.name}`,
          path
        });
      }
    } catch  {
    // An unreadable lane directory holds nothing this pass can act on.
    }
  }
  return found;
}
/** Find cargo `target/` dirs in a repo: the root and one level down. */ export async function findCargoTargets(repoDir) {
  const found = [];
  const check = async (dir)=>{
    if (await exists(`${dir}/Cargo.toml`) && await exists(`${dir}/target`)) {
      found.push(`${dir}/target`);
    }
  };
  await check(repoDir);
  try {
    for await (const entry of Deno.readDir(repoDir)){
      if (!entry.isDirectory || entry.name.startsWith(".")) continue;
      if (entry.name === "target" || entry.name === "node_modules") continue;
      await check(`${repoDir}/${entry.name}`);
    }
  } catch  {
  // Unreadable repo — nothing found.
  }
  return found;
}
/**
 * Decide which artefact dirs go: every one past the age limit, then the
 * oldest until the rest fit under the cap.
 */ export function selectArtefactsToRemove(records, maxAgeDays, maxTotalBytes) {
  const remove = new Set();
  for (const r of records){
    if (r.ageDays > maxAgeDays) remove.add(r);
  }
  let remaining = records.filter((r)=>!remove.has(r));
  let total = remaining.reduce((sum, r)=>sum + r.bytes, 0);
  remaining = [
    ...remaining
  ].sort((a, b)=>b.ageDays - a.ageDays);
  for (const r of remaining){
    if (total <= maxTotalBytes) break;
    remove.add(r);
    total -= r.bytes;
  }
  return records.filter((r)=>remove.has(r));
}
async function removeDir(path, errors) {
  try {
    await Deno.remove(path, {
      recursive: true
    });
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`could not remove ${path}: ${msg}`);
    recordFaultEvent("catch_block_warning", `work-volume-prune could not remove ${path}: ${msg}`);
    return false;
  }
}
/** Run all three sweeps. */ export async function pruneWorkVolume(options) {
  const workDir = options.workDir;
  const now = (options.nowFn ?? (()=>Math.floor(Date.now() / 1000)))();
  const sizeOf = options.sizeOf ?? duBytes;
  // The injected clock reaches the liveness check too, so a test's `now` and
  // the heartbeat's epoch are read on the same timeline.
  const isRepoActive = options.isRepoActive ?? ((dir, repo)=>repoHasHeartbeat(dir, repo, now));
  const artefactMaxAgeDays = options.artefactMaxAgeDays ?? DEFAULT_ARTEFACT_MAX_AGE_DAYS;
  const artefactMaxTotalBytes = options.artefactMaxTotalBytes ?? DEFAULT_ARTEFACT_MAX_TOTAL_BYTES;
  const scratchMaxAgeSeconds = (options.scratchMaxAgeHours ?? DEFAULT_SCRATCH_MAX_AGE_HOURS) * 3600;
  const markerMaxAgeSeconds = (options.markerMaxAgeDays ?? DEFAULT_MARKER_MAX_AGE_DAYS) * 86400;
  const result = {
    artefacts: {
      scanned: [],
      removed: [],
      skippedActive: [],
      bytesReclaimed: 0
    },
    scratch: {
      removed: []
    },
    markers: {
      removed: []
    },
    errors: []
  };
  const entries = [];
  try {
    for await (const entry of Deno.readDir(workDir))entries.push(entry);
  } catch (err) {
    result.errors.push(`cannot read ${workDir}: ${err instanceof Error ? err.message : err}`);
    return result;
  }
  // 1. Build artefacts — in the shared clones, and in every lane worktree
  //    (Issue #1725), which build in their own trees and are only cleaned
  //    when the lane next reuses that repository.
  const clones = [];
  for (const entry of entries){
    if (!entry.isDirectory || entry.name.startsWith(".")) continue;
    if (isReservedWorkRootEntry(entry.name)) continue;
    const repoDir = `${workDir}/${entry.name}`;
    if (!await exists(`${repoDir}/.git`)) continue;
    clones.push({
      repo: entry.name,
      label: entry.name,
      path: repoDir
    });
  }
  clones.push(...await listLaneWorktrees(workDir));
  for (const clone of clones){
    const targets = await findCargoTargets(clone.path);
    if (targets.length === 0) continue;
    // Keyed on the repository, not the directory: a live heartbeat for the
    // repository protects the shared clone and every lane's worktree of it.
    if (await isRepoActive(workDir, clone.repo)) {
      result.artefacts.skippedActive.push(clone.label);
      continue;
    }
    for (const target of targets){
      const bytes = await sizeOf(target) ?? 0;
      const newest = await newestMtimeShallow(target);
      const ageDays = newest === null ? Infinity : (now - newest) / 86400;
      result.artefacts.scanned.push({
        repo: clone.label,
        path: target,
        bytes,
        ageDays
      });
    }
  }
  for (const record of selectArtefactsToRemove(result.artefacts.scanned, artefactMaxAgeDays, artefactMaxTotalBytes)){
    if (await removeDir(record.path, result.errors)) {
      result.artefacts.removed.push(record);
      result.artefacts.bytesReclaimed += record.bytes;
    }
  }
  if (options.artefactsOnly) return result;
  // 2. Scratch directories in the work root.
  for (const entry of entries){
    if (!entry.isDirectory || !entry.name.startsWith(".")) continue;
    if (WORK_ROOT_STATE_DIRS.has(entry.name)) continue;
    if (isReservedWorkRootEntry(entry.name)) continue;
    const path = `${workDir}/${entry.name}`;
    const m = await mtimeEpoch(path);
    if (m !== null && now - m < scratchMaxAgeSeconds) continue;
    if (await removeDir(path, result.errors)) {
      result.scratch.removed.push(entry.name);
    }
  }
  // 3. Stale marker state files.
  for (const entry of entries){
    if (!entry.isFile || !entry.name.startsWith(".heartbeat-marker_")) continue;
    const path = `${workDir}/${entry.name}`;
    const m = await mtimeEpoch(path);
    if (m === null || now - m < markerMaxAgeSeconds) continue;
    try {
      await Deno.remove(path);
      result.markers.removed.push(entry.name);
    } catch (err) {
      result.errors.push(`could not remove ${path}: ${err instanceof Error ? err.message : err}`);
    }
  }
  return result;
}
export function formatGb(bytes) {
  return `${(bytes / GIB).toFixed(1)} GB`;
}
/** One-line summary for the housekeeping log. */ export function summariseWorkVolumePrune(r) {
  const scannedBytes = r.artefacts.scanned.reduce((s, a)=>s + a.bytes, 0);
  const parts = [
    `artefacts: ${r.artefacts.scanned.length} target dir(s) ${formatGb(scannedBytes)}, removed ${r.artefacts.removed.length} (${formatGb(r.artefacts.bytesReclaimed)})` + // Name what went, largest first (Issue #1725): a reclaim that says
    // "removed 3" beside a 36 GB drop should say where the 36 GB was.
    (r.artefacts.removed.length > 0 ? ` — ${[
      ...r.artefacts.removed
    ].sort((a, b)=>b.bytes - a.bytes).slice(0, 3).map((a)=>`${a.repo}/target ${formatGb(a.bytes)}`).join(", ")}${r.artefacts.removed.length > 3 ? ", …" : ""}` : "") + (r.artefacts.skippedActive.length > 0 ? `, skipped active ${r.artefacts.skippedActive.join(", ")}` : ""),
    `scratch: removed ${r.scratch.removed.length}` + (r.scratch.removed.length > 0 ? ` (${r.scratch.removed.join(", ")})` : ""),
    `markers: removed ${r.markers.removed.length}`
  ];
  if (r.errors.length > 0) parts.push(`errors: ${r.errors.join("; ")}`);
  return parts.join(" | ");
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi93b3JrX3ZvbHVtZV9wcnVuZS50cyJdLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIEJvdW5kIHRoZSB3b3JrIHZvbHVtZSdzIGdyb3d0aCAoSXNzdWUgIzIyOCkuXG4gKlxuICogIyMgV2hhdCB3ZW50IHdyb25nXG4gKlxuICogSG9zdCBHUlEtMjMgY3Jhc2hlZCBvdXQgb2YgZGlzayBvbiAyMDI2LTA4LTIxLiBJdHMgMzkgR0Igd29yayB2b2x1bWVcbiAqIGhlbGQgfjIwIEdCIG9mIFJ1c3QgYHRhcmdldC9gIGRpcmVjdG9yaWVzIGFjcm9zcyBzaXggcmVwb3MsIGEgMS41IEdCXG4gKiBgLmJlbmNoLWhpc3RvcnktKmAgYW5kIGEgY29waWVkIGAuYmVmb3JlLXNyY2AgcmVwbyBhbiBhZ2VudCBoYWQgZHVtcGVkXG4gKiBpbiB0aGUgd29yayByb290IChvdXRzaWRlIGFueSBjbG9uZSksIGFuZCAxNCBzdGFsZSBoZWFydGJlYXQtbWFya2VyXG4gKiBzdGF0ZSBmaWxlcyBnb2luZyBiYWNrIGRheXMuIE5vdGhpbmcgYWdlZCBhbnkgb2YgaXQgb3V0OiB0aGUgcGVyLWlzc3VlXG4gKiBjbGVhbnVwIHJlc2V0cyB0aGUgY2xvbmUgaXQgd29ya2VkIGluLCBhbmQgdGhlIHN0YWxlLXdvcmtkaXIgc2Nhbm5lclxuICogc2tpcHMgZG90LXByZWZpeGVkIGVudHJpZXMgYnkgZGVzaWduLlxuICpcbiAqICMjIFRoZSBydWxlc1xuICpcbiAqIDEuICoqQnVpbGQgYXJ0ZWZhY3RzLioqIEEgYHRhcmdldC9gIGRpcmVjdG9yeSBiZXNpZGUgYSBgQ2FyZ28udG9tbGBcbiAqICAgICh0aGUgcmVwbyByb290IG9yIG9uZSBsZXZlbCBkb3duKSBpcyBkaXNwb3NhYmxlIOKAlCBgY2FyZ29gIHJlYnVpbGRzXG4gKiAgICBpdC4gSXQgZ29lcyB3aGVuIGl0IGhhcyBub3QgYmVlbiB0b3VjaGVkIGZvciBgbWF4QWdlRGF5c2AsIG9yLCB3aGVuXG4gKiAgICB0aGUgYXJ0ZWZhY3RzIGFjcm9zcyBhbGwgcmVwb3MgZXhjZWVkIGBtYXhUb3RhbEJ5dGVzYCwgb2xkZXN0IGZpcnN0XG4gKiAgICB1bnRpbCB0aGV5IGZpdC4gQSByZXBvIHdpdGggYSBsaXZlIGhlYXJ0YmVhdCBpcyBuZXZlciB0b3VjaGVkLiBUaGVcbiAqICAgIHNjYW4gY292ZXJzIHRoZSBzaGFyZWQgY2xvbmVzICoqYW5kKiogZXZlcnkgbGFuZSB3b3JrdHJlZSB1bmRlclxuICogICAgYHdvcmt0cmVlcy88bGFuZT4vPHJlcG8+YCAoSXNzdWUgIzE3MjUpOiBhIGxhbmUgYnVpbGRzIGluIGl0cyBvd25cbiAqICAgIHdvcmt0cmVlLCBhbmQgdGhlIHBlci1yZXBvIGNsZWFuIGF0IHNldHVwIG9ubHkgcmVhY2hlcyBhIHdvcmt0cmVlIHRoZVxuICogICAgbGFuZSBuZXh0IHJldXNlcyBmb3IgdGhhdCByZXBvIOKAlCAzNiBHQiBvZiBgdGFyZ2V0L2Agc2F0IGluIGlkbGUgbGFuZVxuICogICAgd29ya3RyZWVzIG9uIEdSUS0yNSB3aGlsZSB0aGUgaG9zdCBmZWxsIHRvIDYgR0IgZnJlZSwgaW52aXNpYmxlIHRvIGFcbiAqICAgIHJlY2xhaW0gdGhhdCB0cmVhdGVkIGB3b3JrdHJlZXNgIGFzIGEgcmVzZXJ2ZWQgbmFtZSBhbmQgbG9va2VkIGF3YXkuXG4gKiAyLiAqKlNjcmF0Y2ggaW4gdGhlIHdvcmsgcm9vdC4qKiBBIGRvdC1wcmVmaXhlZCAqZGlyZWN0b3J5KiBpbiB0aGUgd29ya1xuICogICAgcm9vdCB0aGF0IGlzIG5vdCBvbmUgb2YgdGhlIHdvcmtlcidzIG93biBzdGF0ZSBkaXJlY3RvcmllcyBhbmQgaGFzXG4gKiAgICBub3QgYmVlbiBtb2RpZmllZCBmb3IgYHNjcmF0Y2hNYXhBZ2VIb3Vyc2AgaXMgYW4gYWdlbnQncyBsZWZ0b3ZlclxuICogICAgYW5kIGlzIHJlbW92ZWQuIEZpbGVzIGFyZSBsZWZ0IGFsb25lICh0aGUgd29ya2VyIGtlZXBzIHN0YXRlIGZpbGVzXG4gKiAgICB0aGVyZSkuXG4gKiAzLiAqKk1hcmtlciBzdGF0ZSBmaWxlcy4qKiBgLmhlYXJ0YmVhdC1tYXJrZXJfKmAgZmlsZXMgb2xkZXIgdGhhblxuICogICAgYG1hcmtlck1heEFnZURheXNgIGJlbG9uZyB0byBjbGFpbXMgbG9uZyByZWxlYXNlZDsgYSBsaXZlIGNsYWltXG4gKiAgICByZWZyZXNoZXMgaXRzIGZpbGUgZXZlcnkgZmV3IG1pbnV0ZXMuXG4gKlxuICogRXZlcnkgcmVtb3ZhbCBpcyBuYW1lZCBpbiB0aGUgcmVzdWx0OyBldmVyeSBmYWlsdXJlIGlzIHJlY29yZGVkLCBuZXZlclxuICogdGhyb3duIOKAlCBob3VzZWtlZXBpbmcgbXVzdCBub3QgYWJvcnQgYSBsYXVuY2guXG4gKlxuICogQXVzdHJhbGlhbiBFbmdsaXNoIHNwZWxsaW5nIHRocm91Z2hvdXQgKGJlaGF2aW91ciwgY29sb3VyLCBvcmdhbmlzYXRpb24pLlxuICovXG5cbmltcG9ydCB7IHJ1bldpdGhUaW1lb3V0IH0gZnJvbSBcIi4vc3VicHJvY2Vzc190aW1lb3V0LnRzXCI7XG5pbXBvcnQgeyByZWNvcmRGYXVsdEV2ZW50IH0gZnJvbSBcIi4vZmF1bHRfdG9sZXJhbmNlX2NvdW50ZXJzLnRzXCI7XG5pbXBvcnQgeyBpc1Jlc2VydmVkV29ya1Jvb3RFbnRyeSB9IGZyb20gXCIuL3N0YWxlX3dvcmtkaXIudHNcIjtcbmltcG9ydCB7IExBTkVfV09SS1RSRUVfUk9PVCB9IGZyb20gXCIuL2xhbmVfd29ya3RyZWUudHNcIjtcbmltcG9ydCB7XG4gIERFRkFVTFRfSEVBUlRCRUFUX0xJVkVfV0lORE9XX1NFQ09ORFMsXG4gIGlzSGVhcnRiZWF0RmlsZUxpdmUsXG59IGZyb20gXCIuL2hlYXJ0YmVhdF9mcmVzaG5lc3MudHNcIjtcblxuY29uc3QgR0lCID0gMV8wNzNfNzQxXzgyNDtcbmNvbnN0IERVX1RJTUVPVVRfTVMgPSAxMjBfMDAwO1xuXG4vKiogRGVmYXVsdHMsIG92ZXJyaWRhYmxlIHRocm91Z2ggdGhlIGhvdXNla2VlcGluZyBlbnYga25vYnMuICovXG5leHBvcnQgY29uc3QgREVGQVVMVF9BUlRFRkFDVF9NQVhfQUdFX0RBWVMgPSAyO1xuZXhwb3J0IGNvbnN0IERFRkFVTFRfQVJURUZBQ1RfTUFYX1RPVEFMX0JZVEVTID0gMTAgKiBHSUI7XG5leHBvcnQgY29uc3QgREVGQVVMVF9TQ1JBVENIX01BWF9BR0VfSE9VUlMgPSAyNDtcbmV4cG9ydCBjb25zdCBERUZBVUxUX01BUktFUl9NQVhfQUdFX0RBWVMgPSAyO1xuXG4vKipcbiAqIERvdC1wcmVmaXhlZCBkaXJlY3RvcmllcyB0aGUgd29ya2VyIGl0c2VsZiBrZWVwcyBpbiB0aGUgd29yayByb290LlxuICogQW55dGhpbmcgZWxzZSBkb3QtcHJlZml4ZWQgYW5kIG9sZCBpcyBzY3JhdGNoLlxuICovXG5leHBvcnQgY29uc3QgV09SS19ST09UX1NUQVRFX0RJUlM6IFJlYWRvbmx5U2V0PHN0cmluZz4gPSBuZXcgU2V0KFtcbiAgXCIuY2xhdWRlLXNlc3Npb25zXCIsXG4gIFwiLmNsYXVkZS1jb25maWdcIixcbiAgXCIuZGVuby1jYWNoZVwiLFxuICBcIi52aWJlLWNhY2hlXCIsXG4gIFwiLmdoLXNjYW4tY2FjaGVcIixcbiAgXCIuZ2gtdGltZWxpbmUtY2FjaGVcIixcbiAgXCIucnVubG9nc1wiLFxuICBcIi5naXRodWJcIixcbiAgXCIuZ2l0XCIsXG4gIFwiLnJlc3VtZS1zdGF0ZVwiLFxuICAvLyBUaGUgY29udGFpbmVyLW1hbmFnZWQgd3JpdGFibGUgcm9vdHMgKElzc3VlICM1MTUpOiB0aGUgZW50cnlwb2ludCdzXG4gIC8vIHBlci1sYXVuY2ggc2NyYXRjaCBhbmQgZHVyYWJsZSB0b29sIGNhY2hlcywgYW5kIHRoZSBjcmFzaC1ub3RpZmljYXRpb25cbiAgLy8gcmF0ZS1saW1pdCBzdGF0ZS4gQWxsIHRocmVlIGJlbG9uZyB0byBhIExJVkUgbGF1bmNoLCBzbyB0aGUgc2NyYXRjaCBydWxlXG4gIC8vIG11c3Qgbm90IGFnZSB0aGVtIG91dCBmcm9tIHVuZGVyIGl0IOKAlCB0aGUgZW50cnlwb2ludCBjbGVhcnMgaXRzIG93blxuICAvLyBzY3JhdGNoIG9uIGV2ZXJ5IHN0YXJ0LlxuICBcIi5jb250YWluZXItc2NyYXRjaFwiLFxuICBcIi5jb250YWluZXItc3RhdGVcIixcbiAgXCIuY3Jhc2gtc3RhdGVcIixcbl0pO1xuXG5leHBvcnQgaW50ZXJmYWNlIFdvcmtWb2x1bWVQcnVuZU9wdGlvbnMge1xuICB3b3JrRGlyOiBzdHJpbmc7XG4gIGFydGVmYWN0TWF4QWdlRGF5cz86IG51bWJlcjtcbiAgYXJ0ZWZhY3RNYXhUb3RhbEJ5dGVzPzogbnVtYmVyO1xuICBzY3JhdGNoTWF4QWdlSG91cnM/OiBudW1iZXI7XG4gIG1hcmtlck1heEFnZURheXM/OiBudW1iZXI7XG4gIC8qKiBFcG9jaCBzZWNvbmRzLCBpbmplY3RhYmxlLiAqL1xuICBub3dGbj86ICgpID0+IG51bWJlcjtcbiAgLyoqIFNpemUgb2YgYSBkaXJlY3RvcnkgaW4gYnl0ZXMsIGluamVjdGFibGUgKGRlZmF1bHQgYGR1IC1za2ApLiAqL1xuICBzaXplT2Y/OiAocGF0aDogc3RyaW5nKSA9PiBQcm9taXNlPG51bWJlciB8IG51bGw+O1xuICAvKiogV2hldGhlciBhIHJlcG8gaGFzIGEgbGl2ZSBjbGFpbSBvbiB0aGlzIGhvc3QsIGluamVjdGFibGUuICovXG4gIGlzUmVwb0FjdGl2ZT86ICh3b3JrRGlyOiBzdHJpbmcsIHJlcG9OYW1lOiBzdHJpbmcpID0+IFByb21pc2U8Ym9vbGVhbj47XG4gIC8qKlxuICAgKiBSdW4gb25seSB0aGUgYnVpbGQtYXJ0ZWZhY3QgcnVsZSAoSXNzdWUgIzE3MjUpLiBUaGUgZGlzay1sb3cgcmVjbGFpbVxuICAgKiB3YW50cyB0aGUgcmVnZW5lcmFibGUgb3V0cHV0IGdvbmUgbm93IGFuZCBub3RoaW5nIGVsc2UgdG91Y2hlZDsgdGhlXG4gICAqIHNjcmF0Y2ggYW5kIG1hcmtlciBydWxlcyBrZWVwIHRoZWlyIG93biBhZ2VzIG9uIHRoZSBob3VzZWtlZXBpbmcgcGFzcy5cbiAgICovXG4gIGFydGVmYWN0c09ubHk/OiBib29sZWFuO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIEFydGVmYWN0UmVjb3JkIHtcbiAgcmVwbzogc3RyaW5nO1xuICBwYXRoOiBzdHJpbmc7XG4gIGJ5dGVzOiBudW1iZXI7XG4gIGFnZURheXM6IG51bWJlcjtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBXb3JrVm9sdW1lUHJ1bmVSZXN1bHQge1xuICBhcnRlZmFjdHM6IHtcbiAgICBzY2FubmVkOiBBcnRlZmFjdFJlY29yZFtdO1xuICAgIHJlbW92ZWQ6IEFydGVmYWN0UmVjb3JkW107XG4gICAgc2tpcHBlZEFjdGl2ZTogc3RyaW5nW107XG4gICAgYnl0ZXNSZWNsYWltZWQ6IG51bWJlcjtcbiAgfTtcbiAgc2NyYXRjaDogeyByZW1vdmVkOiBzdHJpbmdbXSB9O1xuICBtYXJrZXJzOiB7IHJlbW92ZWQ6IHN0cmluZ1tdIH07XG4gIGVycm9yczogc3RyaW5nW107XG59XG5cbi8qKlxuICogQnl0ZXMgZnJvbSBhIGBkdSAtc2tgIGxpbmUsIG9yIG51bGwgd2hlbiB0aGUgb3V0cHV0IHNhaWQgbm90aGluZyB1c2FibGVcbiAqIChJc3N1ZSAjMzQ1KS5cbiAqXG4gKiBFbXB0eSBvciBub24tbnVtZXJpYyBvdXRwdXQgaXMgKipub3QqKiB6ZXJvLiBUaGUgb2xkIHBhcnNlciByYW5cbiAqIGBOdW1iZXIoXCJcIilgLCB3aGljaCBpcyBhIGZpbml0ZSAwLCBzbyBhIGBkdWAgdGhhdCBwcmludGVkIG5vdGhpbmcgd2FzXG4gKiByZXBvcnRlZCBhcyBhIGRpcmVjdG9yeSBob2xkaW5nIG5vIGJ5dGVzIOKAlCBhIGNvbmZpZGVudCB6ZXJvIGZyb20gYSBwcm9iZVxuICogdGhhdCBoYWQgbWVhc3VyZWQgbm90aGluZy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHBhcnNlRHVCeXRlcyhzdGRvdXQ6IHN0cmluZyk6IG51bWJlciB8IG51bGwge1xuICBjb25zdCBmaWVsZCA9IHN0ZG91dC50cmltKCkuc3BsaXQoL1xccysvKVswXSA/PyBcIlwiO1xuICBpZiAoIS9eXFxkKyQvLnRlc3QoZmllbGQpKSByZXR1cm4gbnVsbDtcbiAgY29uc3Qga2IgPSBOdW1iZXIoZmllbGQpO1xuICByZXR1cm4gTnVtYmVyLmlzRmluaXRlKGtiKSA/IGtiICogMTAyNCA6IG51bGw7XG59XG5cbi8qKiBgZHUgLXNrYCBpbiBieXRlcywgb3IgbnVsbCB3aGVuIGl0IGNhbm5vdCBiZSBtZWFzdXJlZC4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBkdUJ5dGVzKHBhdGg6IHN0cmluZyk6IFByb21pc2U8bnVtYmVyIHwgbnVsbD4ge1xuICAvLyBObyBgcXVpZXQ6IHRydWVgIChJc3N1ZSAjMzQ1KTogYHF1aWV0YCBzZXRzIGBzdGRvdXQ6IFwibnVsbFwiYCBhbmQgcmV0dXJuc1xuICAvLyBhbiBlbXB0eSBzdHJpbmcsIGFuZCBzdGRvdXQgKmlzKiB0aGUgcmVhZGluZyBoZXJlLiBFdmVyeSBzaXplIG9uIGV2ZXJ5XG4gIC8vIGhvc3QgY2FtZSBiYWNrIDAgYmVjYXVzZSBvZiBpdC4gTm90aGluZyBpcyBlY2hvZWQgZWl0aGVyIHdheSDigJQgcGlwZWRcbiAgLy8gb3V0cHV0IGlzIGNhcHR1cmVkLCBub3QgcHJpbnRlZC5cbiAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcnVuV2l0aFRpbWVvdXQoXCJkdVwiLCBbXCItc2tcIiwgcGF0aF0sIHtcbiAgICB0aW1lb3V0TXM6IERVX1RJTUVPVVRfTVMsXG4gIH0pO1xuICBpZiAoIXJlc3VsdC5vayB8fCByZXN1bHQudmFsdWUudGltZWRPdXQgfHwgIXJlc3VsdC52YWx1ZS5zdWNjZXNzKSB7XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cbiAgcmV0dXJuIHBhcnNlRHVCeXRlcyhyZXN1bHQudmFsdWUuc3Rkb3V0KTtcbn1cblxuLyoqXG4gKiBEZWZhdWx0IGxpdmVuZXNzIGNoZWNrOiBhIGAuaGVhcnRiZWF0XypfPHJlcG8+XzxuPmAgZmlsZSBpbiB0aGUgcm9vdCB3aG9zZVxuICogcmVjb3JkZWQgYmVhdCBpcyBsaXZlLlxuICpcbiAqIFRoZSBmaWxlbmFtZSBhbG9uZSBpcyBub3QgZXZpZGVuY2UgKElzc3VlICMxMjMyKS4gVGhlIHdvcmsgcm9vdCBpc1xuICogYWdlbnQtd3JpdGFibGUsIHNvIG1hdGNoaW5nIG9uIHRoZSBuYW1lIG1lYW50IGFueSBmaWxlIGNhbGxlZFxuICogYC5oZWFydGJlYXRfYV88cmVwbz5fMWAgZXhlbXB0ZWQgdGhhdCByZXBvJ3MgYXJ0ZWZhY3RzIGZyb20gdGhlIHBydW5lIGZvclxuICogZXZlciDigJQgbm90aGluZyBoZXJlIHJlbW92ZXMgaXQsIHNvIHRoZSBleGVtcHRpb24gbmV2ZXIgZXhwaXJlZC4gVGhlIGJlYXRcbiAqIGluc2lkZSB0aGUgZmlsZSBpcyB3aGF0IGNvdW50cywgYW5kIGl0IGNvdW50cyBvbmx5IGluc2lkZSBhIGJvdW5kZWRcbiAqIHdpbmRvdyAoc2VlIHtAbGluayBpc0hlYXJ0YmVhdEZpbGVMaXZlfSkuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiByZXBvSGFzSGVhcnRiZWF0KFxuICB3b3JrRGlyOiBzdHJpbmcsXG4gIHJlcG9OYW1lOiBzdHJpbmcsXG4gIG5vdzogbnVtYmVyID0gTWF0aC5mbG9vcihEYXRlLm5vdygpIC8gMTAwMCksXG4gIHdpbmRvd1NlY29uZHM6IG51bWJlciA9IERFRkFVTFRfSEVBUlRCRUFUX0xJVkVfV0lORE9XX1NFQ09ORFMsXG4pOiBQcm9taXNlPGJvb2xlYW4+IHtcbiAgdHJ5IHtcbiAgICBmb3IgYXdhaXQgKGNvbnN0IGVudHJ5IG9mIERlbm8ucmVhZERpcih3b3JrRGlyKSkge1xuICAgICAgaWYgKCFlbnRyeS5pc0ZpbGUgfHwgIWVudHJ5Lm5hbWUuc3RhcnRzV2l0aChcIi5oZWFydGJlYXRfXCIpKSBjb250aW51ZTtcbiAgICAgIC8vIGAuaGVhcnRiZWF0Xzxvd25lcj5fPHJlcG8+Xzxpc3N1ZT5gIOKAlCB0aGUgcmVwbyBuYW1lIHNpdHMgYmVmb3JlIHRoZVxuICAgICAgLy8gdHJhaWxpbmcgaXNzdWUgbnVtYmVyLlxuICAgICAgY29uc3Qgc3RlbSA9IGVudHJ5Lm5hbWUuc2xpY2UoXCIuaGVhcnRiZWF0X1wiLmxlbmd0aCk7XG4gICAgICBjb25zdCB3aXRob3V0SXNzdWUgPSBzdGVtLnJlcGxhY2UoL19cXGQrJC8sIFwiXCIpO1xuICAgICAgaWYgKCF3aXRob3V0SXNzdWUuZW5kc1dpdGgoYF8ke3JlcG9OYW1lfWApICYmIHdpdGhvdXRJc3N1ZSAhPT0gcmVwb05hbWUpIHtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG4gICAgICBpZiAoXG4gICAgICAgIGF3YWl0IGlzSGVhcnRiZWF0RmlsZUxpdmUoXG4gICAgICAgICAgYCR7d29ya0Rpcn0vJHtlbnRyeS5uYW1lfWAsXG4gICAgICAgICAgbm93LFxuICAgICAgICAgIHdpbmRvd1NlY29uZHMsXG4gICAgICAgIClcbiAgICAgICkge1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgIH1cbiAgICB9XG4gIH0gY2F0Y2gge1xuICAgIC8vIFVucmVhZGFibGUgcm9vdCDigJQgdHJlYXQgYXMgYWN0aXZlIChmYWlsIHNhZmUpLlxuICAgIHJldHVybiB0cnVlO1xuICB9XG4gIHJldHVybiBmYWxzZTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gbXRpbWVFcG9jaChwYXRoOiBzdHJpbmcpOiBQcm9taXNlPG51bWJlciB8IG51bGw+IHtcbiAgdHJ5IHtcbiAgICBjb25zdCBzdGF0ID0gYXdhaXQgRGVuby5zdGF0KHBhdGgpO1xuICAgIHJldHVybiBzdGF0Lm10aW1lID8gTWF0aC5mbG9vcihzdGF0Lm10aW1lLmdldFRpbWUoKSAvIDEwMDApIDogbnVsbDtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cbn1cblxuLyoqXG4gKiBOZXdlc3QgbW9kaWZpY2F0aW9uIHRpbWUgdW5kZXIgYSB0YXJnZXQgZGlyLCB0d28gbGV2ZWxzIGRlZXAg4oCUIHRoZVxuICogZGlyZWN0b3J5J3Mgb3duIG10aW1lIGRvZXMgbm90IG1vdmUgd2hlbiBjYXJnbyB3cml0ZXMgaW5zaWRlIGBkZWJ1Zy9gLlxuICovXG5hc3luYyBmdW5jdGlvbiBuZXdlc3RNdGltZVNoYWxsb3cocGF0aDogc3RyaW5nKTogUHJvbWlzZTxudW1iZXIgfCBudWxsPiB7XG4gIGxldCBuZXdlc3QgPSBhd2FpdCBtdGltZUVwb2NoKHBhdGgpO1xuICB0cnkge1xuICAgIGZvciBhd2FpdCAoY29uc3QgZW50cnkgb2YgRGVuby5yZWFkRGlyKHBhdGgpKSB7XG4gICAgICBjb25zdCBjaGlsZCA9IGAke3BhdGh9LyR7ZW50cnkubmFtZX1gO1xuICAgICAgY29uc3QgbSA9IGF3YWl0IG10aW1lRXBvY2goY2hpbGQpO1xuICAgICAgaWYgKG0gIT09IG51bGwgJiYgKG5ld2VzdCA9PT0gbnVsbCB8fCBtID4gbmV3ZXN0KSkgbmV3ZXN0ID0gbTtcbiAgICAgIGlmICghZW50cnkuaXNEaXJlY3RvcnkpIGNvbnRpbnVlO1xuICAgICAgdHJ5IHtcbiAgICAgICAgZm9yIGF3YWl0IChjb25zdCBncmFuZCBvZiBEZW5vLnJlYWREaXIoY2hpbGQpKSB7XG4gICAgICAgICAgY29uc3QgZ20gPSBhd2FpdCBtdGltZUVwb2NoKGAke2NoaWxkfS8ke2dyYW5kLm5hbWV9YCk7XG4gICAgICAgICAgaWYgKGdtICE9PSBudWxsICYmIChuZXdlc3QgPT09IG51bGwgfHwgZ20gPiBuZXdlc3QpKSBuZXdlc3QgPSBnbTtcbiAgICAgICAgfVxuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIC8vIFVucmVhZGFibGUgc3ViZGlyZWN0b3J5IOKAlCBpdHMgcGFyZW50J3MgbXRpbWUgc3RhbmRzLlxuICAgICAgfVxuICAgIH1cbiAgfSBjYXRjaCB7XG4gICAgLy8gVW5yZWFkYWJsZSDigJQgdGhlIGRpcidzIG93biBtdGltZSBzdGFuZHMuXG4gIH1cbiAgcmV0dXJuIG5ld2VzdDtcbn1cblxuYXN5bmMgZnVuY3Rpb24gZXhpc3RzKHBhdGg6IHN0cmluZyk6IFByb21pc2U8Ym9vbGVhbj4ge1xuICB0cnkge1xuICAgIGF3YWl0IERlbm8uc3RhdChwYXRoKTtcbiAgICByZXR1cm4gdHJ1ZTtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG59XG5cbi8qKlxuICogQSBsYW5lIHdvcmt0cmVlIHVuZGVyIHRoZSB3b3JrIHJvb3QgKElzc3VlICMxNzI1KS5cbiAqXG4gKiBgcmVwb2AgaXMgdGhlIGRpcmVjdG9yeSdzIG93biBuYW1lIOKAlCB0aGUgcmVwb3NpdG9yeSdzIOKAlCB3aGljaCBpcyBhbHNvIHRoZVxuICogc2VnbWVudCBhIGhlYXJ0YmVhdCBmaWxlIG5hbWVzLCBzbyB0aGUgc2FtZSBsaXZlbmVzcyBjaGVjayB0aGF0IHByb3RlY3RzXG4gKiB0aGUgc2hhcmVkIGNsb25lIHByb3RlY3RzIGV2ZXJ5IGxhbmUncyB3b3JrdHJlZSBvZiB0aGF0IHJlcG9zaXRvcnkuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgTGFuZVdvcmt0cmVlRGlyIHtcbiAgLyoqIFJlcG9zaXRvcnkgZGlyZWN0b3J5IG5hbWUsIGUuZy4gYE5FQVQtQUktRGlzY292ZXJ5YC4gKi9cbiAgcmVwbzogc3RyaW5nO1xuICAvKiogV29yay1yb290LXJlbGF0aXZlIGxhYmVsLCBlLmcuIGB3b3JrdHJlZXMvczEvTkVBVC1BSS1EaXNjb3ZlcnlgLiAqL1xuICBsYWJlbDogc3RyaW5nO1xuICAvKiogQWJzb2x1dGUgcGF0aCBvZiB0aGUgd29ya3RyZWUuICovXG4gIHBhdGg6IHN0cmluZztcbn1cblxuLyoqXG4gKiBFdmVyeSBgd29ya3RyZWVzLzxsYW5lPi88cmVwbz5gIGRpcmVjdG9yeSB0aGF0IGlzIGEgZ2l0IHdvcmt0cmVlXG4gKiAoSXNzdWUgIzE3MjUpLiBBIHdvcmt0cmVlJ3MgYC5naXRgIGlzIGEgKmZpbGUqIHBvaW50aW5nIGF0IHRoZSBjbG9uZSwgc29cbiAqIHRoZSBjaGVjayBpcyBmb3IgZXhpc3RlbmNlLCBub3QgZm9yIGEgZGlyZWN0b3J5LiBVbnJlYWRhYmxlIG9yIGFic2VudFxuICogcm9vdHMgeWllbGQgbm90aGluZyDigJQgYSBtaXNzaW5nIHdvcmt0cmVlIHJvb3QgaXMgdGhlIGNvbW1vbiBjYXNlLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gbGlzdExhbmVXb3JrdHJlZXMoXG4gIHdvcmtEaXI6IHN0cmluZyxcbik6IFByb21pc2U8TGFuZVdvcmt0cmVlRGlyW10+IHtcbiAgY29uc3Qgcm9vdCA9IGAke3dvcmtEaXJ9LyR7TEFORV9XT1JLVFJFRV9ST09UfWA7XG4gIGNvbnN0IGZvdW5kOiBMYW5lV29ya3RyZWVEaXJbXSA9IFtdO1xuICBsZXQgbGFuZXM6IERlbm8uRGlyRW50cnlbXSA9IFtdO1xuICB0cnkge1xuICAgIGZvciBhd2FpdCAoY29uc3QgbGFuZSBvZiBEZW5vLnJlYWREaXIocm9vdCkpIGxhbmVzLnB1c2gobGFuZSk7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBmb3VuZDtcbiAgfVxuICBsYW5lcyA9IGxhbmVzLmZpbHRlcigobCkgPT4gbC5pc0RpcmVjdG9yeSAmJiAhbC5uYW1lLnN0YXJ0c1dpdGgoXCIuXCIpKTtcbiAgZm9yIChjb25zdCBsYW5lIG9mIGxhbmVzKSB7XG4gICAgdHJ5IHtcbiAgICAgIGZvciBhd2FpdCAoY29uc3QgcmVwbyBvZiBEZW5vLnJlYWREaXIoYCR7cm9vdH0vJHtsYW5lLm5hbWV9YCkpIHtcbiAgICAgICAgaWYgKCFyZXBvLmlzRGlyZWN0b3J5IHx8IHJlcG8ubmFtZS5zdGFydHNXaXRoKFwiLlwiKSkgY29udGludWU7XG4gICAgICAgIGNvbnN0IHBhdGggPSBgJHtyb290fS8ke2xhbmUubmFtZX0vJHtyZXBvLm5hbWV9YDtcbiAgICAgICAgaWYgKCEoYXdhaXQgZXhpc3RzKGAke3BhdGh9Ly5naXRgKSkpIGNvbnRpbnVlO1xuICAgICAgICBmb3VuZC5wdXNoKHtcbiAgICAgICAgICByZXBvOiByZXBvLm5hbWUsXG4gICAgICAgICAgbGFiZWw6IGAke0xBTkVfV09SS1RSRUVfUk9PVH0vJHtsYW5lLm5hbWV9LyR7cmVwby5uYW1lfWAsXG4gICAgICAgICAgcGF0aCxcbiAgICAgICAgfSk7XG4gICAgICB9XG4gICAgfSBjYXRjaCB7XG4gICAgICAvLyBBbiB1bnJlYWRhYmxlIGxhbmUgZGlyZWN0b3J5IGhvbGRzIG5vdGhpbmcgdGhpcyBwYXNzIGNhbiBhY3Qgb24uXG4gICAgfVxuICB9XG4gIHJldHVybiBmb3VuZDtcbn1cblxuLyoqIEZpbmQgY2FyZ28gYHRhcmdldC9gIGRpcnMgaW4gYSByZXBvOiB0aGUgcm9vdCBhbmQgb25lIGxldmVsIGRvd24uICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gZmluZENhcmdvVGFyZ2V0cyhyZXBvRGlyOiBzdHJpbmcpOiBQcm9taXNlPHN0cmluZ1tdPiB7XG4gIGNvbnN0IGZvdW5kOiBzdHJpbmdbXSA9IFtdO1xuICBjb25zdCBjaGVjayA9IGFzeW5jIChkaXI6IHN0cmluZykgPT4ge1xuICAgIGlmIChcbiAgICAgIGF3YWl0IGV4aXN0cyhgJHtkaXJ9L0NhcmdvLnRvbWxgKSAmJiBhd2FpdCBleGlzdHMoYCR7ZGlyfS90YXJnZXRgKVxuICAgICkge1xuICAgICAgZm91bmQucHVzaChgJHtkaXJ9L3RhcmdldGApO1xuICAgIH1cbiAgfTtcbiAgYXdhaXQgY2hlY2socmVwb0Rpcik7XG4gIHRyeSB7XG4gICAgZm9yIGF3YWl0IChjb25zdCBlbnRyeSBvZiBEZW5vLnJlYWREaXIocmVwb0RpcikpIHtcbiAgICAgIGlmICghZW50cnkuaXNEaXJlY3RvcnkgfHwgZW50cnkubmFtZS5zdGFydHNXaXRoKFwiLlwiKSkgY29udGludWU7XG4gICAgICBpZiAoZW50cnkubmFtZSA9PT0gXCJ0YXJnZXRcIiB8fCBlbnRyeS5uYW1lID09PSBcIm5vZGVfbW9kdWxlc1wiKSBjb250aW51ZTtcbiAgICAgIGF3YWl0IGNoZWNrKGAke3JlcG9EaXJ9LyR7ZW50cnkubmFtZX1gKTtcbiAgICB9XG4gIH0gY2F0Y2gge1xuICAgIC8vIFVucmVhZGFibGUgcmVwbyDigJQgbm90aGluZyBmb3VuZC5cbiAgfVxuICByZXR1cm4gZm91bmQ7XG59XG5cbi8qKlxuICogRGVjaWRlIHdoaWNoIGFydGVmYWN0IGRpcnMgZ286IGV2ZXJ5IG9uZSBwYXN0IHRoZSBhZ2UgbGltaXQsIHRoZW4gdGhlXG4gKiBvbGRlc3QgdW50aWwgdGhlIHJlc3QgZml0IHVuZGVyIHRoZSBjYXAuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzZWxlY3RBcnRlZmFjdHNUb1JlbW92ZShcbiAgcmVjb3JkczogcmVhZG9ubHkgQXJ0ZWZhY3RSZWNvcmRbXSxcbiAgbWF4QWdlRGF5czogbnVtYmVyLFxuICBtYXhUb3RhbEJ5dGVzOiBudW1iZXIsXG4pOiBBcnRlZmFjdFJlY29yZFtdIHtcbiAgY29uc3QgcmVtb3ZlID0gbmV3IFNldDxBcnRlZmFjdFJlY29yZD4oKTtcbiAgZm9yIChjb25zdCByIG9mIHJlY29yZHMpIHtcbiAgICBpZiAoci5hZ2VEYXlzID4gbWF4QWdlRGF5cykgcmVtb3ZlLmFkZChyKTtcbiAgfVxuICBsZXQgcmVtYWluaW5nID0gcmVjb3Jkcy5maWx0ZXIoKHIpID0+ICFyZW1vdmUuaGFzKHIpKTtcbiAgbGV0IHRvdGFsID0gcmVtYWluaW5nLnJlZHVjZSgoc3VtLCByKSA9PiBzdW0gKyByLmJ5dGVzLCAwKTtcbiAgcmVtYWluaW5nID0gWy4uLnJlbWFpbmluZ10uc29ydCgoYSwgYikgPT4gYi5hZ2VEYXlzIC0gYS5hZ2VEYXlzKTtcbiAgZm9yIChjb25zdCByIG9mIHJlbWFpbmluZykge1xuICAgIGlmICh0b3RhbCA8PSBtYXhUb3RhbEJ5dGVzKSBicmVhaztcbiAgICByZW1vdmUuYWRkKHIpO1xuICAgIHRvdGFsIC09IHIuYnl0ZXM7XG4gIH1cbiAgcmV0dXJuIHJlY29yZHMuZmlsdGVyKChyKSA9PiByZW1vdmUuaGFzKHIpKTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gcmVtb3ZlRGlyKHBhdGg6IHN0cmluZywgZXJyb3JzOiBzdHJpbmdbXSk6IFByb21pc2U8Ym9vbGVhbj4ge1xuICB0cnkge1xuICAgIGF3YWl0IERlbm8ucmVtb3ZlKHBhdGgsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIHJldHVybiB0cnVlO1xuICB9IGNhdGNoIChlcnIpIHtcbiAgICBjb25zdCBtc2cgPSBlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVycik7XG4gICAgZXJyb3JzLnB1c2goYGNvdWxkIG5vdCByZW1vdmUgJHtwYXRofTogJHttc2d9YCk7XG4gICAgcmVjb3JkRmF1bHRFdmVudChcbiAgICAgIFwiY2F0Y2hfYmxvY2tfd2FybmluZ1wiLFxuICAgICAgYHdvcmstdm9sdW1lLXBydW5lIGNvdWxkIG5vdCByZW1vdmUgJHtwYXRofTogJHttc2d9YCxcbiAgICApO1xuICAgIHJldHVybiBmYWxzZTtcbiAgfVxufVxuXG4vKiogUnVuIGFsbCB0aHJlZSBzd2VlcHMuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gcHJ1bmVXb3JrVm9sdW1lKFxuICBvcHRpb25zOiBXb3JrVm9sdW1lUHJ1bmVPcHRpb25zLFxuKTogUHJvbWlzZTxXb3JrVm9sdW1lUHJ1bmVSZXN1bHQ+IHtcbiAgY29uc3Qgd29ya0RpciA9IG9wdGlvbnMud29ya0RpcjtcbiAgY29uc3Qgbm93ID0gKG9wdGlvbnMubm93Rm4gPz8gKCgpID0+IE1hdGguZmxvb3IoRGF0ZS5ub3coKSAvIDEwMDApKSkoKTtcbiAgY29uc3Qgc2l6ZU9mID0gb3B0aW9ucy5zaXplT2YgPz8gZHVCeXRlcztcbiAgLy8gVGhlIGluamVjdGVkIGNsb2NrIHJlYWNoZXMgdGhlIGxpdmVuZXNzIGNoZWNrIHRvbywgc28gYSB0ZXN0J3MgYG5vd2AgYW5kXG4gIC8vIHRoZSBoZWFydGJlYXQncyBlcG9jaCBhcmUgcmVhZCBvbiB0aGUgc2FtZSB0aW1lbGluZS5cbiAgY29uc3QgaXNSZXBvQWN0aXZlID0gb3B0aW9ucy5pc1JlcG9BY3RpdmUgPz9cbiAgICAoKGRpcjogc3RyaW5nLCByZXBvOiBzdHJpbmcpID0+IHJlcG9IYXNIZWFydGJlYXQoZGlyLCByZXBvLCBub3cpKTtcbiAgY29uc3QgYXJ0ZWZhY3RNYXhBZ2VEYXlzID0gb3B0aW9ucy5hcnRlZmFjdE1heEFnZURheXMgPz9cbiAgICBERUZBVUxUX0FSVEVGQUNUX01BWF9BR0VfREFZUztcbiAgY29uc3QgYXJ0ZWZhY3RNYXhUb3RhbEJ5dGVzID0gb3B0aW9ucy5hcnRlZmFjdE1heFRvdGFsQnl0ZXMgPz9cbiAgICBERUZBVUxUX0FSVEVGQUNUX01BWF9UT1RBTF9CWVRFUztcbiAgY29uc3Qgc2NyYXRjaE1heEFnZVNlY29uZHMgPVxuICAgIChvcHRpb25zLnNjcmF0Y2hNYXhBZ2VIb3VycyA/PyBERUZBVUxUX1NDUkFUQ0hfTUFYX0FHRV9IT1VSUykgKiAzNjAwO1xuICBjb25zdCBtYXJrZXJNYXhBZ2VTZWNvbmRzID1cbiAgICAob3B0aW9ucy5tYXJrZXJNYXhBZ2VEYXlzID8/IERFRkFVTFRfTUFSS0VSX01BWF9BR0VfREFZUykgKiA4NjQwMDtcblxuICBjb25zdCByZXN1bHQ6IFdvcmtWb2x1bWVQcnVuZVJlc3VsdCA9IHtcbiAgICBhcnRlZmFjdHM6IHtcbiAgICAgIHNjYW5uZWQ6IFtdLFxuICAgICAgcmVtb3ZlZDogW10sXG4gICAgICBza2lwcGVkQWN0aXZlOiBbXSxcbiAgICAgIGJ5dGVzUmVjbGFpbWVkOiAwLFxuICAgIH0sXG4gICAgc2NyYXRjaDogeyByZW1vdmVkOiBbXSB9LFxuICAgIG1hcmtlcnM6IHsgcmVtb3ZlZDogW10gfSxcbiAgICBlcnJvcnM6IFtdLFxuICB9O1xuXG4gIGNvbnN0IGVudHJpZXM6IERlbm8uRGlyRW50cnlbXSA9IFtdO1xuICB0cnkge1xuICAgIGZvciBhd2FpdCAoY29uc3QgZW50cnkgb2YgRGVuby5yZWFkRGlyKHdvcmtEaXIpKSBlbnRyaWVzLnB1c2goZW50cnkpO1xuICB9IGNhdGNoIChlcnIpIHtcbiAgICByZXN1bHQuZXJyb3JzLnB1c2goXG4gICAgICBgY2Fubm90IHJlYWQgJHt3b3JrRGlyfTogJHtlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogZXJyfWAsXG4gICAgKTtcbiAgICByZXR1cm4gcmVzdWx0O1xuICB9XG5cbiAgLy8gMS4gQnVpbGQgYXJ0ZWZhY3RzIOKAlCBpbiB0aGUgc2hhcmVkIGNsb25lcywgYW5kIGluIGV2ZXJ5IGxhbmUgd29ya3RyZWVcbiAgLy8gICAgKElzc3VlICMxNzI1KSwgd2hpY2ggYnVpbGQgaW4gdGhlaXIgb3duIHRyZWVzIGFuZCBhcmUgb25seSBjbGVhbmVkXG4gIC8vICAgIHdoZW4gdGhlIGxhbmUgbmV4dCByZXVzZXMgdGhhdCByZXBvc2l0b3J5LlxuICBjb25zdCBjbG9uZXM6IHsgcmVwbzogc3RyaW5nOyBsYWJlbDogc3RyaW5nOyBwYXRoOiBzdHJpbmcgfVtdID0gW107XG4gIGZvciAoY29uc3QgZW50cnkgb2YgZW50cmllcykge1xuICAgIGlmICghZW50cnkuaXNEaXJlY3RvcnkgfHwgZW50cnkubmFtZS5zdGFydHNXaXRoKFwiLlwiKSkgY29udGludWU7XG4gICAgaWYgKGlzUmVzZXJ2ZWRXb3JrUm9vdEVudHJ5KGVudHJ5Lm5hbWUpKSBjb250aW51ZTtcbiAgICBjb25zdCByZXBvRGlyID0gYCR7d29ya0Rpcn0vJHtlbnRyeS5uYW1lfWA7XG4gICAgaWYgKCEoYXdhaXQgZXhpc3RzKGAke3JlcG9EaXJ9Ly5naXRgKSkpIGNvbnRpbnVlO1xuICAgIGNsb25lcy5wdXNoKHsgcmVwbzogZW50cnkubmFtZSwgbGFiZWw6IGVudHJ5Lm5hbWUsIHBhdGg6IHJlcG9EaXIgfSk7XG4gIH1cbiAgY2xvbmVzLnB1c2goLi4uKGF3YWl0IGxpc3RMYW5lV29ya3RyZWVzKHdvcmtEaXIpKSk7XG4gIGZvciAoY29uc3QgY2xvbmUgb2YgY2xvbmVzKSB7XG4gICAgY29uc3QgdGFyZ2V0cyA9IGF3YWl0IGZpbmRDYXJnb1RhcmdldHMoY2xvbmUucGF0aCk7XG4gICAgaWYgKHRhcmdldHMubGVuZ3RoID09PSAwKSBjb250aW51ZTtcbiAgICAvLyBLZXllZCBvbiB0aGUgcmVwb3NpdG9yeSwgbm90IHRoZSBkaXJlY3Rvcnk6IGEgbGl2ZSBoZWFydGJlYXQgZm9yIHRoZVxuICAgIC8vIHJlcG9zaXRvcnkgcHJvdGVjdHMgdGhlIHNoYXJlZCBjbG9uZSBhbmQgZXZlcnkgbGFuZSdzIHdvcmt0cmVlIG9mIGl0LlxuICAgIGlmIChhd2FpdCBpc1JlcG9BY3RpdmUod29ya0RpciwgY2xvbmUucmVwbykpIHtcbiAgICAgIHJlc3VsdC5hcnRlZmFjdHMuc2tpcHBlZEFjdGl2ZS5wdXNoKGNsb25lLmxhYmVsKTtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBmb3IgKGNvbnN0IHRhcmdldCBvZiB0YXJnZXRzKSB7XG4gICAgICBjb25zdCBieXRlcyA9IChhd2FpdCBzaXplT2YodGFyZ2V0KSkgPz8gMDtcbiAgICAgIGNvbnN0IG5ld2VzdCA9IGF3YWl0IG5ld2VzdE10aW1lU2hhbGxvdyh0YXJnZXQpO1xuICAgICAgY29uc3QgYWdlRGF5cyA9IG5ld2VzdCA9PT0gbnVsbCA/IEluZmluaXR5IDogKG5vdyAtIG5ld2VzdCkgLyA4NjQwMDtcbiAgICAgIHJlc3VsdC5hcnRlZmFjdHMuc2Nhbm5lZC5wdXNoKHtcbiAgICAgICAgcmVwbzogY2xvbmUubGFiZWwsXG4gICAgICAgIHBhdGg6IHRhcmdldCxcbiAgICAgICAgYnl0ZXMsXG4gICAgICAgIGFnZURheXMsXG4gICAgICB9KTtcbiAgICB9XG4gIH1cbiAgZm9yIChcbiAgICBjb25zdCByZWNvcmQgb2Ygc2VsZWN0QXJ0ZWZhY3RzVG9SZW1vdmUoXG4gICAgICByZXN1bHQuYXJ0ZWZhY3RzLnNjYW5uZWQsXG4gICAgICBhcnRlZmFjdE1heEFnZURheXMsXG4gICAgICBhcnRlZmFjdE1heFRvdGFsQnl0ZXMsXG4gICAgKVxuICApIHtcbiAgICBpZiAoYXdhaXQgcmVtb3ZlRGlyKHJlY29yZC5wYXRoLCByZXN1bHQuZXJyb3JzKSkge1xuICAgICAgcmVzdWx0LmFydGVmYWN0cy5yZW1vdmVkLnB1c2gocmVjb3JkKTtcbiAgICAgIHJlc3VsdC5hcnRlZmFjdHMuYnl0ZXNSZWNsYWltZWQgKz0gcmVjb3JkLmJ5dGVzO1xuICAgIH1cbiAgfVxuXG4gIGlmIChvcHRpb25zLmFydGVmYWN0c09ubHkpIHJldHVybiByZXN1bHQ7XG5cbiAgLy8gMi4gU2NyYXRjaCBkaXJlY3RvcmllcyBpbiB0aGUgd29yayByb290LlxuICBmb3IgKGNvbnN0IGVudHJ5IG9mIGVudHJpZXMpIHtcbiAgICBpZiAoIWVudHJ5LmlzRGlyZWN0b3J5IHx8ICFlbnRyeS5uYW1lLnN0YXJ0c1dpdGgoXCIuXCIpKSBjb250aW51ZTtcbiAgICBpZiAoV09SS19ST09UX1NUQVRFX0RJUlMuaGFzKGVudHJ5Lm5hbWUpKSBjb250aW51ZTtcbiAgICBpZiAoaXNSZXNlcnZlZFdvcmtSb290RW50cnkoZW50cnkubmFtZSkpIGNvbnRpbnVlO1xuICAgIGNvbnN0IHBhdGggPSBgJHt3b3JrRGlyfS8ke2VudHJ5Lm5hbWV9YDtcbiAgICBjb25zdCBtID0gYXdhaXQgbXRpbWVFcG9jaChwYXRoKTtcbiAgICBpZiAobSAhPT0gbnVsbCAmJiBub3cgLSBtIDwgc2NyYXRjaE1heEFnZVNlY29uZHMpIGNvbnRpbnVlO1xuICAgIGlmIChhd2FpdCByZW1vdmVEaXIocGF0aCwgcmVzdWx0LmVycm9ycykpIHtcbiAgICAgIHJlc3VsdC5zY3JhdGNoLnJlbW92ZWQucHVzaChlbnRyeS5uYW1lKTtcbiAgICB9XG4gIH1cblxuICAvLyAzLiBTdGFsZSBtYXJrZXIgc3RhdGUgZmlsZXMuXG4gIGZvciAoY29uc3QgZW50cnkgb2YgZW50cmllcykge1xuICAgIGlmICghZW50cnkuaXNGaWxlIHx8ICFlbnRyeS5uYW1lLnN0YXJ0c1dpdGgoXCIuaGVhcnRiZWF0LW1hcmtlcl9cIikpIGNvbnRpbnVlO1xuICAgIGNvbnN0IHBhdGggPSBgJHt3b3JrRGlyfS8ke2VudHJ5Lm5hbWV9YDtcbiAgICBjb25zdCBtID0gYXdhaXQgbXRpbWVFcG9jaChwYXRoKTtcbiAgICBpZiAobSA9PT0gbnVsbCB8fCBub3cgLSBtIDwgbWFya2VyTWF4QWdlU2Vjb25kcykgY29udGludWU7XG4gICAgdHJ5IHtcbiAgICAgIGF3YWl0IERlbm8ucmVtb3ZlKHBhdGgpO1xuICAgICAgcmVzdWx0Lm1hcmtlcnMucmVtb3ZlZC5wdXNoKGVudHJ5Lm5hbWUpO1xuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgcmVzdWx0LmVycm9ycy5wdXNoKFxuICAgICAgICBgY291bGQgbm90IHJlbW92ZSAke3BhdGh9OiAke2VyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBlcnJ9YCxcbiAgICAgICk7XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIHJlc3VsdDtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGZvcm1hdEdiKGJ5dGVzOiBudW1iZXIpOiBzdHJpbmcge1xuICByZXR1cm4gYCR7KGJ5dGVzIC8gR0lCKS50b0ZpeGVkKDEpfSBHQmA7XG59XG5cbi8qKiBPbmUtbGluZSBzdW1tYXJ5IGZvciB0aGUgaG91c2VrZWVwaW5nIGxvZy4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzdW1tYXJpc2VXb3JrVm9sdW1lUHJ1bmUocjogV29ya1ZvbHVtZVBydW5lUmVzdWx0KTogc3RyaW5nIHtcbiAgY29uc3Qgc2Nhbm5lZEJ5dGVzID0gci5hcnRlZmFjdHMuc2Nhbm5lZC5yZWR1Y2UoKHMsIGEpID0+IHMgKyBhLmJ5dGVzLCAwKTtcbiAgY29uc3QgcGFydHMgPSBbXG4gICAgYGFydGVmYWN0czogJHtyLmFydGVmYWN0cy5zY2FubmVkLmxlbmd0aH0gdGFyZ2V0IGRpcihzKSAke1xuICAgICAgZm9ybWF0R2Ioc2Nhbm5lZEJ5dGVzKVxuICAgIH0sIHJlbW92ZWQgJHtyLmFydGVmYWN0cy5yZW1vdmVkLmxlbmd0aH0gKCR7XG4gICAgICBmb3JtYXRHYihyLmFydGVmYWN0cy5ieXRlc1JlY2xhaW1lZClcbiAgICB9KWAgK1xuICAgIC8vIE5hbWUgd2hhdCB3ZW50LCBsYXJnZXN0IGZpcnN0IChJc3N1ZSAjMTcyNSk6IGEgcmVjbGFpbSB0aGF0IHNheXNcbiAgICAvLyBcInJlbW92ZWQgM1wiIGJlc2lkZSBhIDM2IEdCIGRyb3Agc2hvdWxkIHNheSB3aGVyZSB0aGUgMzYgR0Igd2FzLlxuICAgIChyLmFydGVmYWN0cy5yZW1vdmVkLmxlbmd0aCA+IDBcbiAgICAgID8gYCDigJQgJHtcbiAgICAgICAgWy4uLnIuYXJ0ZWZhY3RzLnJlbW92ZWRdXG4gICAgICAgICAgLnNvcnQoKGEsIGIpID0+IGIuYnl0ZXMgLSBhLmJ5dGVzKVxuICAgICAgICAgIC5zbGljZSgwLCAzKVxuICAgICAgICAgIC5tYXAoKGEpID0+IGAke2EucmVwb30vdGFyZ2V0ICR7Zm9ybWF0R2IoYS5ieXRlcyl9YClcbiAgICAgICAgICAuam9pbihcIiwgXCIpXG4gICAgICB9JHtyLmFydGVmYWN0cy5yZW1vdmVkLmxlbmd0aCA+IDMgPyBcIiwg4oCmXCIgOiBcIlwifWBcbiAgICAgIDogXCJcIikgK1xuICAgIChyLmFydGVmYWN0cy5za2lwcGVkQWN0aXZlLmxlbmd0aCA+IDBcbiAgICAgID8gYCwgc2tpcHBlZCBhY3RpdmUgJHtyLmFydGVmYWN0cy5za2lwcGVkQWN0aXZlLmpvaW4oXCIsIFwiKX1gXG4gICAgICA6IFwiXCIpLFxuICAgIGBzY3JhdGNoOiByZW1vdmVkICR7ci5zY3JhdGNoLnJlbW92ZWQubGVuZ3RofWAgK1xuICAgIChyLnNjcmF0Y2gucmVtb3ZlZC5sZW5ndGggPiAwID8gYCAoJHtyLnNjcmF0Y2gucmVtb3ZlZC5qb2luKFwiLCBcIil9KWAgOiBcIlwiKSxcbiAgICBgbWFya2VyczogcmVtb3ZlZCAke3IubWFya2Vycy5yZW1vdmVkLmxlbmd0aH1gLFxuICBdO1xuICBpZiAoci5lcnJvcnMubGVuZ3RoID4gMCkgcGFydHMucHVzaChgZXJyb3JzOiAke3IuZXJyb3JzLmpvaW4oXCI7IFwiKX1gKTtcbiAgcmV0dXJuIHBhcnRzLmpvaW4oXCIgfCBcIik7XG59XG4iXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUE7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7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
// denoCacheMetadata=3053864705581653620,6730675579772112794