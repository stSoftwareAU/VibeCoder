/**
 * Setup-time default `.github/CODEOWNERS` writer (Issue #2627, part of #2611).
 *
 * Modelled on `gitignore_sync.ts`: for one monitored repo it looks at the
 * clone under `WORK_DIR` and, only when the repo has no CODEOWNERS file
 * anywhere, writes a three-rule `.github/CODEOWNERS` that makes the configured
 * humans own the workflow, action and CODEOWNERS paths. The file rides along
 * in the next normal worker PR for the repo, the same way gitignore sync's
 * `.gitignore` does; code-owner review is enforced by a later setup run once
 * the file is on the default branch.
 *
 * It never edits an existing CODEOWNERS file. "No CODEOWNERS anywhere" means
 * both of these say absent:
 *   1. the local checkout, at each of the three locations GitHub reads;
 *   2. the default branch, through `findCodeownersOnDefaultBranch`.
 * A failed default-branch check is never read as absent — the repo is
 * skipped and the error is named.
 *
 * Checkout path: `${workDir}/<name>`, where `<name>` is the part of the
 * `owner/name` slug after the last `/` — exactly `gitignore_sync.ts`'s rule.
 *
 * Uses Australian English throughout.
 */

import type { CodeownersLocation } from "../lib/repo_settings_harden.ts";
import { isValidRepoSlug, renderInertRepoSlug } from "../lib/repo_slug.ts";

/** Outcome of one repo's CODEOWNERS pass. */
export type CodeownersSyncResult =
  | { status: "written"; path: string }
  | { status: "skipped"; reason: string }
  | { status: "error"; message: string };

/** Inputs for {@link syncCodeowners}. */
export interface CodeownersSyncOptions {
  /** `owner/name` slug. */
  repo: string;
  /** `WORK_DIR` root; the checkout is `${workDir}/<name>`. */
  workDir: string;
  /** Owners for every rule, e.g. `["@nleck", "@Green-Beret"]`. */
  owners: readonly string[];
  /** Default-branch lookup — `findCodeownersOnDefaultBranch` bound to `gh`. */
  findOnDefaultBranch: (repo: string) => Promise<CodeownersLocation>;
}

/** The owners used when `.config.json` has no `codeowners_owners` key. */
export const DEFAULT_CODEOWNERS_OWNERS: readonly string[] = Object.freeze([
  "@nleck",
  "@Green-Beret",
]);

/** Where the writer puts the file, relative to the checkout. */
export const CODEOWNERS_WRITE_PATH = ".github/CODEOWNERS";

/** Every location GitHub reads CODEOWNERS from, in its precedence order. */
export const CODEOWNERS_CHECK_PATHS: readonly string[] = Object.freeze([
  ".github/CODEOWNERS",
  "CODEOWNERS",
  "docs/CODEOWNERS",
]);

/** The three paths the default file protects. */
const PROTECTED_PATHS = [
  "/.github/workflows/",
  "/.github/actions/",
  "/.github/CODEOWNERS",
] as const;

/** A user (`@login`) or an org team (`@org/team`). */
const OWNER_PATTERN = /^@[A-Za-z0-9-]+(\/[A-Za-z0-9._-]+)?$/;

/**
 * Owners that must never be code owners, compared case-insensitively
 * (GitHub logins are). The fleet accounts would approve their own PRs;
 * `@stSoftwareAU/developers` includes those bots.
 */
const FORBIDDEN_OWNERS: ReadonlySet<string> = new Set([
  "@stservice",
  "@vibecoderst",
  "@stsoftwareau/developers",
]);

/**
 * Why `owner` cannot be a code owner, or `null` when it can. The message
 * always names the entry.
 */
