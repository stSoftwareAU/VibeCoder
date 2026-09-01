/**
 * Per-source probes for the references refresh sweep (Issue #665).
 *
 * `docs/REFERENCES.md` is a shopping list: every row is somewhere we can go
 * back to and ask "has anything new landed?". A probe answers that question
 * for one row, and it answers it in two ways because the sources are of two
 * kinds:
 *
 *   - **A GitHub repository** (spec-kit, mattpocock/skills) moves weekly and
 *     tells us exactly what moved. The probe records the head commit of the
 *     default branch and, on the next sweep, asks the API which files changed
 *     between the recorded commit and the new head. Each directory of changed
 *     files is one unit of new material.
 *   - **Everything else** (SPDX, SemVer, the Rust Book) is a page. The probe
 *     fetches it, strips the markup and fingerprints the visible text, so a
 *     rotating nonce or a reformatted line does not read as new material.
 *
 * Fail loud (Issue #3234): an unreachable page, an unparseable API response or
 * a commit range the API will not compare is an error. A source that could not
 * be probed must never be reported as a source with nothing new.
 *
 * Nothing here is fetched during a worker run — the sweep is a maintenance
 * command a human starts, and its only output is issues for that human to vet.
 * Everything a probe returns is untrusted data, fenced before it reaches an
 * issue body.
 *
 * Australian English spelling used throughout (behaviour, normalise).
 */

import type { ReferenceEntry } from "./references_doc.ts";
import {
  DEFAULT_FETCH_TIMEOUT_MS,
  describeFetchFailure,
  readTextBounded,
  withRequestTimeout,
} from "./bounded_fetch.ts";
import { runGhCommand } from "./github.ts";

/** One unit of material that has landed in a source since we last looked. */
export interface SourceGap {
  /**
   * Source-local key for this unit, carrying the revision it was seen at so
   * the same directory moving again next year is a fresh proposal rather than
   * a duplicate of the one already filed.
   */
  key: string;
  /** Human-readable name of the unit — a directory, or "the page". */
  unit: string;
  /** Untrusted detail lines naming what moved; fenced before it is rendered. */
  detail: string[];
}

/** What one probe learnt about one source. */
export interface SourceProbe {
  /** Fingerprint of the source's material as it stands now. */
  revision: string;
  /** New material since the recorded revision; empty when nothing moved. */
  gaps: SourceGap[];
}

/** Injectable I/O so the probes are testable without the network. */
export interface ProbeDeps {
  /** Runs `gh` with the given arguments and returns stdout. */
  ghCommandFn: (args: string[]) => Promise<string>;
  /** Fetches a URL and returns the body text; throws on any failure. */
  fetchTextFn: (url: string) => Promise<string>;
}

/** Deepest directory a unit of material is grouped at. */
const MAX_UNIT_SEGMENTS = 3;

/** Cap on the changed paths listed for one unit, so a body stays readable. */
const MAX_DETAIL_LINES = 20;

/**
 * Owner and repository of a GitHub repository URL, or null.
 *
 * Only `https://github.com/<owner>/<repo>` counts. A profile page, a docs
 * host, or any other URL is a page source and is probed by fetching it.
 *
 * @param url - Canonical source URL from the credit row
 * @returns The owner/repo pair, or null when the URL names no repository
 */
