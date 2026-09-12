/**
 * A cross-host claim on a milestone sync (Issue #2030).
 *
 * Every host that sees the default tip move starts its own merge of the same
 * milestone branch, and every host with budget spends its agent rung on the
 * same conflict. On 2026-09-12 one host resolved and merged a sync while a
 * sibling was 22 minutes into resolving the identical conflict, headed for a
 * non-fast-forward rejection. The sync's attempt ledger is host-local, so
 * nothing on GitHub said "someone is on this".
 *
 * The claim is a hidden ref, `refs/vibe/sync-claims/<milestone-branch>`, on
 * the remote: no branch, no PR, no ruleset. It points at a fresh
 * `commit-tree` object over the milestone tip, so its committer date is the
 * claim time. Taking it is one atomic push with `--force-with-lease`
 * expecting the ref to be absent; a sibling's fresh claim refuses the push
 * and the host moves on; a claim older than the TTL is a host that died
 * mid-sync and is taken over. The claim is deleted when the sync concludes.
 *
 * The fail direction is towards syncing: a claim that cannot be read or
 * written (no push permission, a network fault) is reported as `unknown`,
 * and the caller proceeds exactly as it did before this module existed —
 * duplicate work is the cost of a claim outage; a fleet that stops syncing
 * because it cannot claim is worse.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import type { GitCommandOptions } from "./git_timeout.ts";
import { runGitCommand } from "./git_timeout.ts";
import { assertSafeGitRef } from "./git_ref_args.ts";

/** Where the claims live on the remote. */
export const SYNC_CLAIM_REF_PREFIX = "refs/vibe/sync-claims/";

/** A claim older than this belongs to a host that never released it. */
export const DEFAULT_SYNC_CLAIM_TTL_MS = 2 * 60 * 60 * 1000;

/** The claim ref for a milestone branch. */
export function syncClaimRef(milestoneBranch: string): string {
  assertSafeGitRef(milestoneBranch, "sync claim milestone branch");
  return `${SYNC_CLAIM_REF_PREFIX}${milestoneBranch}`;
}

/** What taking a claim came to. */
export type SyncClaim =
  /** This host holds the claim now. */
  | { kind: "claimed"; ref: string; tookOverStale: boolean }
  /** A sibling holds a claim younger than the TTL. */
  | { kind: "held-elsewhere"; ref: string; ageMs: number }
  /** The claim could not be read or written; the caller proceeds anyway. */
  | { kind: "unknown"; ref: string; reason: string };

/** Inputs for {@link claimMilestoneSync}. */
export interface ClaimRequest {
  milestoneBranch: string;
  /** Git options; `cwd` is the clone (the milestone branch need not be checked out). */
  options: GitCommandOptions;
  /** Names this host in the claim commit's message. */
  hostLabel?: string;
  ttlMs?: number;
  nowMs?: () => number;
}

function describe(
  result: Awaited<ReturnType<typeof runGitCommand>>,
): string {
  if (!result.ok) return result.error.message;
  const detail = (result.value.stderr || result.value.stdout).trim();
  return detail || `git exited ${result.value.code}`;
}

/**
 * Take the claim for a milestone branch's sync, or learn who holds it.
 *
 * @param request - The branch, the clone and the bounds
 * @returns `claimed`, `held-elsewhere` with the holder's claim age, or
 *   `unknown` with the reason
 */
export async function claimMilestoneSync(
  request: ClaimRequest,
): Promise<SyncClaim> {
  const {
    milestoneBranch,
    options,
    hostLabel = "vibe-coder",
    ttlMs = DEFAULT_SYNC_CLAIM_TTL_MS,
    nowMs = () => Date.now(),
  } = request;
  let ref: string;
  try {
    ref = syncClaimRef(milestoneBranch);
  } catch (err) {
    return {
      kind: "unknown",
      ref: `${SYNC_CLAIM_REF_PREFIX}?`,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
  const unknown = (reason: string): SyncClaim => ({
    kind: "unknown",
    ref,
    reason,
  });

  // The claim object: the milestone tip's tree with a fresh commit on top,
  // so the committer date is the claim time and the object is cheap.
  const tip = await runGitCommand(
    [
      "rev-parse",
      "--verify",
      `refs/remotes/origin/${milestoneBranch}^{commit}`,
    ],
    options,
  );
  if (!tip.ok || tip.value.code !== 0) {
    return unknown(`the milestone tip could not be read: ${describe(tip)}`);
  }
  const tipSha = tip.value.stdout.trim();
  const claimCommit = await runGitCommand(
    [
      "commit-tree",
      `${tipSha}^{tree}`,
      "-p",
      tipSha,
      "-m",
      `vibe sync claim ${hostLabel} ${new Date(nowMs()).toISOString()}`,
    ],
    options,
  );
  if (!claimCommit.ok || claimCommit.value.code !== 0) {
    return unknown(
      `the claim commit could not be written: ${describe(claimCommit)}`,
    );
  }
  const claimSha = claimCommit.value.stdout.trim();

  // Atomic take: the push succeeds only if the ref is absent on the remote.
  const took = await runGitCommand(
    ["push", `--force-with-lease=${ref}:`, "origin", `${claimSha}:${ref}`],
    options,
  );
  if (took.ok && took.value.code === 0) {
    return { kind: "claimed", ref, tookOverStale: false };
  }

  // Someone holds it — or the push failed for another reason. Read the
  // holder's claim to tell the two apart.
  const fetched = await runGitCommand(
    ["fetch", "origin", `+${ref}:${ref}`],
    options,
  );
  if (!fetched.ok || fetched.value.code !== 0) {
    return unknown(
      `the claim push was refused (${describe(took)}) and the holder's claim ` +
        `could not be read: ${describe(fetched)}`,
    );
  }
  const stamped = await runGitCommand(
    ["log", "-1", "--format=%ct %H", ref],
    options,
  );
  if (!stamped.ok || stamped.value.code !== 0) {
    return unknown(
      `the holder's claim could not be dated: ${describe(stamped)}`,
    );
  }
  const [epochText, holderSha] = stamped.value.stdout.trim().split(/\s+/);
  const ageMs = nowMs() - Number(epochText) * 1000;
  if (!Number.isFinite(ageMs) || !holderSha) {
    return unknown(
      `the holder's claim was unreadable: ${stamped.value.stdout.trim()}`,
    );
  }
  if (ageMs < ttlMs) return { kind: "held-elsewhere", ref, ageMs };

  // Stale: the holder died mid-sync. Take over, still atomically against
  // the exact stale value, so two hosts cannot both take over at once.
  const tookOver = await runGitCommand(
    [
      "push",
      `--force-with-lease=${ref}:${holderSha}`,
      "origin",
      `${claimSha}:${ref}`,
    ],
    options,
  );
  if (tookOver.ok && tookOver.value.code === 0) {
    return { kind: "claimed", ref, tookOverStale: true };
  }
  return unknown(
    `the stale claim could not be taken over: ${describe(tookOver)}`,
  );
}

/**
 * Release a claim this host took. Best-effort: a claim that cannot be
 * deleted expires by TTL, and the failure is returned for the log rather
 * than thrown — the sync it guarded is already concluded.
 */
export async function releaseMilestoneSyncClaim(
  milestoneBranch: string,
  options: GitCommandOptions,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  let ref: string;
  try {
    ref = syncClaimRef(milestoneBranch);
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
  const deleted = await runGitCommand(["push", "origin", `:${ref}`], options);
  if (deleted.ok && deleted.value.code === 0) return { ok: true };
  return { ok: false, reason: describe(deleted) };
}
