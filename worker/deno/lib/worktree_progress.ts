/**
 * Read-only working-tree progress probe (Issue #4294, part of #4290).
 *
 * Tool activity alone is not proof of progress — an agent can loop on
 * `Read`/`Bash` forever without changing a byte. #4290 defers the one-hour
 * kill only when two independent signals agree: recent tool activity in the
 * stream-json (`agent_progress.ts`) **and** evidence that the checkout is
 * actually advancing. This module is the second signal, standalone and
 * reusable; it changes no timeout behaviour by itself.
 *
 * A probe hashes three cheap git reads into one short digest:
 *
 *   - `git status --porcelain=v1 -z --untracked-files=all` — tracked edits,
 *     staged entries, renames, deletions and every individual untracked file
 *     (`all`, not the default `normal`, so a second file inside an already
 *     untracked directory still moves the digest).
 *   - `git rev-parse HEAD` — new commits on the branch.
 *   - `git diff --shortstat HEAD` — modified line counts, so successive edits
 *     to a file that is already dirty still register.
 *
 * Three hard requirements shape the implementation:
 *
 *   - **Bounded.** Every git call goes through `runWithTimeout` with a short
 *     default ({@link DEFAULT_PROBE_TIMEOUT_MS}); a hung or slow git can never
 *     block the caller.
 *   - **Fail-safe direction is explicit.** A probe error — not a git repo, git
 *     missing, timeout — yields `ok: false`, and comparing any failed probe
 *     yields `unknown`, which is deliberately *distinct* from `unchanged`.
 *     Nothing here throws at the caller. The recommended consuming policy is
 *     that `unknown` is not evidence of progress (so it does not defer a kill)
 *     and not evidence of a stall either — log it and fall back to the other
 *     signal. A sustained run of `unknown` means the probe itself is broken,
 *     not that the tree stopped moving.
 *   - **Read-only.** Only `status`, `rev-parse` and `diff` are issued, each
 *     under `--no-optional-locks` so git will not take `index.lock` or rewrite
 *     the index to refresh its stat cache. The probe runs concurrently with a
 *     live agent session in the same checkout, so it must never contend for a
 *     lock that session needs.
 *
 * **Cost.** Measured against this repo's own checkout (3,595 tracked files,
 * lightly dirty tree, warm cache) inside the container image: median **3.7 ms**
 * per probe wall clock over ten warm runs (min 3.4 ms, max 4.5 ms), dominated
 * by the three git process spawns. At the consumer's check-interval cadence
 * (minutes) that is negligible.
 *
 * One bound caveat: `runWithTimeout` kills the git process, not its
 * descendants, so a probe whose git spawned a hanging child that still holds
 * the output pipes (a sleeping `core.fsmonitor` hook, say) returns its
 * `unknown` verdict only once that child exits. Plain `status`/`rev-parse`/
 * `diff` spawn no such children.
 *
 * Known limitation: an edit that leaves both the porcelain status and the
 * shortstat line counts identical (e.g. rewording one line of an
 * already-modified file) does not move the digest. That is the accepted cost
 * of a probe cheap enough to run against a live checkout — the tool-activity
 * signal covers that window.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { isGitTimeout, runGitCommand } from "./git_timeout.ts";

/** Default per-git-command timeout for a probe: 5 seconds. */
export const DEFAULT_PROBE_TIMEOUT_MS = 5_000;

/** Characters of SHA-256 hex kept in a fingerprint digest. */
const DIGEST_LENGTH = 16;

/** Outcome of comparing two fingerprints. */
export type WorktreeProgressOutcome = "advanced" | "unchanged" | "unknown";

/** A point-in-time fingerprint of a working tree. */
export interface WorktreeFingerprint {
  /** Whether the probe succeeded. False means the digest is meaningless. */
  ok: boolean;
  /** Short hex digest of the tree state, or "" when the probe failed. */
  digest: string;
  /** Commit the tree sits on, "" for a repo with no commits or a failed probe. */
  head: string;
  /** Epoch-ms at which the probe was taken. */
  takenAtMs: number;
  /** Why the probe failed, or "" when it succeeded. */
  reason: string;
}

/** Result of comparing two fingerprints of the same checkout. */
export interface WorktreeProgressComparison {
  /**
   * `advanced` — the tree changed between the two probes.
   * `unchanged` — both probes succeeded and describe an identical tree.
   * `unknown` — at least one probe failed; no conclusion is available.
   */
  outcome: WorktreeProgressOutcome;
  /**
   * How long the tree has been unchanged, in ms — the span between the two
   * probes. Zero for `advanced` and for `unknown`.
   */
  unchangedForMs: number;
  /** Why the outcome is `unknown`, or "" otherwise. */
  reason: string;
}

/** Options for {@link probeWorktreeFingerprint}. */
export interface WorktreeProbeOptions {
  /** Per-git-command timeout in ms. Defaults to {@link DEFAULT_PROBE_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Clock, injectable for tests. Returns epoch ms. */
  now?: () => number;
}

/** Git arguments shared by every probe command — never take optional locks. */
const READ_ONLY_PREFIX = ["--no-optional-locks"] as const;

