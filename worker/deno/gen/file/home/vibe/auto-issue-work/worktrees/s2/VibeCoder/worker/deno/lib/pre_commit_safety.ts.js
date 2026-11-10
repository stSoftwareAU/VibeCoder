/**
 * Pre-commit safety gate (Issue #1758, part of #1751).
 *
 * Scans the staged file list before any worker `git commit` and refuses
 * the commit when hidden or secret-bearing files are staged — including
 * the non-hidden private-key and credential filenames added by Issue
 * #3660 (`*.pem`, `*.key`, `*.p12`, `*.pfx`, `id_rsa`, `credentials.json`,
 * `service-account*.json`) and, added by Issue #3336, the other OpenSSH
 * private-key names (`id_dsa`, `id_ecdsa`, `id_ed25519`, `id_ecdsa_sk`,
 * `id_ed25519_sk`) and nested credential-store directories (`.ssh/`,
 * `.aws/`, `.gnupg/`, `.netrc`) at any depth.
 *
 * Defence-in-depth: protects even when `.gitignore` is missing, has been
 * bypassed (`git add -f`), or the canonical patterns from #1757 have
 * not yet been applied to a repo.
 *
 * `ALLOWED_HIDDEN_PATHS`, derived from `REQUIRED_GITIGNORE_PATTERNS` in
 * `gitignore_enforcer.ts` (the single source of truth), is not the only way a
 * hidden path can be exempt: a target repo's own tracked, unmodified
 * `.gitignore` may re-allow a hidden path this worker's canonical list does
 * not (Issue #3296) — `.claude/skills` and `.claude/agents` under this very
 * repo's `.gitignore`, for instance. `gitignoreReallowed` below judges that
 * case with `git check-ignore -v -n --no-index` against the repo's own
 * rules, walking the path and its ancestor directories to find the nearest
 * rule that actually decides it, and exempting only when that rule is an
 * explicit `!`-negation in the *root* `.gitignore` — exit 1 from a plain
 * `check-ignore -q` means only "no rule matches", which is equally true of a
 * repo whose `.gitignore` never governs the path at all, so that alone
 * cannot be trusted as a re-allow (PR #3308 review). `HEAD:.gitignore` must
 * also match `.gitignore` on the local `origin/<default>` ref byte for byte, so a
 * re-allow committed only on the branch under review — `.gitignore` is
 * itself on `ALLOWED_HIDDEN_PATHS` — cannot opt a path in that the repo's own
 * default branch has never published (PR #3308 review).
 * `FORBIDDEN_STAGED_PATTERNS` (secret-bearing filenames, including `.aws/`,
 * `.ssh/`, `.gnupg/` and `.netrc`) are never exempt this way, and the check
 * fails closed — nothing is exempt — whenever the repo's `.gitignore` cannot
 * be proven both tracked at `HEAD` and unmodified in both the index and the
 * working tree, whenever it differs from `origin/<default>`'s copy or that
 * ref cannot be resolved, or whenever `check-ignore` itself cannot be run.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */ import { runGitCommand } from "./git_timeout.ts";
import { REQUIRED_GITIGNORE_PATTERNS } from "./gitignore_enforcer.ts";
/**
 * Hidden top-level paths permitted to be tracked. Derived from
 * `REQUIRED_GITIGNORE_PATTERNS` (entries beginning with `!`) so the
 * allowlist remains a single source of truth.
 */ export const ALLOWED_HIDDEN_PATHS = REQUIRED_GITIGNORE_PATTERNS.filter((p)=>p.startsWith("!")).map((p)=>p.slice(1));