export function codeownersOwnerError(owner: string): string | null {
  const lower = owner.toLowerCase();
  if (lower.endsWith("[bot]")) {
    return `"${owner}" is a bot account and cannot be a code owner`;
  }
  if (FORBIDDEN_OWNERS.has(lower)) {
    return `"${owner}" is a fleet (bot) account or includes one and cannot ` +
      "be a code owner";
  }
  if (!OWNER_PATTERN.test(owner)) {
    return `"${owner}" is not a code owner — expected @user or @org/team`;
  }
  return null;
}

/** Every problem with an owner list, each naming its entry. */
export function codeownersOwnersErrors(owners: readonly unknown[]): string[] {
  if (owners.length === 0) return ["at least one owner is required"];
  const errors: string[] = [];
  for (const owner of owners) {
    if (typeof owner !== "string") {
      errors.push(`${JSON.stringify(owner)} is not a string`);
      continue;
    }
    const error = codeownersOwnerError(owner);
    if (error) errors.push(error);
  }
  return errors;
}

/** The exact default file: three rules, each owned by `owners`. */
export function renderDefaultCodeowners(owners: readonly string[]): string {
  const ownerList = owners.join(" ");
  return PROTECTED_PATHS.map((path) => `${path} ${ownerList}\n`).join("");
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** True when anything — file, directory or dangling symlink — is at `path`. */
async function pathExists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path);
    return true;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return false;
    throw err;
  }
}

/**
 * Write the default `.github/CODEOWNERS` into one repo's checkout when the
 * repo has none (Issue #2627). Never modifies an existing file.
 */
export async function syncCodeowners(
  opts: CodeownersSyncOptions,
): Promise<CodeownersSyncResult> {
  const { repo, workDir, owners, findOnDefaultBranch } = opts;

  // A path is derived from the slug; `..` or an empty segment would steer
  // the write outside every clone (Issue #1291).
  if (!isValidRepoSlug(repo)) {
    return {
      status: "error",
      message: `invalid owner/repo slug ${
        renderInertRepoSlug(repo)
      } — refusing to derive a path from it`,
    };
  }
  const ownerErrors = codeownersOwnersErrors(owners);
  if (ownerErrors.length > 0) {
    return {
      status: "error",
      message: `codeowners_owners: ${ownerErrors.join("; ")}`,
    };
  }

  const repoName = repo.split("/").pop() ?? repo;
  const repoPath = `${workDir}/${repoName}`;

  try {
    const stat = await Deno.stat(repoPath);
    if (!stat.isDirectory) {
      return { status: "skipped", reason: "no local checkout" };
    }
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      return { status: "skipped", reason: "no local checkout" };
    }
    return {
      status: "error",
      message: `cannot read ${repoPath}: ${errorMessage(err)}`,
    };
  }

  try {
    for (const path of CODEOWNERS_CHECK_PATHS) {
      if (await pathExists(`${repoPath}/${path}`)) {
        return { status: "skipped", reason: `present at ${path}` };
      }
    }
  } catch (err) {
    return {
      status: "error",
      message: `cannot check the checkout for CODEOWNERS: ${errorMessage(err)}`,
    };
  }

  let location: CodeownersLocation;
  try {
    location = await findOnDefaultBranch(repo);
  } catch (err) {
    location = { state: "error", message: errorMessage(err) };
  }
  if (location.state === "present") {
    return { status: "skipped", reason: `present at ${location.path}` };
  }
  if (location.state === "error") {
    return {
      status: "skipped",
      reason: `default-branch check failed: ${location.message}`,
    };
  }

  try {
    await Deno.mkdir(`${repoPath}/.github`, { recursive: true });
    // `createNew` refuses to replace a file that appeared since the check.
    await Deno.writeTextFile(
      `${repoPath}/${CODEOWNERS_WRITE_PATH}`,
      renderDefaultCodeowners(owners),
      { createNew: true },
    );
  } catch (err) {
    return {
      status: "error",
      message: `cannot write ${CODEOWNERS_WRITE_PATH}: ${errorMessage(err)}`,
    };
  }
  return { status: "written", path: CODEOWNERS_WRITE_PATH };
}