export function parseGitHubRepo(
  url: string,
): { owner: string; repo: string } | null {
  const match = url.match(
    /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:[/?#].*)?$/,
  );
  const owner = match?.[1];
  const repo = match?.[2];
  if (owner === undefined || repo === undefined) return null;
  return { owner, repo };
}

/**
 * Group changed paths into units of material.
 *
 * A unit is the directory holding the changed file, capped at
 * {@link MAX_UNIT_SEGMENTS} segments so a deep tree still groups into
 * reviewable chunks; a file at the repository root is its own unit. Keys come
 * back sorted, and each unit keeps its paths in the order the API listed them.
 *
 * @param paths - Repository-relative paths that changed
 * @returns Unit name to the paths it holds, sorted by unit
 */
export function groupChangedPaths(
  paths: readonly string[],
): Map<string, string[]> {
  const grouped = new Map<string, string[]>();
  for (const path of paths) {
    const segments = path.split("/");
    const unit = segments.length === 1
      ? path
      : segments.slice(0, Math.min(segments.length - 1, MAX_UNIT_SEGMENTS))
        .join("/");
    const existing = grouped.get(unit);
    if (existing === undefined) grouped.set(unit, [path]);
    else existing.push(path);
  }
  return new Map([...grouped].sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * Reduce a fetched page to its visible text.
 *
 * Scripts, styles, HTML comments and markup are dropped and whitespace runs
 * collapse to a single space, so the fingerprint tracks what the page *says*
 * rather than the nonce, the advert or the reflowed paragraph it happens to
 * carry on this request. Pure — no I/O.
 *
 * @param html - Raw response body
 * @returns The page's visible text, whitespace-normalised
 */
export function normalisePageText(html: string): string {
  return html
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Hex SHA-256 of `text`. */
async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** Parse a `gh api` response, naming what was being read when it fails. */
function parseApi(raw: string, what: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`could not read ${what}: ${(error as Error).message}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`could not read ${what}: expected a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

/** Head commit of the repository's default branch. */
async function headCommit(
  owner: string,
  repo: string,
  deps: ProbeDeps,
): Promise<string> {
  const meta = parseApi(
    await deps.ghCommandFn(["api", `repos/${owner}/${repo}`]),
    `the default branch of ${owner}/${repo}`,
  );
  const branch = meta["default_branch"];
  if (typeof branch !== "string" || branch === "") {
    throw new Error(
      `could not read the default branch of ${owner}/${repo}: ` +
        "the API response names none",
    );
  }
  const commit = parseApi(
    await deps.ghCommandFn(["api", `repos/${owner}/${repo}/commits/${branch}`]),
    `the head commit of ${owner}/${repo}@${branch}`,
  );
  const sha = commit["sha"];
  if (typeof sha !== "string" || sha === "") {
    throw new Error(
      `could not read the head commit of ${owner}/${repo}@${branch}: ` +
        "the API response carries no sha",
    );
  }
  return sha;
}

/** Changed paths between two commits, newest material first. */
async function changedPaths(
  owner: string,
  repo: string,
  since: string,
  head: string,
  deps: ProbeDeps,
): Promise<Array<{ path: string; status: string }>> {
  let raw: string;
  try {
    raw = await deps.ghCommandFn([
      "api",
      `repos/${owner}/${repo}/compare/${since}...${head}`,
    ]);
  } catch (error) {
    throw new Error(
      `could not compare ${since}...${head} in ${owner}/${repo}: ` +
        `${(error as Error).message}. Reset the recorded revision for this ` +
        "source if its history was rewritten.",
    );
  }
  const compared = parseApi(
    raw,
    `the ${since}...${head} range of ${owner}/${repo}`,
  );
  const files = compared["files"];
  if (!Array.isArray(files)) {
    throw new Error(
      `could not read the ${since}...${head} range of ${owner}/${repo}: ` +
        "the API response lists no files",
    );
  }
  const changed: Array<{ path: string; status: string }> = [];
  for (const file of files) {
    if (file === null || typeof file !== "object") continue;
    const record = file as Record<string, unknown>;
    const path = record["filename"];
    const status = typeof record["status"] === "string"
      ? record["status"]
      : "changed";
    // A deleted file is not new material to take an idea from.
    if (typeof path !== "string" || path === "" || status === "removed") {
      continue;
    }
    changed.push({ path, status });
  }
  return changed;
}

/** Probe a GitHub repository through the API. */
async function probeRepository(
  owner: string,
  repo: string,
  since: string | undefined,
  deps: ProbeDeps,
): Promise<SourceProbe> {
  const head = await headCommit(owner, repo, deps);
  if (since === undefined || since === head) {
    return { revision: head, gaps: [] };
  }

  const changed = await changedPaths(owner, repo, since, head, deps);
  const statuses = new Map(changed.map((file) => [file.path, file.status]));
  const gaps: SourceGap[] = [];
  for (const [unit, paths] of groupChangedPaths(changed.map((f) => f.path))) {
    gaps.push({
      key: `${unit}@${head.slice(0, 7)}`,
      unit,
      detail: paths.slice(0, MAX_DETAIL_LINES).map((path) =>
        `${path} (${statuses.get(path) ?? "changed"})`
      ),
    });
  }
  return { revision: head, gaps };
}

/** Probe a page by fingerprinting its visible text. */
async function probePage(
  url: string,
  since: string | undefined,
  deps: ProbeDeps,
): Promise<SourceProbe> {
  const body = await deps.fetchTextFn(url);
  const revision = await sha256Hex(normalisePageText(body));
  if (since === undefined || since === revision) return { revision, gaps: [] };
  return {
    revision,
    gaps: [{
      key: `page@${revision.slice(0, 12)}`,
      unit: "the page",
      detail: [],
    }],
  };
}

/**
 * Probe one credited source for material that has landed since `since`.
 *
 * @param entry - The credit row being re-checked
 * @param since - Revision recorded by the previous sweep, if any
 * @param deps - Injectable `gh` and fetch
 * @returns The current revision and the gaps found
 * @throws Error when the source could not be probed
 */
export function probeReferenceSource(
  entry: ReferenceEntry,
  since: string | undefined,
  deps: ProbeDeps,
): Promise<SourceProbe> {
  const repository = parseGitHubRepo(entry.url);
  return repository === null
    ? probePage(entry.url, since, deps)
    : probeRepository(repository.owner, repository.repo, since, deps);
}

/** Fetch a source page, bounded in time and size, failing loud on any error. */
async function fetchSourceText(url: string): Promise<string> {
  let response: Response;
  try {
    response = await fetch(url, withRequestTimeout({ redirect: "follow" }));
  } catch (error) {
    throw new Error(
      `could not fetch ${url}: ` +
        describeFetchFailure(error, DEFAULT_FETCH_TIMEOUT_MS),
    );
  }
  if (!response.ok) {
    // Draining is not needed — an unread body is cancelled with the response.
    await response.body?.cancel();
    throw new Error(`could not fetch ${url}: HTTP ${response.status}`);
  }
  const body = await readTextBounded(response);
  if (!body.ok) throw new Error(`could not read ${url}: ${body.error}`);
  return body.value;
}

/** Production dependencies — real `gh`, real bounded fetch. */
export function createDefaultProbeDeps(): ProbeDeps {
  return {
    ghCommandFn: (args) => runGhCommand(args),
    fetchTextFn: fetchSourceText,
  };
}