/** A git read that failed, described for the fingerprint's `reason`. */
interface GitReadFailure {
  reason: string;
}

/** Outcome of one read-only git read: its stdout, or why it failed. */
type GitRead = { ok: true; stdout: string } | { ok: false } & GitReadFailure;

/**
 * Run one read-only git command under a bounded timeout.
 *
 * Never throws: a spawn failure (git missing, directory gone), a non-zero
 * exit (not a git repo) and a timeout all come back as `{ ok: false }` with a
 * human-readable reason.
 */
async function readGit(
  repoDir: string,
  args: string[],
  timeoutMs: number,
): Promise<GitRead> {
  // Issue #1378: through `runGitCommand`, the chokepoint that owns the git
  // timeout, the audit journal and the work-volume fault detector. The
  // generic `runWithTimeout("git", …)` this replaced owned none of them, and
  // the quality gate's literal-string scan could not see it either.
  const result = await runGitCommand([...READ_ONLY_PREFIX, ...args], {
    cwd: repoDir,
    timeoutSeconds: Math.ceil(timeoutMs / 1000),
  });

  if (!result.ok) {
    return {
      ok: false,
      reason: `git ${args[0]} failed: ${result.error.message}`,
    };
  }
  if (isGitTimeout(result.value.code)) {
    return {
      ok: false,
      reason: `git ${args[0]} timed out after ${timeoutMs}ms`,
    };
  }
  if (result.value.code !== 0) {
    const detail = result.value.stderr.split("\n")[0] ?? "";
    return {
      ok: false,
      reason: `git ${args[0]} exited ${result.value.code}: ${detail}`,
    };
  }
  return { ok: true, stdout: result.value.stdout.trim() };
}

/** SHA-256 the given content and keep the leading {@link DIGEST_LENGTH} hex chars. */
async function shortDigest(content: string): Promise<string> {
  const encoded = new TextEncoder().encode(content);
  const hashBuffer = await crypto.subtle.digest("SHA-256", encoded);
  return Array.from(new Uint8Array(hashBuffer))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, DIGEST_LENGTH);
}

/** Build the failed fingerprint for a probe that could not complete. */
function failedProbe(reason: string, takenAtMs: number): WorktreeFingerprint {
  return { ok: false, digest: "", head: "", takenAtMs, reason };
}

/**
 * Fingerprint the working tree of `repoDir` at this moment.
 *
 * Read-only and bounded — see the module doc. Never throws; a probe that
 * cannot complete returns `ok: false` with a reason, which
 * {@link compareWorktreeFingerprints} turns into `unknown`.
 *
 * @param repoDir - Absolute path to a repository checkout.
 * @param options - Timeout and clock overrides.
 * @returns The fingerprint, successful or not.
 */
export async function probeWorktreeFingerprint(
  repoDir: string,
  options?: WorktreeProbeOptions,
): Promise<WorktreeFingerprint> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const now = options?.now ?? Date.now;
  const takenAtMs = now();

  // `status` doubles as the is-this-a-git-repo check: it fails on a plain
  // directory, a missing path, and when git itself is unavailable.
  const status = await readGit(
    repoDir,
    ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    timeoutMs,
  );
  if (!status.ok) {
    return failedProbe(status.reason, takenAtMs);
  }

  // A repo with no commits has no HEAD and no diffable tree — a legitimate
  // state, not a probe failure, so both reads collapse to "".
  const headRead = await readGit(repoDir, ["rev-parse", "HEAD"], timeoutMs);
  const head = headRead.ok ? headRead.stdout : "";

  let shortstat = "";
  if (headRead.ok) {
    const diff = await readGit(
      repoDir,
      ["diff", "--shortstat", "HEAD"],
      timeoutMs,
    );
    if (!diff.ok) {
      return failedProbe(diff.reason, takenAtMs);
    }
    shortstat = diff.stdout;
  }

  const digest = await shortDigest(
    [status.stdout, head, shortstat].join(" -- "),
  );
  return { ok: true, digest, head, takenAtMs, reason: "" };
}

/**
 * Compare two fingerprints of the same checkout.
 *
 * @param previous - The earlier fingerprint (typically the last one at which
 *   the tree was seen to advance).
 * @param current - The fingerprint just taken.
 * @returns Whether the tree advanced, and for how long it has been unchanged.
 */
export function compareWorktreeFingerprints(
  previous: WorktreeFingerprint,
  current: WorktreeFingerprint,
): WorktreeProgressComparison {
  if (!previous.ok || !current.ok) {
    // Deliberately distinct from `unchanged`: two failed probes look
    // identical, and reading that as a stalled tree is exactly the
    // fail-safe inversion this probe must not commit.
    const reason = (!current.ok ? current.reason : previous.reason) ||
      "probe unavailable";
    return { outcome: "unknown", unchangedForMs: 0, reason };
  }

  if (previous.digest !== current.digest) {
    return { outcome: "advanced", unchangedForMs: 0, reason: "" };
  }

  return {
    outcome: "unchanged",
    unchangedForMs: Math.max(0, current.takenAtMs - previous.takenAtMs),
    reason: "",
  };
}
