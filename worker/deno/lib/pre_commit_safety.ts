/**
 * Pre-commit safety gate (Issue #1758, part of #1751).
 *
 * Scans the staged file list before any worker `git commit` and refuses
 * the commit when hidden or secret-bearing files are staged — including
 * the non-hidden private-key and credential filenames added by Issue
 * #3660 (`*.pem`, `*.key`, `*.p12`, `*.pfx`, `id_rsa`, `credentials.json`,
 * `service-account*.json`).
 *
 * Defence-in-depth: protects even when `.gitignore` is missing, has been
 * bypassed (`git add -f`), or the canonical patterns from #1757 have
 * not yet been applied to a repo.
 *
 * The allowlist is derived from `REQUIRED_GITIGNORE_PATTERNS` in
 * `gitignore_enforcer.ts` (the single source of truth), so the two
 * layers cannot drift apart.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import type { Result } from "../types.ts";
import type { GitCommandOptions } from "./git_timeout.ts";
import { runGitCommand } from "./git_timeout.ts";
import { REQUIRED_GITIGNORE_PATTERNS } from "./gitignore_enforcer.ts";

/**
 * Hidden top-level paths permitted to be tracked. Derived from
 * `REQUIRED_GITIGNORE_PATTERNS` (entries beginning with `!`) so the
 * allowlist remains a single source of truth.
 */
export const ALLOWED_HIDDEN_PATHS: readonly string[] =
  REQUIRED_GITIGNORE_PATTERNS
    .filter((p) => p.startsWith("!"))
    .map((p) => p.slice(1));

/**
 * Always-forbidden patterns. Each regexp is matched against the full
 * staged path returned by `git diff --cached --name-only -z`. The dotenv,
 * config and secrets-directory patterns below are matched as any path
 * segment (Issue #3311), so `services/api/.env` is caught at any depth —
 * not just at the repo root — mirroring how the slash-free `.gitignore`
 * entries apply at every depth.
 */
export const FORBIDDEN_STAGED_PATTERNS: readonly RegExp[] = [
  // Matched as any path segment (Issue #3311).
  /(^|\/)\.env(\.[^/]*)?(\/|$)/,
  // Matched as any path segment (Issue #3311).
  /(^|\/)\.config[^/]*\.json(\/|$)/,
  // Plain suffix match; a leading `.*` backtracked quadratically (Issue #3316).
  /\.secret\.json$/,
  // Matched as any path segment (Issue #3311).
  /(^|\/)\.secrets\//,
  // Private key material and credential files (Issue #3660). Matched on the
  // final path segment so nested paths (`certs/server.pem`) are caught too.
  /(^|\/)[^/]+\.(pem|key|p12|pfx)$/,
  /(^|\/)id_rsa(\..*)?$/,
  /(^|\/)credentials\.json$/,
  /(^|\/)service-account[^/]*\.json$/,
];

/**
 * Result of inspecting the index for a commit.
 */
export interface InspectStagedResult {
  /** Paths that fail the safety gate and must not be committed. */
  violations: string[];
  /** Paths that pass the safety gate. */
  safe: string[];
}

/**
 * Classify a single staged path as safe or a violation.
 *
 * Order of checks:
 *   1. Explicit forbidden patterns (`.env`, `.config*.json`, `.secrets/`,
 *      etc.), each caught at any depth (Issue #3311), not just at the
 *      repo root.
 *   2. Generic "hidden top-level path outside the allowlist" check —
 *      `^\.[^/]+` minus the entries on the allowlist. The check is
 *      applied to the first path segment so that allowlisted directories
 *      such as `.github/` permit nested files (e.g. `.github/workflows/ci.yml`).
 *
 * @param path Repository-relative path of a staged file.
 * @returns "violation" if the path is forbidden, "safe" otherwise.
 */
export function classifyStagedPath(path: string): "violation" | "safe" {
  for (const re of FORBIDDEN_STAGED_PATTERNS) {
    if (re.test(path)) return "violation";
  }

  if (path.startsWith(".")) {
    const topSegment = path.split("/")[0] ?? path;
    if (!ALLOWED_HIDDEN_PATHS.includes(topSegment)) {
      return "violation";
    }
  }

  return "safe";
}

