/**
 * Git-identity helpers for suppression `author=` binding (Issue #269).
 *
 * The parser in `suppression_comments.ts` stays pure: it only compares
 * `author=` against logins the caller supplies. This module is the I/O
 * side — it runs `git blame` on a checkout and turns the porcelain
 * author / author-mail into a GitHub login via
 * {@link loginFromGitIdentity}.
 *
 * Per-line blame is the preferred provenance check: a fork PR that
 * writes `author=<allowlisted-login>` still blames as the attacker, so
 * the marker is rejected. When blame cannot run, callers must fail
 * closed rather than treat the self-asserted field as authorised.
 *
 * Australian English spelling throughout.
 */

import { runGitCommand } from "./git_timeout.ts";
import { loginFromGitIdentity } from "./suppression_comments.ts";

/** Injectable git runner for {@link blameLineAuthorLogin}. */
export type BlameGitRunner = typeof runGitCommand;

/**
 * Blame `file` at 1-based `line` in `workDir` and return the author's
 * GitHub login, or `null` when blame or identity cannot be determined.
 */
export async function blameLineAuthorLogin(
  workDir: string,
  file: string,
  line: number,
  runGit: BlameGitRunner = runGitCommand,
): Promise<string | null> {
  const blamed = await blameFileLineLogins(workDir, file, runGit);
  return blamed[line] ?? null;
}

/**
 * Blame every line of `file` in `workDir` and return a 1-based
 * line → login map. Lines whose identity cannot be derived are omitted
 * so a later lookup fails closed.
 */
export async function blameFileLineLogins(
  workDir: string,
  file: string,
  runGit: BlameGitRunner = runGitCommand,
): Promise<Record<number, string>> {
  // The worker clones with `--depth=1`, so a shallow checkout blames every
  // line older than the clone tip on the boundary commit's author — a valid
  // marker would be rejected, and one written by anyone would validate as
  // an allowlisted boundary author. Deepen first so identity does not
  // depend on clone depth.
  const shallow = await ensureFullHistory(workDir, runGit);
  // `--root` stops a real root commit being reported as `boundary`, but in
  // a still-shallow checkout it would also hide the shallow boundary — so
  // only pass it once the history is complete.
  const args = shallow
    ? ["blame", "--porcelain", "--", file]
    : ["blame", "--root", "--porcelain", "--", file];
  const result = await runGit(args, { cwd: workDir });
  if (!result.ok || result.value.code !== 0) return {};
  return parseBlamePorcelain(result.value.stdout);
}

/**
 * Unshallow `workDir` when it is a shallow clone.
 *
 * @returns `true` when the checkout is (still) shallow after the attempt —
 *   blame on it must treat `boundary` hunks as unknown identity.
 */
async function ensureFullHistory(
  workDir: string,
  runGit: BlameGitRunner,
): Promise<boolean> {
  const isShallow = async (): Promise<boolean> => {
    const probe = await runGit(
      ["rev-parse", "--is-shallow-repository"],
      { cwd: workDir },
    );
    // Unknown shallowness fails closed: blame without `--root`.
    if (!probe.ok || probe.value.code !== 0) return true;
    return probe.value.stdout.trim() !== "false";
  };
  if (!(await isShallow())) return false;
  await runGit(["fetch", "--unshallow", "--quiet"], { cwd: workDir });
  return await isShallow();
}

/**
 * Parse `git blame --porcelain` output into a line → login map.
 *
 * Each hunk starts with `<sha> <orig> <final> [num]` and carries
 * `author` / `author-mail` headers. The login is derived with
 * {@link loginFromGitIdentity}; hunks that yield no login are skipped.
 * A `boundary` commit (the edge of a shallow or limited history) is not
 * the line's real author, so its hunks are skipped too — unknown identity
 * fails closed.
 */
export function parseBlamePorcelain(stdout: string): Record<number, string> {
  const logins: Record<number, string> = {};
  const bySha = new Map<
    string,
    { name: string; email: string; boundary: boolean }
  >();
  let currentSha = "";
  let pendingLine: number | undefined;

  const flush = (): void => {
    if (pendingLine === undefined || currentSha.length === 0) return;
    const identity = bySha.get(currentSha);
    if (identity?.boundary) {
      pendingLine = undefined;
      return;
    }
    const login = loginFromGitIdentity(
      identity?.name ?? "",
      identity?.email ?? "",
    );
    if (login) logins[pendingLine] = login;
    pendingLine = undefined;
  };

  for (const raw of stdout.split("\n")) {
    const header = /^([0-9a-f]{40}) \d+ (\d+)(?: \d+)?$/.exec(raw);
    if (header) {
      flush();
      currentSha = header[1] ?? "";
      pendingLine = Number(header[2]);
      if (currentSha && !bySha.has(currentSha)) {
        bySha.set(currentSha, { name: "", email: "", boundary: false });
      }
      continue;
    }
    const identity = bySha.get(currentSha);
    if (!identity) continue;
    if (raw === "boundary") {
      identity.boundary = true;
      continue;
    }
    if (raw.startsWith("author ")) {
      identity.name = raw.slice("author ".length);
      continue;
    }
    if (raw.startsWith("author-mail ")) {
      identity.email = raw.slice("author-mail ".length).replace(/^<|>$/g, "");
    }
  }
  flush();
  return logins;
}