/**
 * Always-forbidden patterns. Each regexp is matched against the full
 * staged path returned by `git diff --cached --name-only -z`. The dotenv,
 * config, secrets-directory and credential-store patterns below are
 * matched as any path segment (Issues #3311, #3336), so
 * `services/api/.env` and `deploy/.ssh/id_ed25519` are caught at any
 * depth — not just at the repo root — mirroring how the slash-free
 * `.gitignore` entries apply at every depth.
 */ export const FORBIDDEN_STAGED_PATTERNS = [
  // Matched as any path segment (Issue #3311).
  /(^|\/)\.env(\.[^/]*)?(\/|$)/,
  // Matched as any path segment (Issue #3311).
  /(^|\/)\.config[^/]*\.json(\/|$)/,
  // Plain suffix match; a leading `.*` backtracked quadratically (Issue #3316).
  /\.secret\.json$/,
  // Matched as any path segment (Issue #3311).
  /(^|\/)\.secrets\//,
  // Credential stores, matched as any path segment (Issue #3336).
  /(^|\/)\.(aws|ssh|gnupg|netrc)(\/|$)/,
  // Private key material and credential files (Issue #3660). Matched on the
  // final path segment so nested paths (`certs/server.pem`) are caught too.
  /(^|\/)[^/]+\.(pem|key|p12|pfx)$/,
  // Suffix bounded to one segment and line; `\..*` backtracked quadratically
  // (Issue #3323). Extended to the other OpenSSH private-key names (Issue
  // #3336).
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519|ecdsa_sk|ed25519_sk)(\.[^/\n]*)?$/,
  /(^|\/)credentials\.json$/,
  /(^|\/)service-account[^/]*\.json$/
];
/**
 * Classify a single staged path as safe or a violation.
 *
 * Order of checks:
 *   1. Explicit forbidden patterns (`.env`, `.config*.json`, `.secrets/`,
 *      `.ssh/`, `.aws/`, `.gnupg/`, `.netrc`, etc.), each caught at any
 *      depth (Issues #3311, #3336), not just at the repo root.
 *   2. Generic "hidden top-level path outside the allowlist" check —
 *      `^\.[^/]+` minus the entries on the allowlist. The check is
 *      applied to the first path segment so that allowlisted directories
 *      such as `.github/` permit nested files (e.g. `.github/workflows/ci.yml`).
 *
 * @param path Repository-relative path of a staged file.
 * @returns "violation" if the path is forbidden, "safe" otherwise.
 */ export function classifyStagedPath(path) {
  for (const re of FORBIDDEN_STAGED_PATTERNS){
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
 */ export async function inspectStagedFiles(options = {}) {
  const result = await runGitCommand([
    "diff",
    "--cached",
    "--name-only",
    "-z"
  ], options);
  if (!result.ok) return {
    ok: false,
    error: result.error
  };
  if (result.value.code !== 0) {
    const err = result.value.stderr.trim() || result.value.stdout.trim();
    return {
      ok: false,
      error: new Error(`git diff --cached failed: ${err}`)
    };
  }
  const paths = result.value.stdout.split("\0").filter((p)=>p.length > 0);
  const violations = [];
  const safe = [];
  for (const path of paths){
    if (classifyStagedPath(path) === "violation") {
      violations.push(path);
    } else {
      safe.push(path);
    }
  }
  return {
    ok: true,
    value: {
      violations,
      safe
    }
  };
}
/**
 * Parse NUL-separated `<mode> <…> <oid>\t<path>` records into a map of
 * path to `"<mode> <oid>"`. Serves both `git ls-files -s -z` (`mode oid
 * stage`) and `git ls-tree -z` (`mode type oid`); `oidField` names which
 * space-separated field holds the object id.
 */ function parseEntries(stdout, oidField, keep) {
  const entries = new Map();
  for (const record of stdout.split("\0")){
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
 */ export async function mergedInUnchanged(args) {
  const { violations, mergedIn, candidate, reason = "which the merge brings in", options } = args;
  const exempt = new Set();
  if (violations.length === 0) return exempt;
  const resolved = await runGitCommand([
    "rev-parse",
    "-q",
    "--verify",
    `${mergedIn}^{commit}`
  ], options);
  if (!resolved.ok || resolved.value.code !== 0) return exempt;
  const mergeSha = resolved.value.stdout.trim();
  if (!/^[0-9a-f]{40,64}$/.test(mergeSha)) return exempt;
  const listTree = (commit)=>runGitCommand([
      "--literal-pathspecs",
      "ls-tree",
      "-r",
      "-z",
      "--full-tree",
      commit,
      "--",
      ...violations
    ], options);
  const judged = candidate === undefined ? await runGitCommand([
    "--literal-pathspecs",
    "ls-files",
    "-s",
    "-z",
    "--full-name",
    "--",
    ...violations
  ], options) : await listTree(candidate);
  const merged = await listTree(mergeSha);
  if (!judged.ok || judged.value.code !== 0) return exempt;
  if (!merged.ok || merged.value.code !== 0) return exempt;
  // The index: stage 0 only, since a conflicted path has stages 1–3 and is
  // never exempt. A tree: blobs only.
  const isBlob = (f)=>f[1] === "blob";
  const judgedEntries = candidate === undefined ? parseEntries(judged.value.stdout, 1, (f)=>f[2] === "0") : parseEntries(judged.value.stdout, 2, isBlob);
  const mergedEntries = parseEntries(merged.value.stdout, 2, isBlob);
  const where = candidate === undefined ? "staged" : `committed (${candidate})`;
  const source = mergedIn === mergeSha ? mergeSha : `${mergedIn} (${mergeSha})`;
  for (const path of violations){
    const entry = judgedEntries.get(path);
    if (entry !== undefined && entry === mergedEntries.get(path)) {
      exempt.add(path);
      console.log(`[pre-commit-safety] INFO: ${path} is exempt from the safety gate ` + `(Issues #2737, #2739, #2774): its ${where} blob and mode are ` + `identical to ${source}, ${reason}`);
    }
  }
  return exempt;
}
/** True when `path` matches one of the always-forbidden secret patterns. */ function isForbiddenStagedPath(path) {
  return FORBIDDEN_STAGED_PATTERNS.some((re)=>re.test(path));
}
/**
 * The deciding rule from one `git check-ignore -v -n` output line, or `null`
 * when the line shows no decision (`::` — nothing matched this path at
 * all). Line format: `<source>:<linenum>:<pattern>\t<pathname>`.
 */ function parseCheckIgnoreDecision(line) {
  const tab = line.indexOf("\t");
  if (tab < 0) return null;
  const match = /^([^:]*):(\d*):(.*)$/.exec(line.slice(0, tab));
  const source = match?.[1];
  const pattern = match?.[3];
  if (!source || pattern === undefined) return null;
  return {
    source,
    pattern
  };
}
/**
 * The most specific `git check-ignore -v -n --no-index` decision governing
 * `path` (PR #3308 review hardening of #3296).
 *
 * Walks `path` and its ancestor directories nearest-first (the path itself,
 * then its parent, grandparent, and so on up to the top-level segment),
 * stopping at the first one some rule actually decides. This mirrors how
 * git itself resolves ignore status: a directory explicitly re-allowed by
 * name (e.g. `!.claude/skills`) governs every path beneath it that no more
 * specific rule decides, even though `check-ignore` run on a nested file
 * directly reports no decision (`::`) for that file.
 *
 * Returns `null` — nothing governs, fail closed — when every segment in the
 * chain is undecided (`::`, i.e. exit 1), when any `check-ignore` call
 * cannot be run, or when a "decided" (exit 0) result's output line cannot be
 * parsed. A `null` here is deliberately indistinguishable between "this
 * repo's `.gitignore` never mentions this path" and a tool failure — both
 * must refuse the exemption, not grant it.
 */ async function nearestGovernance(path, options, run) {
  const segments = path.split("/").filter((s)=>s.length > 0);
  for(let depth = segments.length; depth >= 1; depth--){
    const probe = segments.slice(0, depth).join("/");
    const checked = await run([
      "check-ignore",
      "-v",
      "-n",
      "--no-index",
      "--",
      probe
    ], options);
    if (!checked.ok) return null;
    const { code, stdout } = checked.value;
    if (code !== 0 && code !== 1) return null;
    if (code === 1) continue; // nothing decided this segment; walk up.
    return parseCheckIgnoreDecision(stdout.split("\n")[0] ?? "");
  }
  return null;
}
/**
 * Hidden paths a target repo's own `.gitignore` re-allows (Issue #3296).
 *
 * `ALLOWED_HIDDEN_PATHS` is this worker's one canonical list, but a repo may
 * legitimately re-allow a hidden path of its own — this repo's `.gitignore`
 * re-allows `.claude/skills` and `.claude/agents`, for instance — and the
 * gate should not refuse an edit to a file the repo itself tracks on
 * purpose. A path is exempt here only when:
 *
 *   1. It does not match any `FORBIDDEN_STAGED_PATTERNS` entry — secret
 *      filenames and credential-store directories are never exempt this
 *      way, regardless of what any `.gitignore` says.
 *   2. The repo's root `.gitignore` is tracked at `HEAD` and unmodified in
 *      both the index and the working tree — otherwise an agent could opt a
 *      path in within the very commit being judged (via either the staged
 *      content or the on-disk file `check-ignore --no-index` actually
 *      reads), or the check could read a `.gitignore` the repository does
 *      not actually carry forward.
 *   3. `HEAD:.gitignore`'s blob is byte-identical to `.gitignore` on the
 *      local `origin/<default>` ref (PR #3308 review): `.gitignore`
 *      is itself on `ALLOWED_HIDDEN_PATHS`, so one worker commit could carry
 *      a `!`-negation, and a later commit on the *same* branch then stage
 *      the path it re-allows — the repo's own choice would otherwise be
 *      decided by whoever authored the branch, not by what the repo
 *      actually publishes. Unresolvable `origin/HEAD`, a `.gitignore`
 *      missing from either ref, or a `rev-parse` that cannot run, all leave
 *      nothing exempt (fail closed) — the same posture as the #2774
 *      default-branch exemption above.
 *   4. {@link nearestGovernance} finds, for that path or one of its
 *      ancestor directories, an explicit `!`-negation decided by the root
 *      `.gitignore` file itself (source `.gitignore`, not a nested or
 *      untracked one). No decision anywhere in the chain, a decision from
 *      any other source, or a non-negation decision, all leave the path not
 *      exempt — this check fails closed.
 *
 * @param args.violations Paths the classifier refused
 * @param args.options Git command options (cwd, env, timeout)
 * @param args.run Git command runner override (test seam only); defaults to
 *   `runGitCommand`
 * @returns The exempt paths (each logged at INFO), possibly empty
 */ export async function gitignoreReallowed(args) {
  const { violations, options, run = runGitCommand } = args;
  const exempt = new Set();
  const candidates = violations.filter((p)=>!isForbiddenStagedPath(p));
  if (candidates.length === 0) return exempt;
  // The repo's own .gitignore must be tracked at HEAD and unmodified in both
  // the index and the working tree — otherwise nothing it says can be
  // trusted for this commit. The index check catches a `.gitignore` staged
  // with new content; the working-tree check catches an on-disk edit that
  // was never staged at all — `check-ignore --no-index` reads the on-disk
  // file directly, bypassing the index, so either alone could let a commit
  // opt itself in.
  const atHead = await run([
    "cat-file",
    "-e",
    "HEAD:.gitignore"
  ], options);
  if (!atHead.ok || atHead.value.code !== 0) return exempt;
  const unmodifiedIndex = await run([
    "diff",
    "--cached",
    "--quiet",
    "HEAD",
    "--",
    ".gitignore"
  ], options);
  if (!unmodifiedIndex.ok || unmodifiedIndex.value.code !== 0) return exempt;
  const unmodifiedWorkingTree = await run([
    "diff",
    "--quiet",
    "HEAD",
    "--",
    ".gitignore"
  ], options);
  if (!unmodifiedWorkingTree.ok || unmodifiedWorkingTree.value.code !== 0) {
    return exempt;
  }
  // HEAD's own commit is not enough: a re-allow committed earlier on *this*
  // branch is not something the repo's default branch has ever published
  // (PR #3308 review). Require HEAD:.gitignore to be the identical
  // blob as origin/<default>:.gitignore, read from the local remote-tracking
  // ref only — never fetched.
  const defaultRef = await originDefaultRef(options, run);
  if (defaultRef === null) return exempt;
  const headBlob = await run([
    "rev-parse",
    "-q",
    "--verify",
    "HEAD:.gitignore"
  ], options);
  if (!headBlob.ok || headBlob.value.code !== 0) return exempt;
  const defaultBlob = await run([
    "rev-parse",
    "-q",
    "--verify",
    `${defaultRef}:.gitignore`
  ], options);
  if (!defaultBlob.ok || defaultBlob.value.code !== 0) return exempt;
  if (headBlob.value.stdout.trim() !== defaultBlob.value.stdout.trim()) {
    return exempt;
  }
  for (const path of candidates){
    const governance = await nearestGovernance(path, options, run);
    if (governance !== null && governance.source === ".gitignore" && governance.pattern.startsWith("!")) {
      exempt.add(path);
      console.log(`[pre-commit-safety] INFO: ${path} is exempt from the safety gate ` + `(Issue #3296): the repo's own root .gitignore explicitly ` + `re-allows it (rule: ${governance.pattern})`);
    }
  // No decision anywhere in the chain, a decision from a nested/untracked
  // .gitignore, or a non-negation decision: not exempt.
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
 *
 * @param run Git command runner override (test seam only); defaults to
 *   `runGitCommand`.
 */ async function originDefaultRef(options, run = runGitCommand) {
  const result = await run([
    "symbolic-ref",
    "-q",
    "refs/remotes/origin/HEAD"
  ], options);
  if (!result.ok || result.value.code !== 0) return null;
  const ref = result.value.stdout.trim();
  return /^refs\/remotes\/origin\/\S+$/.test(ref) && ref !== "refs/remotes/origin/HEAD" ? ref : null;
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
 * account (fail closed). A remaining hidden-path violation is also exempt
 * when the repo's own tracked, unmodified `.gitignore` re-allows it (Issue
 * #3296) — secret-bearing filenames from `FORBIDDEN_STAGED_PATTERNS` never
 * are, and this check too fails closed.
 *
 * @param options Git command options (cwd, env, timeout).
 */ export async function assertSafeToCommit(options = {}) {
  const inspection = await inspectStagedFiles(options);
  if (!inspection.ok) return {
    ok: false,
    error: inspection.error
  };
  if (inspection.value.violations.length === 0) {
    return {
      ok: true,
      value: undefined
    };
  }
  const merged = await mergedInUnchanged({
    violations: inspection.value.violations,
    mergedIn: "MERGE_HEAD",
    options
  });
  let violations = inspection.value.violations.filter((p)=>!merged.has(p));
  const defaultRef = violations.length > 0 ? await originDefaultRef(options) : null;
  if (defaultRef !== null) {
    const published = await mergedInUnchanged({
      violations,
      mergedIn: defaultRef,
      reason: "the default branch's tip, which already publishes it",
      options
    });
    violations = violations.filter((p)=>!published.has(p));
  }
  if (violations.length > 0) {
    const reallowed = await gitignoreReallowed({
      violations,
      options
    });
    violations = violations.filter((p)=>!reallowed.has(p));
  }
  if (violations.length === 0) {
    return {
      ok: true,
      value: undefined
    };
  }
  const list = violations.map((p)=>`  - ${p}`).join("\n");
  return {
    ok: false,
    error: new Error("Pre-commit safety gate refused commit (Issue #1758): the following " + "hidden or secret-bearing files are staged:\n" + `${list}\n\n` + "Remove each one with: git reset HEAD <file>")
  };
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9wcmVfY29tbWl0X3NhZmV0eS50cyJdLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIFByZS1jb21taXQgc2FmZXR5IGdhdGUgKElzc3VlICMxNzU4LCBwYXJ0IG9mICMxNzUxKS5cbiAqXG4gKiBTY2FucyB0aGUgc3RhZ2VkIGZpbGUgbGlzdCBiZWZvcmUgYW55IHdvcmtlciBgZ2l0IGNvbW1pdGAgYW5kIHJlZnVzZXNcbiAqIHRoZSBjb21taXQgd2hlbiBoaWRkZW4gb3Igc2VjcmV0LWJlYXJpbmcgZmlsZXMgYXJlIHN0YWdlZCDigJQgaW5jbHVkaW5nXG4gKiB0aGUgbm9uLWhpZGRlbiBwcml2YXRlLWtleSBhbmQgY3JlZGVudGlhbCBmaWxlbmFtZXMgYWRkZWQgYnkgSXNzdWVcbiAqICMzNjYwIChgKi5wZW1gLCBgKi5rZXlgLCBgKi5wMTJgLCBgKi5wZnhgLCBgaWRfcnNhYCwgYGNyZWRlbnRpYWxzLmpzb25gLFxuICogYHNlcnZpY2UtYWNjb3VudCouanNvbmApIGFuZCwgYWRkZWQgYnkgSXNzdWUgIzMzMzYsIHRoZSBvdGhlciBPcGVuU1NIXG4gKiBwcml2YXRlLWtleSBuYW1lcyAoYGlkX2RzYWAsIGBpZF9lY2RzYWAsIGBpZF9lZDI1NTE5YCwgYGlkX2VjZHNhX3NrYCxcbiAqIGBpZF9lZDI1NTE5X3NrYCkgYW5kIG5lc3RlZCBjcmVkZW50aWFsLXN0b3JlIGRpcmVjdG9yaWVzIChgLnNzaC9gLFxuICogYC5hd3MvYCwgYC5nbnVwZy9gLCBgLm5ldHJjYCkgYXQgYW55IGRlcHRoLlxuICpcbiAqIERlZmVuY2UtaW4tZGVwdGg6IHByb3RlY3RzIGV2ZW4gd2hlbiBgLmdpdGlnbm9yZWAgaXMgbWlzc2luZywgaGFzIGJlZW5cbiAqIGJ5cGFzc2VkIChgZ2l0IGFkZCAtZmApLCBvciB0aGUgY2Fub25pY2FsIHBhdHRlcm5zIGZyb20gIzE3NTcgaGF2ZVxuICogbm90IHlldCBiZWVuIGFwcGxpZWQgdG8gYSByZXBvLlxuICpcbiAqIGBBTExPV0VEX0hJRERFTl9QQVRIU2AsIGRlcml2ZWQgZnJvbSBgUkVRVUlSRURfR0lUSUdOT1JFX1BBVFRFUk5TYCBpblxuICogYGdpdGlnbm9yZV9lbmZvcmNlci50c2AgKHRoZSBzaW5nbGUgc291cmNlIG9mIHRydXRoKSwgaXMgbm90IHRoZSBvbmx5IHdheSBhXG4gKiBoaWRkZW4gcGF0aCBjYW4gYmUgZXhlbXB0OiBhIHRhcmdldCByZXBvJ3Mgb3duIHRyYWNrZWQsIHVubW9kaWZpZWRcbiAqIGAuZ2l0aWdub3JlYCBtYXkgcmUtYWxsb3cgYSBoaWRkZW4gcGF0aCB0aGlzIHdvcmtlcidzIGNhbm9uaWNhbCBsaXN0IGRvZXNcbiAqIG5vdCAoSXNzdWUgIzMyOTYpIOKAlCBgLmNsYXVkZS9za2lsbHNgIGFuZCBgLmNsYXVkZS9hZ2VudHNgIHVuZGVyIHRoaXMgdmVyeVxuICogcmVwbydzIGAuZ2l0aWdub3JlYCwgZm9yIGluc3RhbmNlLiBgZ2l0aWdub3JlUmVhbGxvd2VkYCBiZWxvdyBqdWRnZXMgdGhhdFxuICogY2FzZSB3aXRoIGBnaXQgY2hlY2staWdub3JlIC12IC1uIC0tbm8taW5kZXhgIGFnYWluc3QgdGhlIHJlcG8ncyBvd25cbiAqIHJ1bGVzLCB3YWxraW5nIHRoZSBwYXRoIGFuZCBpdHMgYW5jZXN0b3IgZGlyZWN0b3JpZXMgdG8gZmluZCB0aGUgbmVhcmVzdFxuICogcnVsZSB0aGF0IGFjdHVhbGx5IGRlY2lkZXMgaXQsIGFuZCBleGVtcHRpbmcgb25seSB3aGVuIHRoYXQgcnVsZSBpcyBhblxuICogZXhwbGljaXQgYCFgLW5lZ2F0aW9uIGluIHRoZSAqcm9vdCogYC5naXRpZ25vcmVgIOKAlCBleGl0IDEgZnJvbSBhIHBsYWluXG4gKiBgY2hlY2staWdub3JlIC1xYCBtZWFucyBvbmx5IFwibm8gcnVsZSBtYXRjaGVzXCIsIHdoaWNoIGlzIGVxdWFsbHkgdHJ1ZSBvZiBhXG4gKiByZXBvIHdob3NlIGAuZ2l0aWdub3JlYCBuZXZlciBnb3Zlcm5zIHRoZSBwYXRoIGF0IGFsbCwgc28gdGhhdCBhbG9uZVxuICogY2Fubm90IGJlIHRydXN0ZWQgYXMgYSByZS1hbGxvdyAoUFIgIzMzMDggcmV2aWV3KS4gYEhFQUQ6LmdpdGlnbm9yZWAgbXVzdFxuICogYWxzbyBtYXRjaCBgLmdpdGlnbm9yZWAgb24gdGhlIGxvY2FsIGBvcmlnaW4vPGRlZmF1bHQ+YCByZWYgYnl0ZSBmb3IgYnl0ZSwgc28gYVxuICogcmUtYWxsb3cgY29tbWl0dGVkIG9ubHkgb24gdGhlIGJyYW5jaCB1bmRlciByZXZpZXcg4oCUIGAuZ2l0aWdub3JlYCBpc1xuICogaXRzZWxmIG9uIGBBTExPV0VEX0hJRERFTl9QQVRIU2Ag4oCUIGNhbm5vdCBvcHQgYSBwYXRoIGluIHRoYXQgdGhlIHJlcG8ncyBvd25cbiAqIGRlZmF1bHQgYnJhbmNoIGhhcyBuZXZlciBwdWJsaXNoZWQgKFBSICMzMzA4IHJldmlldykuXG4gKiBgRk9SQklEREVOX1NUQUdFRF9QQVRURVJOU2AgKHNlY3JldC1iZWFyaW5nIGZpbGVuYW1lcywgaW5jbHVkaW5nIGAuYXdzL2AsXG4gKiBgLnNzaC9gLCBgLmdudXBnL2AgYW5kIGAubmV0cmNgKSBhcmUgbmV2ZXIgZXhlbXB0IHRoaXMgd2F5LCBhbmQgdGhlIGNoZWNrXG4gKiBmYWlscyBjbG9zZWQg4oCUIG5vdGhpbmcgaXMgZXhlbXB0IOKAlCB3aGVuZXZlciB0aGUgcmVwbydzIGAuZ2l0aWdub3JlYCBjYW5ub3RcbiAqIGJlIHByb3ZlbiBib3RoIHRyYWNrZWQgYXQgYEhFQURgIGFuZCB1bm1vZGlmaWVkIGluIGJvdGggdGhlIGluZGV4IGFuZCB0aGVcbiAqIHdvcmtpbmcgdHJlZSwgd2hlbmV2ZXIgaXQgZGlmZmVycyBmcm9tIGBvcmlnaW4vPGRlZmF1bHQ+YCdzIGNvcHkgb3IgdGhhdFxuICogcmVmIGNhbm5vdCBiZSByZXNvbHZlZCwgb3Igd2hlbmV2ZXIgYGNoZWNrLWlnbm9yZWAgaXRzZWxmIGNhbm5vdCBiZSBydW4uXG4gKlxuICogVXNlcyBBdXN0cmFsaWFuIEVuZ2xpc2ggdGhyb3VnaG91dCAoYmVoYXZpb3VyLCBjb2xvdXIsIG9yZ2FuaXNhdGlvbikuXG4gKi9cblxuaW1wb3J0IHR5cGUgeyBSZXN1bHQgfSBmcm9tIFwiLi4vdHlwZXMudHNcIjtcbmltcG9ydCB0eXBlIHsgR2l0Q29tbWFuZE9wdGlvbnMgfSBmcm9tIFwiLi9naXRfdGltZW91dC50c1wiO1xuaW1wb3J0IHsgcnVuR2l0Q29tbWFuZCB9IGZyb20gXCIuL2dpdF90aW1lb3V0LnRzXCI7XG5pbXBvcnQgeyBSRVFVSVJFRF9HSVRJR05PUkVfUEFUVEVSTlMgfSBmcm9tIFwiLi9naXRpZ25vcmVfZW5mb3JjZXIudHNcIjtcblxuLyoqXG4gKiBIaWRkZW4gdG9wLWxldmVsIHBhdGhzIHBlcm1pdHRlZCB0byBiZSB0cmFja2VkLiBEZXJpdmVkIGZyb21cbiAqIGBSRVFVSVJFRF9HSVRJR05PUkVfUEFUVEVSTlNgIChlbnRyaWVzIGJlZ2lubmluZyB3aXRoIGAhYCkgc28gdGhlXG4gKiBhbGxvd2xpc3QgcmVtYWlucyBhIHNpbmdsZSBzb3VyY2Ugb2YgdHJ1dGguXG4gKi9cbmV4cG9ydCBjb25zdCBBTExPV0VEX0hJRERFTl9QQVRIUzogcmVhZG9ubHkgc3RyaW5nW10gPVxuICBSRVFVSVJFRF9HSVRJR05PUkVfUEFUVEVSTlNcbiAgICAuZmlsdGVyKChwKSA9PiBwLnN0YXJ0c1dpdGgoXCIhXCIpKVxuICAgIC5tYXAoKHApID0+IHAuc2xpY2UoMSkpO1xuXG4vKipcbiAqIEFsd2F5cy1mb3JiaWRkZW4gcGF0dGVybnMuIEVhY2ggcmVnZXhwIGlzIG1hdGNoZWQgYWdhaW5zdCB0aGUgZnVsbFxuICogc3RhZ2VkIHBhdGggcmV0dXJuZWQgYnkgYGdpdCBkaWZmIC0tY2FjaGVkIC0tbmFtZS1vbmx5IC16YC4gVGhlIGRvdGVudixcbiAqIGNvbmZpZywgc2VjcmV0cy1kaXJlY3RvcnkgYW5kIGNyZWRlbnRpYWwtc3RvcmUgcGF0dGVybnMgYmVsb3cgYXJlXG4gKiBtYXRjaGVkIGFzIGFueSBwYXRoIHNlZ21lbnQgKElzc3VlcyAjMzMxMSwgIzMzMzYpLCBzb1xuICogYHNlcnZpY2VzL2FwaS8uZW52YCBhbmQgYGRlcGxveS8uc3NoL2lkX2VkMjU1MTlgIGFyZSBjYXVnaHQgYXQgYW55XG4gKiBkZXB0aCDigJQgbm90IGp1c3QgYXQgdGhlIHJlcG8gcm9vdCDigJQgbWlycm9yaW5nIGhvdyB0aGUgc2xhc2gtZnJlZVxuICogYC5naXRpZ25vcmVgIGVudHJpZXMgYXBwbHkgYXQgZXZlcnkgZGVwdGguXG4gKi9cbmV4cG9ydCBjb25zdCBGT1JCSURERU5fU1RBR0VEX1BBVFRFUk5TOiByZWFkb25seSBSZWdFeHBbXSA9IFtcbiAgLy8gTWF0Y2hlZCBhcyBhbnkgcGF0aCBzZWdtZW50IChJc3N1ZSAjMzMxMSkuXG4gIC8oXnxcXC8pXFwuZW52KFxcLlteL10qKT8oXFwvfCQpLyxcbiAgLy8gTWF0Y2hlZCBhcyBhbnkgcGF0aCBzZWdtZW50IChJc3N1ZSAjMzMxMSkuXG4gIC8oXnxcXC8pXFwuY29uZmlnW14vXSpcXC5qc29uKFxcL3wkKS8sXG4gIC8vIFBsYWluIHN1ZmZpeCBtYXRjaDsgYSBsZWFkaW5nIGAuKmAgYmFja3RyYWNrZWQgcXVhZHJhdGljYWxseSAoSXNzdWUgIzMzMTYpLlxuICAvXFwuc2VjcmV0XFwuanNvbiQvLFxuICAvLyBNYXRjaGVkIGFzIGFueSBwYXRoIHNlZ21lbnQgKElzc3VlICMzMzExKS5cbiAgLyhefFxcLylcXC5zZWNyZXRzXFwvLyxcbiAgLy8gQ3JlZGVudGlhbCBzdG9yZXMsIG1hdGNoZWQgYXMgYW55IHBhdGggc2VnbWVudCAoSXNzdWUgIzMzMzYpLlxuICAvKF58XFwvKVxcLihhd3N8c3NofGdudXBnfG5ldHJjKShcXC98JCkvLFxuICAvLyBQcml2YXRlIGtleSBtYXRlcmlhbCBhbmQgY3JlZGVudGlhbCBmaWxlcyAoSXNzdWUgIzM2NjApLiBNYXRjaGVkIG9uIHRoZVxuICAvLyBmaW5hbCBwYXRoIHNlZ21lbnQgc28gbmVzdGVkIHBhdGhzIChgY2VydHMvc2VydmVyLnBlbWApIGFyZSBjYXVnaHQgdG9vLlxuICAvKF58XFwvKVteL10rXFwuKHBlbXxrZXl8cDEyfHBmeCkkLyxcbiAgLy8gU3VmZml4IGJvdW5kZWQgdG8gb25lIHNlZ21lbnQgYW5kIGxpbmU7IGBcXC4uKmAgYmFja3RyYWNrZWQgcXVhZHJhdGljYWxseVxuICAvLyAoSXNzdWUgIzMzMjMpLiBFeHRlbmRlZCB0byB0aGUgb3RoZXIgT3BlblNTSCBwcml2YXRlLWtleSBuYW1lcyAoSXNzdWVcbiAgLy8gIzMzMzYpLlxuICAvKF58XFwvKWlkXyhyc2F8ZHNhfGVjZHNhfGVkMjU1MTl8ZWNkc2Ffc2t8ZWQyNTUxOV9zaykoXFwuW14vXFxuXSopPyQvLFxuICAvKF58XFwvKWNyZWRlbnRpYWxzXFwuanNvbiQvLFxuICAvKF58XFwvKXNlcnZpY2UtYWNjb3VudFteL10qXFwuanNvbiQvLFxuXTtcblxuLyoqXG4gKiBSZXN1bHQgb2YgaW5zcGVjdGluZyB0aGUgaW5kZXggZm9yIGEgY29tbWl0LlxuICovXG5leHBvcnQgaW50ZXJmYWNlIEluc3BlY3RTdGFnZWRSZXN1bHQge1xuICAvKiogUGF0aHMgdGhhdCBmYWlsIHRoZSBzYWZldHkgZ2F0ZSBhbmQgbXVzdCBub3QgYmUgY29tbWl0dGVkLiAqL1xuICB2aW9sYXRpb25zOiBzdHJpbmdbXTtcbiAgLyoqIFBhdGhzIHRoYXQgcGFzcyB0aGUgc2FmZXR5IGdhdGUuICovXG4gIHNhZmU6IHN0cmluZ1tdO1xufVxuXG4vKipcbiAqIENsYXNzaWZ5IGEgc2luZ2xlIHN0YWdlZCBwYXRoIGFzIHNhZmUgb3IgYSB2aW9sYXRpb24uXG4gKlxuICogT3JkZXIgb2YgY2hlY2tzOlxuICogICAxLiBFeHBsaWNpdCBmb3JiaWRkZW4gcGF0dGVybnMgKGAuZW52YCwgYC5jb25maWcqLmpzb25gLCBgLnNlY3JldHMvYCxcbiAqICAgICAgYC5zc2gvYCwgYC5hd3MvYCwgYC5nbnVwZy9gLCBgLm5ldHJjYCwgZXRjLiksIGVhY2ggY2F1Z2h0IGF0IGFueVxuICogICAgICBkZXB0aCAoSXNzdWVzICMzMzExLCAjMzMzNiksIG5vdCBqdXN0IGF0IHRoZSByZXBvIHJvb3QuXG4gKiAgIDIuIEdlbmVyaWMgXCJoaWRkZW4gdG9wLWxldmVsIHBhdGggb3V0c2lkZSB0aGUgYWxsb3dsaXN0XCIgY2hlY2sg4oCUXG4gKiAgICAgIGBeXFwuW14vXStgIG1pbnVzIHRoZSBlbnRyaWVzIG9uIHRoZSBhbGxvd2xpc3QuIFRoZSBjaGVjayBpc1xuICogICAgICBhcHBsaWVkIHRvIHRoZSBmaXJzdCBwYXRoIHNlZ21lbnQgc28gdGhhdCBhbGxvd2xpc3RlZCBkaXJlY3Rvcmllc1xuICogICAgICBzdWNoIGFzIGAuZ2l0aHViL2AgcGVybWl0IG5lc3RlZCBmaWxlcyAoZS5nLiBgLmdpdGh1Yi93b3JrZmxvd3MvY2kueW1sYCkuXG4gKlxuICogQHBhcmFtIHBhdGggUmVwb3NpdG9yeS1yZWxhdGl2ZSBwYXRoIG9mIGEgc3RhZ2VkIGZpbGUuXG4gKiBAcmV0dXJucyBcInZpb2xhdGlvblwiIGlmIHRoZSBwYXRoIGlzIGZvcmJpZGRlbiwgXCJzYWZlXCIgb3RoZXJ3aXNlLlxuICovXG5leHBvcnQgZnVuY3Rpb24gY2xhc3NpZnlTdGFnZWRQYXRoKHBhdGg6IHN0cmluZyk6IFwidmlvbGF0aW9uXCIgfCBcInNhZmVcIiB7XG4gIGZvciAoY29uc3QgcmUgb2YgRk9SQklEREVOX1NUQUdFRF9QQVRURVJOUykge1xuICAgIGlmIChyZS50ZXN0KHBhdGgpKSByZXR1cm4gXCJ2aW9sYXRpb25cIjtcbiAgfVxuXG4gIGlmIChwYXRoLnN0YXJ0c1dpdGgoXCIuXCIpKSB7XG4gICAgY29uc3QgdG9wU2VnbWVudCA9IHBhdGguc3BsaXQoXCIvXCIpWzBdID8/IHBhdGg7XG4gICAgaWYgKCFBTExPV0VEX0hJRERFTl9QQVRIUy5pbmNsdWRlcyh0b3BTZWdtZW50KSkge1xuICAgICAgcmV0dXJuIFwidmlvbGF0aW9uXCI7XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIFwic2FmZVwiO1xufVxuXG4vKipcbiAqIEluc3BlY3QgdGhlIGdpdCBpbmRleCBhbmQgY2xhc3NpZnkgZWFjaCBzdGFnZWQgcGF0aC5cbiAqXG4gKiBVc2VzIGBnaXQgZGlmZiAtLWNhY2hlZCAtLW5hbWUtb25seSAtemAgc28gcGF0aHMgY29udGFpbmluZyB3aGl0ZXNwYWNlXG4gKiBhcmUgdW5hbWJpZ3VvdXNseSBzZXBhcmF0ZWQgYnkgTlVMIGJ5dGVzLlxuICpcbiAqIEBwYXJhbSBvcHRpb25zIEdpdCBjb21tYW5kIG9wdGlvbnMgKGN3ZCwgZW52LCB0aW1lb3V0KS5cbiAqIEByZXR1cm5zIFJlc3VsdCB3aXRoIGB7IHZpb2xhdGlvbnMsIHNhZmUgfWAgbGlzdHMsIG9yIGFuIGVycm9yIGlmIHRoZVxuICogICBnaXQgY29tbWFuZCBpdHNlbGYgZmFpbGVkLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gaW5zcGVjdFN0YWdlZEZpbGVzKFxuICBvcHRpb25zOiBHaXRDb21tYW5kT3B0aW9ucyA9IHt9LFxuKTogUHJvbWlzZTxSZXN1bHQ8SW5zcGVjdFN0YWdlZFJlc3VsdD4+IHtcbiAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcnVuR2l0Q29tbWFuZChcbiAgICBbXCJkaWZmXCIsIFwiLS1jYWNoZWRcIiwgXCItLW5hbWUtb25seVwiLCBcIi16XCJdLFxuICAgIG9wdGlvbnMsXG4gICk7XG4gIGlmICghcmVzdWx0Lm9rKSByZXR1cm4geyBvazogZmFsc2UsIGVycm9yOiByZXN1bHQuZXJyb3IgfTtcblxuICBpZiAocmVzdWx0LnZhbHVlLmNvZGUgIT09IDApIHtcbiAgICBjb25zdCBlcnIgPSByZXN1bHQudmFsdWUuc3RkZXJyLnRyaW0oKSB8fCByZXN1bHQudmFsdWUuc3Rkb3V0LnRyaW0oKTtcbiAgICByZXR1cm4ge1xuICAgICAgb2s6IGZhbHNlLFxuICAgICAgZXJyb3I6IG5ldyBFcnJvcihgZ2l0IGRpZmYgLS1jYWNoZWQgZmFpbGVkOiAke2Vycn1gKSxcbiAgICB9O1xuICB9XG5cbiAgY29uc3QgcGF0aHMgPSByZXN1bHQudmFsdWUuc3Rkb3V0LnNwbGl0KFwiXFwwXCIpLmZpbHRlcigocCkgPT4gcC5sZW5ndGggPiAwKTtcblxuICBjb25zdCB2aW9sYXRpb25zOiBzdHJpbmdbXSA9IFtdO1xuICBjb25zdCBzYWZlOiBzdHJpbmdbXSA9IFtdO1xuICBmb3IgKGNvbnN0IHBhdGggb2YgcGF0aHMpIHtcbiAgICBpZiAoY2xhc3NpZnlTdGFnZWRQYXRoKHBhdGgpID09PSBcInZpb2xhdGlvblwiKSB7XG4gICAgICB2aW9sYXRpb25zLnB1c2gocGF0aCk7XG4gICAgfSBlbHNlIHtcbiAgICAgIHNhZmUucHVzaChwYXRoKTtcbiAgICB9XG4gIH1cbiAgcmV0dXJuIHsgb2s6IHRydWUsIHZhbHVlOiB7IHZpb2xhdGlvbnMsIHNhZmUgfSB9O1xufVxuXG4vKipcbiAqIFBhcnNlIE5VTC1zZXBhcmF0ZWQgYDxtb2RlPiA84oCmPiA8b2lkPlxcdDxwYXRoPmAgcmVjb3JkcyBpbnRvIGEgbWFwIG9mXG4gKiBwYXRoIHRvIGBcIjxtb2RlPiA8b2lkPlwiYC4gU2VydmVzIGJvdGggYGdpdCBscy1maWxlcyAtcyAtemAgKGBtb2RlIG9pZFxuICogc3RhZ2VgKSBhbmQgYGdpdCBscy10cmVlIC16YCAoYG1vZGUgdHlwZSBvaWRgKTsgYG9pZEZpZWxkYCBuYW1lcyB3aGljaFxuICogc3BhY2Utc2VwYXJhdGVkIGZpZWxkIGhvbGRzIHRoZSBvYmplY3QgaWQuXG4gKi9cbmZ1bmN0aW9uIHBhcnNlRW50cmllcyhcbiAgc3Rkb3V0OiBzdHJpbmcsXG4gIG9pZEZpZWxkOiBudW1iZXIsXG4gIGtlZXA6IChmaWVsZHM6IHN0cmluZ1tdKSA9PiBib29sZWFuLFxuKTogTWFwPHN0cmluZywgc3RyaW5nPiB7XG4gIGNvbnN0IGVudHJpZXMgPSBuZXcgTWFwPHN0cmluZywgc3RyaW5nPigpO1xuICBmb3IgKGNvbnN0IHJlY29yZCBvZiBzdGRvdXQuc3BsaXQoXCJcXDBcIikpIHtcbiAgICBjb25zdCB0YWIgPSByZWNvcmQuaW5kZXhPZihcIlxcdFwiKTtcbiAgICBpZiAodGFiIDwgMCkgY29udGludWU7XG4gICAgY29uc3QgZmllbGRzID0gcmVjb3JkLnNsaWNlKDAsIHRhYikuc3BsaXQoXCIgXCIpO1xuICAgIGlmICgha2VlcChmaWVsZHMpKSBjb250aW51ZTtcbiAgICBlbnRyaWVzLnNldChyZWNvcmQuc2xpY2UodGFiICsgMSksIGAke2ZpZWxkc1swXX0gJHtmaWVsZHNbb2lkRmllbGRdfWApO1xuICB9XG4gIHJldHVybiBlbnRyaWVzO1xufVxuXG4vKipcbiAqIFZpb2xhdGlvbnMgdGhhdCBhIG1lcmdlIG1lcmVseSBicmluZ3MgaW4gKElzc3VlcyAjMjczNywgIzI3MzkpLlxuICpcbiAqIEEgbWVyZ2UgY2FycmllcyBldmVyeSBwYXRoIHRoZSBtZXJnZWQtaW4gYnJhbmNoIGNoYW5nZWQsIHNvIGEgaGlkZGVuIGZpbGVcbiAqIHRoYXQgYnJhbmNoIGFscmVhZHkgdHJhY2tzIChgLmNsYXVkZS/igKZgKSB3b3VsZCB0cmlwIHRoZSBnYXRlIGFsdGhvdWdoXG4gKiBjb21taXR0aW5nIGl0IGRpc2Nsb3NlcyBub3RoaW5nIG5ldy4gQSB2aW9sYXRpb24gaXMgZXhlbXB0IG9ubHkgd2hlbiBpdHNcbiAqIGVudHJ5IG9uIHRoZSBjYW5kaWRhdGUg4oCUIG1vZGUgYW5kIG9iamVjdCBpZCDigJQgaXMgaWRlbnRpY2FsIHRvIHRoYXQgcGF0aCdzXG4gKiBlbnRyeSBvbiB0aGUgbWVyZ2VkLWluIGNvbW1pdC4gQW55dGhpbmcgdGhlIGFnZW50IGFkZGVkIG9yIG1vZGlmaWVkLCBhXG4gKiBtb2RlIGNoYW5nZSwgYSBkZWxldGlvbiwgb3IgYW4gdW5yZXNvbHZlZCBjb25mbGljdCBlbnRyeSBpcyBub3QgZXhlbXB0LlxuICpcbiAqIFRoZSBjYW5kaWRhdGUgaXMgdGhlIGluZGV4IChzdGFnZSAwIG9ubHkpIHdoaWxlIGEgbWVyZ2UgaXMgaW4gcHJvZ3Jlc3NcbiAqIChgbWVyZ2VkSW5gID0gYE1FUkdFX0hFQURgLCBJc3N1ZSAjMjczNyksIG9yIGEgbWVyZ2UgY29tbWl0IGFscmVhZHlcbiAqIHdyaXR0ZW4sIGp1ZGdlZCBhZ2FpbnN0IGl0cyBtZXJnZWQtaW4gcGFyZW50IChJc3N1ZSAjMjczOSkuIFRoZSBjYWxsZXJcbiAqIG93bnMgdGhlIGNsYWltIHRoYXQgYG1lcmdlZEluYCBpcyB3aGF0IHRoZSBtZXJnZSBicm91Z2h0IGluLlxuICpcbiAqIFRoZSBzYW1lIGNvbXBhcmlzb24gc2VydmVzIHRoZSBkZWZhdWx0IGJyYW5jaCdzIHRpcCAoYG1lcmdlZEluYCA9XG4gKiBgcmVmcy9yZW1vdGVzL29yaWdpbi88ZGVmYXVsdD5gLCBJc3N1ZSAjMjc3NCk6IGEgcGF0aCBhbHJlYWR5IHB1Ymxpc2hlZFxuICogdGhlcmUsIGJ5dGUgZm9yIGJ5dGUgYW5kIG1vZGUgZm9yIG1vZGUsIGRpc2Nsb3NlcyBub3RoaW5nIGVpdGhlci5cbiAqXG4gKiBJZiBgbWVyZ2VkSW5gIG9yIGVpdGhlciBsaXN0aW5nIGNhbm5vdCBiZSByZWFkLCBub3RoaW5nIGlzIGV4ZW1wdCAoZmFpbFxuICogY2xvc2VkKS5cbiAqXG4gKiBAcGFyYW0gYXJncy52aW9sYXRpb25zIFBhdGhzIHRoZSBjbGFzc2lmaWVyIHJlZnVzZWRcbiAqIEBwYXJhbSBhcmdzLm1lcmdlZEluIFJlZiBvciBTSEEgb2YgdGhlIGNvbW1pdCB0aGF0IHZvdWNoZXMgZm9yIGEgcGF0aFxuICogQHBhcmFtIGFyZ3MuY2FuZGlkYXRlIENvbW1pdCB3aG9zZSB0cmVlIGlzIGp1ZGdlZDsgb21pdHRlZCwgdGhlIGluZGV4XG4gKiBAcGFyYW0gYXJncy5yZWFzb24gV2h5IGBtZXJnZWRJbmAgdm91Y2hlcywgZm9yIHRoZSBJTkZPIGxvZyBsaW5lXG4gKiBAcGFyYW0gYXJncy5vcHRpb25zIEdpdCBjb21tYW5kIG9wdGlvbnMgKGN3ZCwgZW52LCB0aW1lb3V0KVxuICogQHJldHVybnMgVGhlIGV4ZW1wdCBwYXRocyAoZWFjaCBsb2dnZWQgYXQgSU5GTyksIHBvc3NpYmx5IGVtcHR5XG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBtZXJnZWRJblVuY2hhbmdlZChhcmdzOiB7XG4gIHZpb2xhdGlvbnM6IHN0cmluZ1tdO1xuICBtZXJnZWRJbjogc3RyaW5nO1xuICBjYW5kaWRhdGU/OiBzdHJpbmc7XG4gIHJlYXNvbj86IHN0cmluZztcbiAgb3B0aW9uczogR2l0Q29tbWFuZE9wdGlvbnM7XG59KTogUHJvbWlzZTxTZXQ8c3RyaW5nPj4ge1xuICBjb25zdCB7XG4gICAgdmlvbGF0aW9ucyxcbiAgICBtZXJnZWRJbixcbiAgICBjYW5kaWRhdGUsXG4gICAgcmVhc29uID0gXCJ3aGljaCB0aGUgbWVyZ2UgYnJpbmdzIGluXCIsXG4gICAgb3B0aW9ucyxcbiAgfSA9IGFyZ3M7XG4gIGNvbnN0IGV4ZW1wdCA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuICBpZiAodmlvbGF0aW9ucy5sZW5ndGggPT09IDApIHJldHVybiBleGVtcHQ7XG4gIGNvbnN0IHJlc29sdmVkID0gYXdhaXQgcnVuR2l0Q29tbWFuZChcbiAgICBbXCJyZXYtcGFyc2VcIiwgXCItcVwiLCBcIi0tdmVyaWZ5XCIsIGAke21lcmdlZElufV57Y29tbWl0fWBdLFxuICAgIG9wdGlvbnMsXG4gICk7XG4gIGlmICghcmVzb2x2ZWQub2sgfHwgcmVzb2x2ZWQudmFsdWUuY29kZSAhPT0gMCkgcmV0dXJuIGV4ZW1wdDtcbiAgY29uc3QgbWVyZ2VTaGEgPSByZXNvbHZlZC52YWx1ZS5zdGRvdXQudHJpbSgpO1xuICBpZiAoIS9eWzAtOWEtZl17NDAsNjR9JC8udGVzdChtZXJnZVNoYSkpIHJldHVybiBleGVtcHQ7XG5cbiAgY29uc3QgbGlzdFRyZWUgPSAoY29tbWl0OiBzdHJpbmcpID0+XG4gICAgcnVuR2l0Q29tbWFuZChcbiAgICAgIFtcbiAgICAgICAgXCItLWxpdGVyYWwtcGF0aHNwZWNzXCIsXG4gICAgICAgIFwibHMtdHJlZVwiLFxuICAgICAgICBcIi1yXCIsXG4gICAgICAgIFwiLXpcIixcbiAgICAgICAgXCItLWZ1bGwtdHJlZVwiLFxuICAgICAgICBjb21taXQsXG4gICAgICAgIFwiLS1cIixcbiAgICAgICAgLi4udmlvbGF0aW9ucyxcbiAgICAgIF0sXG4gICAgICBvcHRpb25zLFxuICAgICk7XG4gIGNvbnN0IGp1ZGdlZCA9IGNhbmRpZGF0ZSA9PT0gdW5kZWZpbmVkXG4gICAgPyBhd2FpdCBydW5HaXRDb21tYW5kKFxuICAgICAgW1xuICAgICAgICBcIi0tbGl0ZXJhbC1wYXRoc3BlY3NcIixcbiAgICAgICAgXCJscy1maWxlc1wiLFxuICAgICAgICBcIi1zXCIsXG4gICAgICAgIFwiLXpcIixcbiAgICAgICAgXCItLWZ1bGwtbmFtZVwiLFxuICAgICAgICBcIi0tXCIsXG4gICAgICAgIC4uLnZpb2xhdGlvbnMsXG4gICAgICBdLFxuICAgICAgb3B0aW9ucyxcbiAgICApXG4gICAgOiBhd2FpdCBsaXN0VHJlZShjYW5kaWRhdGUpO1xuICBjb25zdCBtZXJnZWQgPSBhd2FpdCBsaXN0VHJlZShtZXJnZVNoYSk7XG4gIGlmICghanVkZ2VkLm9rIHx8IGp1ZGdlZC52YWx1ZS5jb2RlICE9PSAwKSByZXR1cm4gZXhlbXB0O1xuICBpZiAoIW1lcmdlZC5vayB8fCBtZXJnZWQudmFsdWUuY29kZSAhPT0gMCkgcmV0dXJuIGV4ZW1wdDtcblxuICAvLyBUaGUgaW5kZXg6IHN0YWdlIDAgb25seSwgc2luY2UgYSBjb25mbGljdGVkIHBhdGggaGFzIHN0YWdlcyAx4oCTMyBhbmQgaXNcbiAgLy8gbmV2ZXIgZXhlbXB0LiBBIHRyZWU6IGJsb2JzIG9ubHkuXG4gIGNvbnN0IGlzQmxvYiA9IChmOiBzdHJpbmdbXSkgPT4gZlsxXSA9PT0gXCJibG9iXCI7XG4gIGNvbnN0IGp1ZGdlZEVudHJpZXMgPSBjYW5kaWRhdGUgPT09IHVuZGVmaW5lZFxuICAgID8gcGFyc2VFbnRyaWVzKGp1ZGdlZC52YWx1ZS5zdGRvdXQsIDEsIChmKSA9PiBmWzJdID09PSBcIjBcIilcbiAgICA6IHBhcnNlRW50cmllcyhqdWRnZWQudmFsdWUuc3Rkb3V0LCAyLCBpc0Jsb2IpO1xuICBjb25zdCBtZXJnZWRFbnRyaWVzID0gcGFyc2VFbnRyaWVzKG1lcmdlZC52YWx1ZS5zdGRvdXQsIDIsIGlzQmxvYik7XG4gIGNvbnN0IHdoZXJlID0gY2FuZGlkYXRlID09PSB1bmRlZmluZWQgPyBcInN0YWdlZFwiIDogYGNvbW1pdHRlZCAoJHtjYW5kaWRhdGV9KWA7XG4gIGNvbnN0IHNvdXJjZSA9IG1lcmdlZEluID09PSBtZXJnZVNoYSA/IG1lcmdlU2hhIDogYCR7bWVyZ2VkSW59ICgke21lcmdlU2hhfSlgO1xuICBmb3IgKGNvbnN0IHBhdGggb2YgdmlvbGF0aW9ucykge1xuICAgIGNvbnN0IGVudHJ5ID0ganVkZ2VkRW50cmllcy5nZXQocGF0aCk7XG4gICAgaWYgKGVudHJ5ICE9PSB1bmRlZmluZWQgJiYgZW50cnkgPT09IG1lcmdlZEVudHJpZXMuZ2V0KHBhdGgpKSB7XG4gICAgICBleGVtcHQuYWRkKHBhdGgpO1xuICAgICAgY29uc29sZS5sb2coXG4gICAgICAgIGBbcHJlLWNvbW1pdC1zYWZldHldIElORk86ICR7cGF0aH0gaXMgZXhlbXB0IGZyb20gdGhlIHNhZmV0eSBnYXRlIGAgK1xuICAgICAgICAgIGAoSXNzdWVzICMyNzM3LCAjMjczOSwgIzI3NzQpOiBpdHMgJHt3aGVyZX0gYmxvYiBhbmQgbW9kZSBhcmUgYCArXG4gICAgICAgICAgYGlkZW50aWNhbCB0byAke3NvdXJjZX0sICR7cmVhc29ufWAsXG4gICAgICApO1xuICAgIH1cbiAgfVxuICByZXR1cm4gZXhlbXB0O1xufVxuXG4vKiogVHJ1ZSB3aGVuIGBwYXRoYCBtYXRjaGVzIG9uZSBvZiB0aGUgYWx3YXlzLWZvcmJpZGRlbiBzZWNyZXQgcGF0dGVybnMuICovXG5mdW5jdGlvbiBpc0ZvcmJpZGRlblN0YWdlZFBhdGgocGF0aDogc3RyaW5nKTogYm9vbGVhbiB7XG4gIHJldHVybiBGT1JCSURERU5fU1RBR0VEX1BBVFRFUk5TLnNvbWUoKHJlKSA9PiByZS50ZXN0KHBhdGgpKTtcbn1cblxuLyoqXG4gKiBUaGUgZGVjaWRpbmcgcnVsZSBmcm9tIG9uZSBgZ2l0IGNoZWNrLWlnbm9yZSAtdiAtbmAgb3V0cHV0IGxpbmUsIG9yIGBudWxsYFxuICogd2hlbiB0aGUgbGluZSBzaG93cyBubyBkZWNpc2lvbiAoYDo6YCDigJQgbm90aGluZyBtYXRjaGVkIHRoaXMgcGF0aCBhdFxuICogYWxsKS4gTGluZSBmb3JtYXQ6IGA8c291cmNlPjo8bGluZW51bT46PHBhdHRlcm4+XFx0PHBhdGhuYW1lPmAuXG4gKi9cbmZ1bmN0aW9uIHBhcnNlQ2hlY2tJZ25vcmVEZWNpc2lvbihcbiAgbGluZTogc3RyaW5nLFxuKTogeyBzb3VyY2U6IHN0cmluZzsgcGF0dGVybjogc3RyaW5nIH0gfCBudWxsIHtcbiAgY29uc3QgdGFiID0gbGluZS5pbmRleE9mKFwiXFx0XCIpO1xuICBpZiAodGFiIDwgMCkgcmV0dXJuIG51bGw7XG4gIGNvbnN0IG1hdGNoID0gL14oW146XSopOihcXGQqKTooLiopJC8uZXhlYyhsaW5lLnNsaWNlKDAsIHRhYikpO1xuICBjb25zdCBzb3VyY2UgPSBtYXRjaD8uWzFdO1xuICBjb25zdCBwYXR0ZXJuID0gbWF0Y2g/LlszXTtcbiAgaWYgKCFzb3VyY2UgfHwgcGF0dGVybiA9PT0gdW5kZWZpbmVkKSByZXR1cm4gbnVsbDtcbiAgcmV0dXJuIHsgc291cmNlLCBwYXR0ZXJuIH07XG59XG5cbi8qKlxuICogVGhlIG1vc3Qgc3BlY2lmaWMgYGdpdCBjaGVjay1pZ25vcmUgLXYgLW4gLS1uby1pbmRleGAgZGVjaXNpb24gZ292ZXJuaW5nXG4gKiBgcGF0aGAgKFBSICMzMzA4IHJldmlldyBoYXJkZW5pbmcgb2YgIzMyOTYpLlxuICpcbiAqIFdhbGtzIGBwYXRoYCBhbmQgaXRzIGFuY2VzdG9yIGRpcmVjdG9yaWVzIG5lYXJlc3QtZmlyc3QgKHRoZSBwYXRoIGl0c2VsZixcbiAqIHRoZW4gaXRzIHBhcmVudCwgZ3JhbmRwYXJlbnQsIGFuZCBzbyBvbiB1cCB0byB0aGUgdG9wLWxldmVsIHNlZ21lbnQpLFxuICogc3RvcHBpbmcgYXQgdGhlIGZpcnN0IG9uZSBzb21lIHJ1bGUgYWN0dWFsbHkgZGVjaWRlcy4gVGhpcyBtaXJyb3JzIGhvd1xuICogZ2l0IGl0c2VsZiByZXNvbHZlcyBpZ25vcmUgc3RhdHVzOiBhIGRpcmVjdG9yeSBleHBsaWNpdGx5IHJlLWFsbG93ZWQgYnlcbiAqIG5hbWUgKGUuZy4gYCEuY2xhdWRlL3NraWxsc2ApIGdvdmVybnMgZXZlcnkgcGF0aCBiZW5lYXRoIGl0IHRoYXQgbm8gbW9yZVxuICogc3BlY2lmaWMgcnVsZSBkZWNpZGVzLCBldmVuIHRob3VnaCBgY2hlY2staWdub3JlYCBydW4gb24gYSBuZXN0ZWQgZmlsZVxuICogZGlyZWN0bHkgcmVwb3J0cyBubyBkZWNpc2lvbiAoYDo6YCkgZm9yIHRoYXQgZmlsZS5cbiAqXG4gKiBSZXR1cm5zIGBudWxsYCDigJQgbm90aGluZyBnb3Zlcm5zLCBmYWlsIGNsb3NlZCDigJQgd2hlbiBldmVyeSBzZWdtZW50IGluIHRoZVxuICogY2hhaW4gaXMgdW5kZWNpZGVkIChgOjpgLCBpLmUuIGV4aXQgMSksIHdoZW4gYW55IGBjaGVjay1pZ25vcmVgIGNhbGxcbiAqIGNhbm5vdCBiZSBydW4sIG9yIHdoZW4gYSBcImRlY2lkZWRcIiAoZXhpdCAwKSByZXN1bHQncyBvdXRwdXQgbGluZSBjYW5ub3QgYmVcbiAqIHBhcnNlZC4gQSBgbnVsbGAgaGVyZSBpcyBkZWxpYmVyYXRlbHkgaW5kaXN0aW5ndWlzaGFibGUgYmV0d2VlbiBcInRoaXNcbiAqIHJlcG8ncyBgLmdpdGlnbm9yZWAgbmV2ZXIgbWVudGlvbnMgdGhpcyBwYXRoXCIgYW5kIGEgdG9vbCBmYWlsdXJlIOKAlCBib3RoXG4gKiBtdXN0IHJlZnVzZSB0aGUgZXhlbXB0aW9uLCBub3QgZ3JhbnQgaXQuXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIG5lYXJlc3RHb3Zlcm5hbmNlKFxuICBwYXRoOiBzdHJpbmcsXG4gIG9wdGlvbnM6IEdpdENvbW1hbmRPcHRpb25zLFxuICBydW46IHR5cGVvZiBydW5HaXRDb21tYW5kLFxuKTogUHJvbWlzZTx7IHNvdXJjZTogc3RyaW5nOyBwYXR0ZXJuOiBzdHJpbmcgfSB8IG51bGw+IHtcbiAgY29uc3Qgc2VnbWVudHMgPSBwYXRoLnNwbGl0KFwiL1wiKS5maWx0ZXIoKHMpID0+IHMubGVuZ3RoID4gMCk7XG4gIGZvciAobGV0IGRlcHRoID0gc2VnbWVudHMubGVuZ3RoOyBkZXB0aCA+PSAxOyBkZXB0aC0tKSB7XG4gICAgY29uc3QgcHJvYmUgPSBzZWdtZW50cy5zbGljZSgwLCBkZXB0aCkuam9pbihcIi9cIik7XG4gICAgY29uc3QgY2hlY2tlZCA9IGF3YWl0IHJ1bihcbiAgICAgIFtcImNoZWNrLWlnbm9yZVwiLCBcIi12XCIsIFwiLW5cIiwgXCItLW5vLWluZGV4XCIsIFwiLS1cIiwgcHJvYmVdLFxuICAgICAgb3B0aW9ucyxcbiAgICApO1xuICAgIGlmICghY2hlY2tlZC5vaykgcmV0dXJuIG51bGw7XG4gICAgY29uc3QgeyBjb2RlLCBzdGRvdXQgfSA9IGNoZWNrZWQudmFsdWU7XG4gICAgaWYgKGNvZGUgIT09IDAgJiYgY29kZSAhPT0gMSkgcmV0dXJuIG51bGw7XG4gICAgaWYgKGNvZGUgPT09IDEpIGNvbnRpbnVlOyAvLyBub3RoaW5nIGRlY2lkZWQgdGhpcyBzZWdtZW50OyB3YWxrIHVwLlxuICAgIHJldHVybiBwYXJzZUNoZWNrSWdub3JlRGVjaXNpb24oc3Rkb3V0LnNwbGl0KFwiXFxuXCIpWzBdID8/IFwiXCIpO1xuICB9XG4gIHJldHVybiBudWxsO1xufVxuXG4vKipcbiAqIEhpZGRlbiBwYXRocyBhIHRhcmdldCByZXBvJ3Mgb3duIGAuZ2l0aWdub3JlYCByZS1hbGxvd3MgKElzc3VlICMzMjk2KS5cbiAqXG4gKiBgQUxMT1dFRF9ISURERU5fUEFUSFNgIGlzIHRoaXMgd29ya2VyJ3Mgb25lIGNhbm9uaWNhbCBsaXN0LCBidXQgYSByZXBvIG1heVxuICogbGVnaXRpbWF0ZWx5IHJlLWFsbG93IGEgaGlkZGVuIHBhdGggb2YgaXRzIG93biDigJQgdGhpcyByZXBvJ3MgYC5naXRpZ25vcmVgXG4gKiByZS1hbGxvd3MgYC5jbGF1ZGUvc2tpbGxzYCBhbmQgYC5jbGF1ZGUvYWdlbnRzYCwgZm9yIGluc3RhbmNlIOKAlCBhbmQgdGhlXG4gKiBnYXRlIHNob3VsZCBub3QgcmVmdXNlIGFuIGVkaXQgdG8gYSBmaWxlIHRoZSByZXBvIGl0c2VsZiB0cmFja3Mgb25cbiAqIHB1cnBvc2UuIEEgcGF0aCBpcyBleGVtcHQgaGVyZSBvbmx5IHdoZW46XG4gKlxuICogICAxLiBJdCBkb2VzIG5vdCBtYXRjaCBhbnkgYEZPUkJJRERFTl9TVEFHRURfUEFUVEVSTlNgIGVudHJ5IOKAlCBzZWNyZXRcbiAqICAgICAgZmlsZW5hbWVzIGFuZCBjcmVkZW50aWFsLXN0b3JlIGRpcmVjdG9yaWVzIGFyZSBuZXZlciBleGVtcHQgdGhpc1xuICogICAgICB3YXksIHJlZ2FyZGxlc3Mgb2Ygd2hhdCBhbnkgYC5naXRpZ25vcmVgIHNheXMuXG4gKiAgIDIuIFRoZSByZXBvJ3Mgcm9vdCBgLmdpdGlnbm9yZWAgaXMgdHJhY2tlZCBhdCBgSEVBRGAgYW5kIHVubW9kaWZpZWQgaW5cbiAqICAgICAgYm90aCB0aGUgaW5kZXggYW5kIHRoZSB3b3JraW5nIHRyZWUg4oCUIG90aGVyd2lzZSBhbiBhZ2VudCBjb3VsZCBvcHQgYVxuICogICAgICBwYXRoIGluIHdpdGhpbiB0aGUgdmVyeSBjb21taXQgYmVpbmcganVkZ2VkICh2aWEgZWl0aGVyIHRoZSBzdGFnZWRcbiAqICAgICAgY29udGVudCBvciB0aGUgb24tZGlzayBmaWxlIGBjaGVjay1pZ25vcmUgLS1uby1pbmRleGAgYWN0dWFsbHlcbiAqICAgICAgcmVhZHMpLCBvciB0aGUgY2hlY2sgY291bGQgcmVhZCBhIGAuZ2l0aWdub3JlYCB0aGUgcmVwb3NpdG9yeSBkb2VzXG4gKiAgICAgIG5vdCBhY3R1YWxseSBjYXJyeSBmb3J3YXJkLlxuICogICAzLiBgSEVBRDouZ2l0aWdub3JlYCdzIGJsb2IgaXMgYnl0ZS1pZGVudGljYWwgdG8gYC5naXRpZ25vcmVgIG9uIHRoZVxuICogICAgICBsb2NhbCBgb3JpZ2luLzxkZWZhdWx0PmAgcmVmIChQUiAjMzMwOCByZXZpZXcpOiBgLmdpdGlnbm9yZWBcbiAqICAgICAgaXMgaXRzZWxmIG9uIGBBTExPV0VEX0hJRERFTl9QQVRIU2AsIHNvIG9uZSB3b3JrZXIgY29tbWl0IGNvdWxkIGNhcnJ5XG4gKiAgICAgIGEgYCFgLW5lZ2F0aW9uLCBhbmQgYSBsYXRlciBjb21taXQgb24gdGhlICpzYW1lKiBicmFuY2ggdGhlbiBzdGFnZVxuICogICAgICB0aGUgcGF0aCBpdCByZS1hbGxvd3Mg4oCUIHRoZSByZXBvJ3Mgb3duIGNob2ljZSB3b3VsZCBvdGhlcndpc2UgYmVcbiAqICAgICAgZGVjaWRlZCBieSB3aG9ldmVyIGF1dGhvcmVkIHRoZSBicmFuY2gsIG5vdCBieSB3aGF0IHRoZSByZXBvXG4gKiAgICAgIGFjdHVhbGx5IHB1Ymxpc2hlcy4gVW5yZXNvbHZhYmxlIGBvcmlnaW4vSEVBRGAsIGEgYC5naXRpZ25vcmVgXG4gKiAgICAgIG1pc3NpbmcgZnJvbSBlaXRoZXIgcmVmLCBvciBhIGByZXYtcGFyc2VgIHRoYXQgY2Fubm90IHJ1biwgYWxsIGxlYXZlXG4gKiAgICAgIG5vdGhpbmcgZXhlbXB0IChmYWlsIGNsb3NlZCkg4oCUIHRoZSBzYW1lIHBvc3R1cmUgYXMgdGhlICMyNzc0XG4gKiAgICAgIGRlZmF1bHQtYnJhbmNoIGV4ZW1wdGlvbiBhYm92ZS5cbiAqICAgNC4ge0BsaW5rIG5lYXJlc3RHb3Zlcm5hbmNlfSBmaW5kcywgZm9yIHRoYXQgcGF0aCBvciBvbmUgb2YgaXRzXG4gKiAgICAgIGFuY2VzdG9yIGRpcmVjdG9yaWVzLCBhbiBleHBsaWNpdCBgIWAtbmVnYXRpb24gZGVjaWRlZCBieSB0aGUgcm9vdFxuICogICAgICBgLmdpdGlnbm9yZWAgZmlsZSBpdHNlbGYgKHNvdXJjZSBgLmdpdGlnbm9yZWAsIG5vdCBhIG5lc3RlZCBvclxuICogICAgICB1bnRyYWNrZWQgb25lKS4gTm8gZGVjaXNpb24gYW55d2hlcmUgaW4gdGhlIGNoYWluLCBhIGRlY2lzaW9uIGZyb21cbiAqICAgICAgYW55IG90aGVyIHNvdXJjZSwgb3IgYSBub24tbmVnYXRpb24gZGVjaXNpb24sIGFsbCBsZWF2ZSB0aGUgcGF0aCBub3RcbiAqICAgICAgZXhlbXB0IOKAlCB0aGlzIGNoZWNrIGZhaWxzIGNsb3NlZC5cbiAqXG4gKiBAcGFyYW0gYXJncy52aW9sYXRpb25zIFBhdGhzIHRoZSBjbGFzc2lmaWVyIHJlZnVzZWRcbiAqIEBwYXJhbSBhcmdzLm9wdGlvbnMgR2l0IGNvbW1hbmQgb3B0aW9ucyAoY3dkLCBlbnYsIHRpbWVvdXQpXG4gKiBAcGFyYW0gYXJncy5ydW4gR2l0IGNvbW1hbmQgcnVubmVyIG92ZXJyaWRlICh0ZXN0IHNlYW0gb25seSk7IGRlZmF1bHRzIHRvXG4gKiAgIGBydW5HaXRDb21tYW5kYFxuICogQHJldHVybnMgVGhlIGV4ZW1wdCBwYXRocyAoZWFjaCBsb2dnZWQgYXQgSU5GTyksIHBvc3NpYmx5IGVtcHR5XG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBnaXRpZ25vcmVSZWFsbG93ZWQoYXJnczoge1xuICB2aW9sYXRpb25zOiBzdHJpbmdbXTtcbiAgb3B0aW9uczogR2l0Q29tbWFuZE9wdGlvbnM7XG4gIHJ1bj86IHR5cGVvZiBydW5HaXRDb21tYW5kO1xufSk6IFByb21pc2U8U2V0PHN0cmluZz4+IHtcbiAgY29uc3QgeyB2aW9sYXRpb25zLCBvcHRpb25zLCBydW4gPSBydW5HaXRDb21tYW5kIH0gPSBhcmdzO1xuICBjb25zdCBleGVtcHQgPSBuZXcgU2V0PHN0cmluZz4oKTtcblxuICBjb25zdCBjYW5kaWRhdGVzID0gdmlvbGF0aW9ucy5maWx0ZXIoKHApID0+ICFpc0ZvcmJpZGRlblN0YWdlZFBhdGgocCkpO1xuICBpZiAoY2FuZGlkYXRlcy5sZW5ndGggPT09IDApIHJldHVybiBleGVtcHQ7XG5cbiAgLy8gVGhlIHJlcG8ncyBvd24gLmdpdGlnbm9yZSBtdXN0IGJlIHRyYWNrZWQgYXQgSEVBRCBhbmQgdW5tb2RpZmllZCBpbiBib3RoXG4gIC8vIHRoZSBpbmRleCBhbmQgdGhlIHdvcmtpbmcgdHJlZSDigJQgb3RoZXJ3aXNlIG5vdGhpbmcgaXQgc2F5cyBjYW4gYmVcbiAgLy8gdHJ1c3RlZCBmb3IgdGhpcyBjb21taXQuIFRoZSBpbmRleCBjaGVjayBjYXRjaGVzIGEgYC5naXRpZ25vcmVgIHN0YWdlZFxuICAvLyB3aXRoIG5ldyBjb250ZW50OyB0aGUgd29ya2luZy10cmVlIGNoZWNrIGNhdGNoZXMgYW4gb24tZGlzayBlZGl0IHRoYXRcbiAgLy8gd2FzIG5ldmVyIHN0YWdlZCBhdCBhbGwg4oCUIGBjaGVjay1pZ25vcmUgLS1uby1pbmRleGAgcmVhZHMgdGhlIG9uLWRpc2tcbiAgLy8gZmlsZSBkaXJlY3RseSwgYnlwYXNzaW5nIHRoZSBpbmRleCwgc28gZWl0aGVyIGFsb25lIGNvdWxkIGxldCBhIGNvbW1pdFxuICAvLyBvcHQgaXRzZWxmIGluLlxuICBjb25zdCBhdEhlYWQgPSBhd2FpdCBydW4oXG4gICAgW1wiY2F0LWZpbGVcIiwgXCItZVwiLCBcIkhFQUQ6LmdpdGlnbm9yZVwiXSxcbiAgICBvcHRpb25zLFxuICApO1xuICBpZiAoIWF0SGVhZC5vayB8fCBhdEhlYWQudmFsdWUuY29kZSAhPT0gMCkgcmV0dXJuIGV4ZW1wdDtcbiAgY29uc3QgdW5tb2RpZmllZEluZGV4ID0gYXdhaXQgcnVuKFxuICAgIFtcImRpZmZcIiwgXCItLWNhY2hlZFwiLCBcIi0tcXVpZXRcIiwgXCJIRUFEXCIsIFwiLS1cIiwgXCIuZ2l0aWdub3JlXCJdLFxuICAgIG9wdGlvbnMsXG4gICk7XG4gIGlmICghdW5tb2RpZmllZEluZGV4Lm9rIHx8IHVubW9kaWZpZWRJbmRleC52YWx1ZS5jb2RlICE9PSAwKSByZXR1cm4gZXhlbXB0O1xuICBjb25zdCB1bm1vZGlmaWVkV29ya2luZ1RyZWUgPSBhd2FpdCBydW4oXG4gICAgW1wiZGlmZlwiLCBcIi0tcXVpZXRcIiwgXCJIRUFEXCIsIFwiLS1cIiwgXCIuZ2l0aWdub3JlXCJdLFxuICAgIG9wdGlvbnMsXG4gICk7XG4gIGlmICghdW5tb2RpZmllZFdvcmtpbmdUcmVlLm9rIHx8IHVubW9kaWZpZWRXb3JraW5nVHJlZS52YWx1ZS5jb2RlICE9PSAwKSB7XG4gICAgcmV0dXJuIGV4ZW1wdDtcbiAgfVxuXG4gIC8vIEhFQUQncyBvd24gY29tbWl0IGlzIG5vdCBlbm91Z2g6IGEgcmUtYWxsb3cgY29tbWl0dGVkIGVhcmxpZXIgb24gKnRoaXMqXG4gIC8vIGJyYW5jaCBpcyBub3Qgc29tZXRoaW5nIHRoZSByZXBvJ3MgZGVmYXVsdCBicmFuY2ggaGFzIGV2ZXIgcHVibGlzaGVkXG4gIC8vIChQUiAjMzMwOCByZXZpZXcpLiBSZXF1aXJlIEhFQUQ6LmdpdGlnbm9yZSB0byBiZSB0aGUgaWRlbnRpY2FsXG4gIC8vIGJsb2IgYXMgb3JpZ2luLzxkZWZhdWx0PjouZ2l0aWdub3JlLCByZWFkIGZyb20gdGhlIGxvY2FsIHJlbW90ZS10cmFja2luZ1xuICAvLyByZWYgb25seSDigJQgbmV2ZXIgZmV0Y2hlZC5cbiAgY29uc3QgZGVmYXVsdFJlZiA9IGF3YWl0IG9yaWdpbkRlZmF1bHRSZWYob3B0aW9ucywgcnVuKTtcbiAgaWYgKGRlZmF1bHRSZWYgPT09IG51bGwpIHJldHVybiBleGVtcHQ7XG4gIGNvbnN0IGhlYWRCbG9iID0gYXdhaXQgcnVuKFxuICAgIFtcInJldi1wYXJzZVwiLCBcIi1xXCIsIFwiLS12ZXJpZnlcIiwgXCJIRUFEOi5naXRpZ25vcmVcIl0sXG4gICAgb3B0aW9ucyxcbiAgKTtcbiAgaWYgKCFoZWFkQmxvYi5vayB8fCBoZWFkQmxvYi52YWx1ZS5jb2RlICE9PSAwKSByZXR1cm4gZXhlbXB0O1xuICBjb25zdCBkZWZhdWx0QmxvYiA9IGF3YWl0IHJ1bihcbiAgICBbXCJyZXYtcGFyc2VcIiwgXCItcVwiLCBcIi0tdmVyaWZ5XCIsIGAke2RlZmF1bHRSZWZ9Oi5naXRpZ25vcmVgXSxcbiAgICBvcHRpb25zLFxuICApO1xuICBpZiAoIWRlZmF1bHRCbG9iLm9rIHx8IGRlZmF1bHRCbG9iLnZhbHVlLmNvZGUgIT09IDApIHJldHVybiBleGVtcHQ7XG4gIGlmIChoZWFkQmxvYi52YWx1ZS5zdGRvdXQudHJpbSgpICE9PSBkZWZhdWx0QmxvYi52YWx1ZS5zdGRvdXQudHJpbSgpKSB7XG4gICAgcmV0dXJuIGV4ZW1wdDtcbiAgfVxuXG4gIGZvciAoY29uc3QgcGF0aCBvZiBjYW5kaWRhdGVzKSB7XG4gICAgY29uc3QgZ292ZXJuYW5jZSA9IGF3YWl0IG5lYXJlc3RHb3Zlcm5hbmNlKHBhdGgsIG9wdGlvbnMsIHJ1bik7XG4gICAgaWYgKFxuICAgICAgZ292ZXJuYW5jZSAhPT0gbnVsbCAmJiBnb3Zlcm5hbmNlLnNvdXJjZSA9PT0gXCIuZ2l0aWdub3JlXCIgJiZcbiAgICAgIGdvdmVybmFuY2UucGF0dGVybi5zdGFydHNXaXRoKFwiIVwiKVxuICAgICkge1xuICAgICAgZXhlbXB0LmFkZChwYXRoKTtcbiAgICAgIGNvbnNvbGUubG9nKFxuICAgICAgICBgW3ByZS1jb21taXQtc2FmZXR5XSBJTkZPOiAke3BhdGh9IGlzIGV4ZW1wdCBmcm9tIHRoZSBzYWZldHkgZ2F0ZSBgICtcbiAgICAgICAgICBgKElzc3VlICMzMjk2KTogdGhlIHJlcG8ncyBvd24gcm9vdCAuZ2l0aWdub3JlIGV4cGxpY2l0bHkgYCArXG4gICAgICAgICAgYHJlLWFsbG93cyBpdCAocnVsZTogJHtnb3Zlcm5hbmNlLnBhdHRlcm59KWAsXG4gICAgICApO1xuICAgIH1cbiAgICAvLyBObyBkZWNpc2lvbiBhbnl3aGVyZSBpbiB0aGUgY2hhaW4sIGEgZGVjaXNpb24gZnJvbSBhIG5lc3RlZC91bnRyYWNrZWRcbiAgICAvLyAuZ2l0aWdub3JlLCBvciBhIG5vbi1uZWdhdGlvbiBkZWNpc2lvbjogbm90IGV4ZW1wdC5cbiAgfVxuICByZXR1cm4gZXhlbXB0O1xufVxuXG4vKipcbiAqIFRoZSBsb2NhbCByZW1vdGUtdHJhY2tpbmcgcmVmIG9mIG9yaWdpbidzIGRlZmF1bHQgYnJhbmNoLCByZWFkIGZyb21cbiAqIGByZWZzL3JlbW90ZXMvb3JpZ2luL0hFQURgIHdpdGhvdXQgdG91Y2hpbmcgdGhlIG5ldHdvcmsgKElzc3VlICMyNzc0KS5cbiAqIERlbGliZXJhdGVseSBub3QgYHJlc29sdmVPcmlnaW5EZWZhdWx0QnJhbmNoKClgLCB3aGljaCBtYXkgcnVuXG4gKiBgZ2l0IHJlbW90ZSBzZXQtaGVhZCBvcmlnaW4gLS1hdXRvYCBhbmQgc28gY29udGFjdCB0aGUgcmVtb3RlLiBSZXR1cm5zXG4gKiBgbnVsbGAg4oCUIG5vdGhpbmcgdm91Y2hlcyDigJQgdW5sZXNzIHRoZSBzeW1ib2xpYyByZWYgbmFtZXMgYSByZWYgdW5kZXJcbiAqIGByZWZzL3JlbW90ZXMvb3JpZ2luL2AuXG4gKlxuICogQHBhcmFtIHJ1biBHaXQgY29tbWFuZCBydW5uZXIgb3ZlcnJpZGUgKHRlc3Qgc2VhbSBvbmx5KTsgZGVmYXVsdHMgdG9cbiAqICAgYHJ1bkdpdENvbW1hbmRgLlxuICovXG5hc3luYyBmdW5jdGlvbiBvcmlnaW5EZWZhdWx0UmVmKFxuICBvcHRpb25zOiBHaXRDb21tYW5kT3B0aW9ucyxcbiAgcnVuOiB0eXBlb2YgcnVuR2l0Q29tbWFuZCA9IHJ1bkdpdENvbW1hbmQsXG4pOiBQcm9taXNlPHN0cmluZyB8IG51bGw+IHtcbiAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcnVuKFxuICAgIFtcInN5bWJvbGljLXJlZlwiLCBcIi1xXCIsIFwicmVmcy9yZW1vdGVzL29yaWdpbi9IRUFEXCJdLFxuICAgIG9wdGlvbnMsXG4gICk7XG4gIGlmICghcmVzdWx0Lm9rIHx8IHJlc3VsdC52YWx1ZS5jb2RlICE9PSAwKSByZXR1cm4gbnVsbDtcbiAgY29uc3QgcmVmID0gcmVzdWx0LnZhbHVlLnN0ZG91dC50cmltKCk7XG4gIHJldHVybiAvXnJlZnNcXC9yZW1vdGVzXFwvb3JpZ2luXFwvXFxTKyQvLnRlc3QocmVmKSAmJlxuICAgICAgcmVmICE9PSBcInJlZnMvcmVtb3Rlcy9vcmlnaW4vSEVBRFwiXG4gICAgPyByZWZcbiAgICA6IG51bGw7XG59XG5cbi8qKlxuICogUmVmdXNlIHRvIHByb2NlZWQgd2hlbiBhbnkgc3RhZ2VkIHBhdGggdmlvbGF0ZXMgdGhlIHNhZmV0eSBnYXRlLlxuICpcbiAqIFJldHVybnMgYE9rKHZvaWQpYCB3aGVuIGV2ZXJ5IHN0YWdlZCBwYXRoIGlzIHNhZmUgKGluY2x1ZGluZyB0aGUgZW1wdHlcbiAqIHN0YWdlKS4gUmV0dXJucyBgRXJyYCBsaXN0aW5nIGV2ZXJ5IG9mZmVuZGluZyBwYXRoIGFuZCB0aGUgcmVjb3ZlcnlcbiAqIGNvbW1hbmQgKGBnaXQgcmVzZXQgSEVBRCA8ZmlsZT5gKS4gQSBwYXRoIGEgbWVyZ2UgaW4gcHJvZ3Jlc3MgYnJpbmdzIGluXG4gKiB1bmNoYW5nZWQgZnJvbSBgTUVSR0VfSEVBRGAgaXMgZXhlbXB0IChJc3N1ZSAjMjczNyksIGFzIGlzIGEgcGF0aCB3aG9zZVxuICogc3RhZ2VkIGJsb2IgYW5kIG1vZGUgYXJlIGlkZW50aWNhbCB0byB0aGF0IHBhdGggb24gdGhlIGRlZmF1bHQgYnJhbmNoJ3NcbiAqIHRpcCwgcmVhZCBmcm9tIHRoZSBsb2NhbCBgb3JpZ2luLzxkZWZhdWx0PmAgcmVmIGFuZCBuZXZlciBmZXRjaGVkIChJc3N1ZVxuICogIzI3NzQpLiBJZiB0aGF0IHJlZiBjYW5ub3QgYmUgcmVzb2x2ZWQgb3IgcmVhZCwgbm90aGluZyBpcyBleGVtcHQgb24gaXRzXG4gKiBhY2NvdW50IChmYWlsIGNsb3NlZCkuIEEgcmVtYWluaW5nIGhpZGRlbi1wYXRoIHZpb2xhdGlvbiBpcyBhbHNvIGV4ZW1wdFxuICogd2hlbiB0aGUgcmVwbydzIG93biB0cmFja2VkLCB1bm1vZGlmaWVkIGAuZ2l0aWdub3JlYCByZS1hbGxvd3MgaXQgKElzc3VlXG4gKiAjMzI5Nikg4oCUIHNlY3JldC1iZWFyaW5nIGZpbGVuYW1lcyBmcm9tIGBGT1JCSURERU5fU1RBR0VEX1BBVFRFUk5TYCBuZXZlclxuICogYXJlLCBhbmQgdGhpcyBjaGVjayB0b28gZmFpbHMgY2xvc2VkLlxuICpcbiAqIEBwYXJhbSBvcHRpb25zIEdpdCBjb21tYW5kIG9wdGlvbnMgKGN3ZCwgZW52LCB0aW1lb3V0KS5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGFzc2VydFNhZmVUb0NvbW1pdChcbiAgb3B0aW9uczogR2l0Q29tbWFuZE9wdGlvbnMgPSB7fSxcbik6IFByb21pc2U8UmVzdWx0PHZvaWQ+PiB7XG4gIGNvbnN0IGluc3BlY3Rpb24gPSBhd2FpdCBpbnNwZWN0U3RhZ2VkRmlsZXMob3B0aW9ucyk7XG4gIGlmICghaW5zcGVjdGlvbi5vaykgcmV0dXJuIHsgb2s6IGZhbHNlLCBlcnJvcjogaW5zcGVjdGlvbi5lcnJvciB9O1xuXG4gIGlmIChpbnNwZWN0aW9uLnZhbHVlLnZpb2xhdGlvbnMubGVuZ3RoID09PSAwKSB7XG4gICAgcmV0dXJuIHsgb2s6IHRydWUsIHZhbHVlOiB1bmRlZmluZWQgfTtcbiAgfVxuXG4gIGNvbnN0IG1lcmdlZCA9IGF3YWl0IG1lcmdlZEluVW5jaGFuZ2VkKHtcbiAgICB2aW9sYXRpb25zOiBpbnNwZWN0aW9uLnZhbHVlLnZpb2xhdGlvbnMsXG4gICAgbWVyZ2VkSW46IFwiTUVSR0VfSEVBRFwiLFxuICAgIG9wdGlvbnMsXG4gIH0pO1xuICBsZXQgdmlvbGF0aW9ucyA9IGluc3BlY3Rpb24udmFsdWUudmlvbGF0aW9ucy5maWx0ZXIoKHApID0+ICFtZXJnZWQuaGFzKHApKTtcbiAgY29uc3QgZGVmYXVsdFJlZiA9IHZpb2xhdGlvbnMubGVuZ3RoID4gMFxuICAgID8gYXdhaXQgb3JpZ2luRGVmYXVsdFJlZihvcHRpb25zKVxuICAgIDogbnVsbDtcbiAgaWYgKGRlZmF1bHRSZWYgIT09IG51bGwpIHtcbiAgICBjb25zdCBwdWJsaXNoZWQgPSBhd2FpdCBtZXJnZWRJblVuY2hhbmdlZCh7XG4gICAgICB2aW9sYXRpb25zLFxuICAgICAgbWVyZ2VkSW46IGRlZmF1bHRSZWYsXG4gICAgICByZWFzb246IFwidGhlIGRlZmF1bHQgYnJhbmNoJ3MgdGlwLCB3aGljaCBhbHJlYWR5IHB1Ymxpc2hlcyBpdFwiLFxuICAgICAgb3B0aW9ucyxcbiAgICB9KTtcbiAgICB2aW9sYXRpb25zID0gdmlvbGF0aW9ucy5maWx0ZXIoKHApID0+ICFwdWJsaXNoZWQuaGFzKHApKTtcbiAgfVxuICBpZiAodmlvbGF0aW9ucy5sZW5ndGggPiAwKSB7XG4gICAgY29uc3QgcmVhbGxvd2VkID0gYXdhaXQgZ2l0aWdub3JlUmVhbGxvd2VkKHsgdmlvbGF0aW9ucywgb3B0aW9ucyB9KTtcbiAgICB2aW9sYXRpb25zID0gdmlvbGF0aW9ucy5maWx0ZXIoKHApID0+ICFyZWFsbG93ZWQuaGFzKHApKTtcbiAgfVxuICBpZiAodmlvbGF0aW9ucy5sZW5ndGggPT09IDApIHtcbiAgICByZXR1cm4geyBvazogdHJ1ZSwgdmFsdWU6IHVuZGVmaW5lZCB9O1xuICB9XG5cbiAgY29uc3QgbGlzdCA9IHZpb2xhdGlvbnMubWFwKChwKSA9PiBgICAtICR7cH1gKS5qb2luKFwiXFxuXCIpO1xuICByZXR1cm4ge1xuICAgIG9rOiBmYWxzZSxcbiAgICBlcnJvcjogbmV3IEVycm9yKFxuICAgICAgXCJQcmUtY29tbWl0IHNhZmV0eSBnYXRlIHJlZnVzZWQgY29tbWl0IChJc3N1ZSAjMTc1OCk6IHRoZSBmb2xsb3dpbmcgXCIgK1xuICAgICAgICBcImhpZGRlbiBvciBzZWNyZXQtYmVhcmluZyBmaWxlcyBhcmUgc3RhZ2VkOlxcblwiICtcbiAgICAgICAgYCR7bGlzdH1cXG5cXG5gICtcbiAgICAgICAgXCJSZW1vdmUgZWFjaCBvbmUgd2l0aDogZ2l0IHJlc2V0IEhFQUQgPGZpbGU+XCIsXG4gICAgKSxcbiAgfTtcbn1cbiJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Q0F5Q0MsR0FJRCxTQUFTLGFBQWEsUUFBUSxtQkFBbUI7QUFDakQsU0FBUywyQkFBMkIsUUFBUSww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
// denoCacheMetadata=10289005689238647854,982558274789619560