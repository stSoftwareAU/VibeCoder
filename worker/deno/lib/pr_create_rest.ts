/**
 * REST-backed pull-request creation (Issue #42).
 *
 * `gh pr create` is GraphQL-backed. When GitHub's *primary GraphQL* quota
 * is exhausted the completion phase loses the PR for work that has already
 * been done and pushed: in the observed run, 26 minutes of agent time and a
 * green quality gate produced a pushed branch, no PR, and an issue still
 * assigned to the worker — the branch orphaned until some later run noticed
 * it. The REST `pulls` endpoint rides the separate *core* quota (≈4 000
 * calls still available at the time), so it can land that PR when GraphQL
 * cannot.
 *
 * Every call here is `gh api <rest-path>`, which
 * `isQuotaExemptGhCall` deliberately exempts from the primary-quota latch —
 * never a `gh` subcommand and never `gh api graphql`.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Result } from "../types.ts";
import { runGhCommand } from "./github.ts";

/** What to open the pull request with. */
export interface RestPrCreateOptions {
  /** Repository in `owner/repo` form. */
  repo: string;
  /** PR title. */
  title: string;
  /** PR body (markdown). */
  body: string;
  /** Head branch, in the same repository. */
  head: string;
  /** Base branch the PR targets. */
  base: string;
  /** Reviewers to request — best-effort, never fails the creation. */
  reviewers?: readonly string[];
}

/** Injection seams. */
export interface RestPrCreateDeps {
  /** Runs `gh`; defaults to the retrying wrapper. */
  ghCommandFn?: (args: string[]) => Promise<string>;
  /** Log sink for best-effort steps. */
  log?: (message: string) => void;
}

/** `owner/repo` with the character set GitHub actually allows. */
const REPO_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

/**
 * Whether a create error means the pull request is already open.
 *
 * GitHub answers a duplicate `POST /repos/{owner}/{repo}/pulls` with HTTP
 * 422 and "A pull request already exists for owner:branch". The completion
 * phase's own pre-checks are GraphQL-backed, so while the quota is latched
 * they are skipped and this is the race we can still hit — the desired
 * state holds, so the caller recovers the existing PR instead of failing.
 */
export function isPrAlreadyExistsError(message: string): boolean {
  return message.toLowerCase().includes("pull request already exists");
}

/** Validate the fields that go into the endpoint path and the body. */
function validateOptions(options: RestPrCreateOptions): Result<void> {
  if (!REPO_PATTERN.test(options.repo)) {
    return {
      ok: false,
      error: new Error(`Invalid repo '${options.repo}' (expected owner/repo)`),
    };
  }
  if (!options.head.trim()) {
    return { ok: false, error: new Error("Head branch is empty") };
  }
  if (!options.base.trim()) {
    return { ok: false, error: new Error("Base branch is empty") };
  }
  return { ok: true, value: undefined };
}

/** The single URL a `--jq` read produced, or null when there was none. */
function firstUrl(raw: string): string | null {
  const value = raw.trim();
  if (!value || value === "null") return null;
  return value.split("\n")[0]?.trim() || null;
}

/**
 * Find the open PR for a head branch over REST.
 *
 * Used both as the duplicate-create recovery and as a quota-safe
 * replacement for the GraphQL `gh pr list --head` lookup.
 */
export async function findOpenPrUrlViaRest(
  repo: string,
  head: string,
  ghCommandFn: (args: string[]) => Promise<string> = runGhCommand,
): Promise<Result<string>> {
  if (!REPO_PATTERN.test(repo)) {
    return {
      ok: false,
      error: new Error(`Invalid repo '${repo}' (expected owner/repo)`),
    };
  }
  const owner = repo.split("/")[0]!;
  try {
    const raw = await ghCommandFn([
      "api",
      "-X",
      "GET",
      `repos/${repo}/pulls`,
      "-f",
      `head=${owner}:${head}`,
      "-f",
      "state=open",
      "--jq",
      ".[0].html_url",
    ]);
    const url = firstUrl(raw);
    if (url) return { ok: true, value: url };
    return {
      ok: false,
      error: new Error(`No open PR found for branch '${head}' in ${repo}`),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: new Error(
        `REST PR lookup failed for branch '${head}' in ${repo}: ${message}`,
      ),
    };
  }
}

/** Request reviewers over REST. Best-effort: a failure is logged, not fatal. */
async function requestReviewersViaRest(
  repo: string,
  prNumber: number,
  reviewers: readonly string[],
  ghCommandFn: (args: string[]) => Promise<string>,
  log?: (message: string) => void,
): Promise<void> {
  if (reviewers.length === 0 || prNumber <= 0) return;
  const fields = reviewers.flatMap((r) => ["-f", `reviewers[]=${r}`]);
  try {
    await ghCommandFn([
      "api",
      "-X",
      "POST",
      `repos/${repo}/pulls/${prNumber}/requested_reviewers`,
      ...fields,
    ]);
  } catch (err) {
    log?.(
      `REST reviewer request failed (non-fatal) for ${repo}#${prNumber}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/** The PR number in a `…/pull/<n>` URL, or 0 when it cannot be read. */
function prNumberFromUrl(url: string): number {
  const match = url.match(/\/pull\/(\d+)/);
  return match ? parseInt(match[1]!, 10) : 0;
}

/**
 * Create a pull request through the REST API.
 *
 * `-f` (raw-field) is used deliberately for every value: unlike `-F`, it
 * never expands a leading `@` into a file read, so an arbitrary title or
 * body is sent verbatim.
 *
 * Returns the PR's `html_url`. A duplicate (HTTP 422 already-exists)
 * resolves to the existing PR's URL rather than an error; anything else
 * fails loudly with the underlying message attached.
 */
export async function createPullRequestViaRest(
  options: RestPrCreateOptions,
  deps: RestPrCreateDeps = {},
): Promise<Result<string>> {
  const valid = validateOptions(options);
  if (!valid.ok) return valid;

  const ghCommandFn = deps.ghCommandFn ?? runGhCommand;
  const { repo, title, body, head, base } = options;

  let url: string;
  try {
    const raw = await ghCommandFn([
      "api",
      "-X",
      "POST",
      `repos/${repo}/pulls`,
      "-f",
      `title=${title}`,
      "-f",
      `body=${body}`,
      "-f",
      `head=${head}`,
      "-f",
      `base=${base}`,
      "--jq",
      ".html_url",
    ]);
    const created = firstUrl(raw);
    if (!created) {
      return {
        ok: false,
        error: new Error(
          `REST PR creation in ${repo} returned no html_url for branch '${head}'`,
        ),
      };
    }
    url = created;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (isPrAlreadyExistsError(message)) {
      const existing = await findOpenPrUrlViaRest(repo, head, ghCommandFn);
      if (existing.ok) {
        deps.log?.(
          `REST PR creation found an existing PR for '${head}' in ${repo}: ${existing.value}`,
        );
        return existing;
      }
      return {
        ok: false,
        error: new Error(
          `REST PR creation in ${repo} reported an existing PR for '${head}' ` +
            `but it could not be read back: ${existing.error.message}`,
        ),
      };
    }
    return {
      ok: false,
      error: new Error(
        `REST PR creation failed for branch '${head}' in ${repo}: ${message}`,
      ),
    };
  }

  await requestReviewersViaRest(
    repo,
    prNumberFromUrl(url),
    options.reviewers ?? [],
    ghCommandFn,
    deps.log,
  );

  return { ok: true, value: url };
}