/**
 * Inspect the git index and classify each staged path.
 *
 * Uses `git diff --cached --name-only -z` so paths containing whitespace
 * are unambiguously separated by NUL bytes.
 *
 * @param options Git command options (cwd, env, timeout).
 * @returns Result with `{ violations, safe }` lists, or an error if the
 *   git command itself failed.
 */
export async function inspectStagedFiles(
  options: GitCommandOptions = {},
): Promise<Result<InspectStagedResult>> {
  const result = await runGitCommand(
    ["diff", "--cached", "--name-only", "-z"],
    options,
  );
  if (!result.ok) return { ok: false, error: result.error };

  if (result.value.code !== 0) {
    const err = result.value.stderr.trim() || result.value.stdout.trim();
    return {
      ok: false,
      error: new Error(`git diff --cached failed: ${err}`),
    };
  }

  const paths = result.value.stdout.split("\0").filter((p) => p.length > 0);

  const violations: string[] = [];
  const safe: string[] = [];
  for (const path of paths) {
    if (classifyStagedPath(path) === "violation") {
      violations.push(path);
    } else {
      safe.push(path);
    }
  }
  return { ok: true, value: { violations, safe } };
}

/**
 * Parse NUL-separated `<mode> <…> <oid>\t<path>` records into a map of
 * path to `"<mode> <oid>"`. Serves both `git ls-files -s -z` (`mode oid
 * stage`) and `git ls-tree -z` (`mode type oid`); `oidField` names which
 * space-separated field holds the object id.
 */
function parseEntries(
  stdout: string,
  oidField: number,
  keep: (fields: string[]) => boolean,
): Map<string, string> {
  const entries = new Map<string, string>();
  for (const record of stdout.split("\0")) {
    const tab = record.indexOf("\t");
    if (tab < 0) continue;
    const fields = record.slice(0, tab).split(" ");
    if (!keep(fields)) continue;
    entries.set(record.slice(tab + 1), `${fields[0]} ${fields[oidField]}`);
  }
  return entries;
}

/**
 * Violations that a merge merely brings in (Issues #2737, #2739).
 *
 * A merge carries every path the merged-in branch changed, so a hidden file
 * that branch already tracks (`.claude/…`) would trip the gate although
 * committing it discloses nothing new. A violation is exempt only when its
 * entry on the candidate — mode and object id — is identical to that path's
 * entry on the merged-in commit. Anything the agent added or modified, a
 * mode change, a deletion, or an unresolved conflict entry is not exempt.
 *
 * The candidate is the index (stage 0 only) while a merge is in progress
 * (`mergedIn` = `MERGE_HEAD`, Issue #2737), or a merge commit already
 * written, judged against its merged-in parent (Issue #2739). The caller
 * owns the claim that `mergedIn` is what the merge brought in.
 *
 * The same comparison serves the default branch's tip (`mergedIn` =
 * `refs/remotes/origin/<default>`, Issue #2774): a path already published
 * there, byte for byte and mode for mode, discloses nothing either.
 *
 * If `mergedIn` or either listing cannot be read, nothing is exempt (fail
 * closed).
 *
 * @param args.violations Paths the classifier refused
 * @param args.mergedIn Ref or SHA of the commit that vouches for a path
 * @param args.candidate Commit whose tree is judged; omitted, the index
 * @param args.reason Why `mergedIn` vouches, for the INFO log line
 * @param args.options Git command options (cwd, env, timeout)
 * @returns The exempt paths (each logged at INFO), possibly empty
 */
