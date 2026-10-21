/**
 * GitHub context for issue routing (Issue #3742, part of #3691).
 *
 * {@link requireWriteAccess} checks the caller can file into the repository at
 * all, and {@link normaliseRoutingTitle} compares titles by words. Duplicate
 * detection lives in lib/owned_open_artefact.ts. {@link requireWriteAccess}
 * takes `ghCommandFn` as an injected dependency, the same pattern as
 * `createGitHubIssuesWithPartialFailures` in lib/github.ts, so tests make no
 * network calls. Every gh failure throws with gh's own stderr in the message.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { runGhCommand } from "./github.ts";
import { isValidRepoSlug, renderInertRepoSlug } from "./repo_slug.ts";

/** Runs one `gh` command and resolves to its stdout. */
export type GhCommandFn = (args: string[]) => Promise<string>;

/** Injection points; production defaults are `runGhCommand` and the wall clock. */
export interface IssueRoutingGithubDeps {
  ghCommandFn?: GhCommandFn;
  now?: () => Date;
}

/** Permissions that may file into a repository (GitHub returns these upper-case). */
const WRITE_PERMISSIONS: ReadonlySet<string> = new Set([
  "ADMIN",
  "MAINTAIN",
  "WRITE",
]);

/** The caller can read the repository but may not file into it. */
export class IssueRoutingPermissionError extends Error {
  readonly repository: string;
  readonly permission: string;

  constructor(repository: string, permission: string) {
    super(
      `Issue routing needs write access to ${repository}, but the caller has ${permission} permission`,
    );
    this.name = "IssueRoutingPermissionError";
    this.repository = repository;
    this.permission = permission;
  }
}

/** Folds case, compatibility forms and punctuation so titles compare by words. */
export function normaliseRoutingTitle(title: string): string {
  return title.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Resolves when the caller has ADMIN, MAINTAIN or WRITE on the repository.
 *
 * @throws IssueRoutingPermissionError when the viewer's permission is anything
 *   else, including none; a plain Error when the check itself fails
 */
export async function requireWriteAccess(
  repo: string,
  deps: IssueRoutingGithubDeps = {},
): Promise<void> {
  const ghCommandFn = deps.ghCommandFn ?? runGhCommand;
  if (!isValidRepoSlug(repo)) {
    throw new Error(
      `requireWriteAccess: invalid repository ${renderInertRepoSlug(repo)}`,
    );
  }
  let raw: string;
  try {
    raw = await ghCommandFn([
      "repo",
      "view",
      repo,
      "--json",
      "viewerPermission",
    ]);
  } catch (error) {
    throw new Error(
      `Write-access check for ${repo} failed: ${errorMessage(error)}`,
      { cause: error },
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Write-access check for ${repo} returned invalid JSON: ${
        errorMessage(error)
      }`,
      { cause: error },
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `Write-access check for ${repo} returned an unexpected response`,
    );
  }
  const v = (parsed as Record<string, unknown>).viewerPermission;
  // GitHub returns null when the viewer has no access at all.
  const observed = typeof v === "string" && v !== "" ? v : "none";
  if (!WRITE_PERMISSIONS.has(observed)) {
    throw new IssueRoutingPermissionError(repo, observed);
  }
}