export async function mergedInUnchanged(args: {
  violations: string[];
  mergedIn: string;
  candidate?: string;
  reason?: string;
  options: GitCommandOptions;
}): Promise<Set<string>> {
  const {
    violations,
    mergedIn,
    candidate,
    reason = "which the merge brings in",
    options,
  } = args;
  const exempt = new Set<string>();
  if (violations.length === 0) return exempt;
  const resolved = await runGitCommand(
    ["rev-parse", "-q", "--verify", `${mergedIn}^{commit}`],
    options,
  );
  if (!resolved.ok || resolved.value.code !== 0) return exempt;
  const mergeSha = resolved.value.stdout.trim();
  if (!/^[0-9a-f]{40,64}$/.test(mergeSha)) return exempt;

  const listTree = (commit: string) =>
    runGitCommand(
      [
        "--literal-pathspecs",
        "ls-tree",
        "-r",
        "-z",
        "--full-tree",
        commit,
        "--",
        ...violations,
      ],
      options,
    );
  const judged = candidate === undefined
    ? await runGitCommand(
      [
        "--literal-pathspecs",
        "ls-files",
        "-s",
        "-z",
        "--full-name",
        "--",
        ...violations,
      ],
      options,
    )
    : await listTree(candidate);
  const merged = await listTree(mergeSha);
  if (!judged.ok || judged.value.code !== 0) return exempt;
  if (!merged.ok || merged.value.code !== 0) return exempt;

  // The index: stage 0 only, since a conflicted path has stages 1–3 and is
  // never exempt. A tree: blobs only.
  const isBlob = (f: string[]) => f[1] === "blob";
  const judgedEntries = candidate === undefined
    ? parseEntries(judged.value.stdout, 1, (f) => f[2] === "0")
    : parseEntries(judged.value.stdout, 2, isBlob);
  const mergedEntries = parseEntries(merged.value.stdout, 2, isBlob);
  const where = candidate === undefined ? "staged" : `committed (${candidate})`;
  const source = mergedIn === mergeSha ? mergeSha : `${mergedIn} (${mergeSha})`;
  for (const path of violations) {
    const entry = judgedEntries.get(path);
    if (entry !== undefined && entry === mergedEntries.get(path)) {
      exempt.add(path);
      console.log(
        `[pre-commit-safety] INFO: ${path} is exempt from the safety gate ` +
          `(Issues #2737, #2739, #2774): its ${where} blob and mode are ` +
          `identical to ${source}, ${reason}`,
      );
    }
  }
  return exempt;
}

/**
 * The local remote-tracking ref of origin's default branch, read from
 * `refs/remotes/origin/HEAD` without touching the network (Issue #2774).
 * Deliberately not `resolveOriginDefaultBranch()`, which may run
 * `git remote set-head origin --auto` and so contact the remote. Returns
 * `null` — nothing vouches — unless the symbolic ref names a ref under
 * `refs/remotes/origin/`.
 */
async function originDefaultRef(
  options: GitCommandOptions,
): Promise<string | null> {
  const result = await runGitCommand(
    ["symbolic-ref", "-q", "refs/remotes/origin/HEAD"],
    options,
  );
  if (!result.ok || result.value.code !== 0) return null;
  const ref = result.value.stdout.trim();
  return /^refs\/remotes\/origin\/\S+$/.test(ref) &&
      ref !== "refs/remotes/origin/HEAD"
    ? ref
    : null;
}

/**
 * Refuse to proceed when any staged path violates the safety gate.
 *
 * Returns `Ok(void)` when every staged path is safe (including the empty
 * stage). Returns `Err` listing every offending path and the recovery
 * command (`git reset HEAD <file>`). A path a merge in progress brings in
 * unchanged from `MERGE_HEAD` is exempt (Issue #2737), as is a path whose
 * staged blob and mode are identical to that path on the default branch's
 * tip, read from the local `origin/<default>` ref and never fetched (Issue
 * #2774). If that ref cannot be resolved or read, nothing is exempt on its
 * account (fail closed).
 *
 * @param options Git command options (cwd, env, timeout).
 */
export async function assertSafeToCommit(
  options: GitCommandOptions = {},
): Promise<Result<void>> {
  const inspection = await inspectStagedFiles(options);
  if (!inspection.ok) return { ok: false, error: inspection.error };

  if (inspection.value.violations.length === 0) {
    return { ok: true, value: undefined };
  }

  const merged = await mergedInUnchanged({
    violations: inspection.value.violations,
    mergedIn: "MERGE_HEAD",
    options,
  });
  let violations = inspection.value.violations.filter((p) => !merged.has(p));
  const defaultRef = violations.length > 0
    ? await originDefaultRef(options)
    : null;
  if (defaultRef !== null) {
    const published = await mergedInUnchanged({
      violations,
      mergedIn: defaultRef,
      reason: "the default branch's tip, which already publishes it",
      options,
    });
    violations = violations.filter((p) => !published.has(p));
  }
  if (violations.length === 0) {
    return { ok: true, value: undefined };
  }

  const list = violations.map((p) => `  - ${p}`).join("\n");
  return {
    ok: false,
    error: new Error(
      "Pre-commit safety gate refused commit (Issue #1758): the following " +
        "hidden or secret-bearing files are staged:\n" +
        `${list}\n\n` +
        "Remove each one with: git reset HEAD <file>",
    ),
  };
}
