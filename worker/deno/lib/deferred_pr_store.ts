/**
 * Pull requests whose creation GitHub refused for its secondary
 * (content-creation) rate limit, parked for the next cycle (Issue #1951).
 *
 * The work behind a deferred PR is finished: committed, quality-gated and
 * pushed. Only the `gh pr create` call was refused, by a throttle that clears
 * itself in minutes. Recording the intent here — branch, base, title and the
 * PR body the run had already composed — is what lets the next cycle's drain
 * (`deferred_pr_drain.ts`) raise that PR with no agent run at all, instead of
 * the run being charged as a failure and the branch left orphaned until some
 * later claim happens to notice it.
 *
 * One file per issue under `<workDir>/.deferred_prs/`, so a second deferral of
 * the same issue replaces the first rather than queueing a duplicate.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Result } from "../types.ts";
import { atomicWrite } from "./file_utils.ts";
import { redactSecrets } from "./secret_redaction.ts";

/** Directory (under the work dir) holding one JSON file per deferred PR. */
export const DEFERRED_PR_DIR = ".deferred_prs";

/** Marker naming a release comment as "the PR for this work is pending". */
export const PR_PENDING_MARKER = "<!-- vibe-pr-pending -->";

/** Everything the drain needs to raise the PR without re-running the agent. */
export interface DeferredPrRecord {
  /** `owner/repo`. */
  repo: string;
  issueNumber: number;
  /** Head branch — already pushed. */
  branch: string;
  /** Base branch the PR targets (the milestone branch, where applicable). */
  base: string;
  title: string;
  /** The PR body the run composed, verbatim. */
  body: string;
  /** Reviewers the run would have requested. */
  reviewers?: string[];
  /** When the deferral was recorded (epoch seconds). */
  deferredAtEpoch: number;
  /** Drain attempts made so far — bounds the retrying. */
  attempts: number;
  /** The refusal, in one line, as the run last saw it. */
  lastError: string;
}

/** `owner/repo` with the character set GitHub actually allows. */
const REPO_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

/** The directory deferred records live in. */
export function deferredPrDir(workDir: string): string {
  return `${workDir}/${DEFERRED_PR_DIR}`;
}

/**
 * Path of one record.
 *
 * The repo slug is validated, never interpolated blind: it reaches this
 * module from a run's context, and a `../` inside it would otherwise choose
 * the file that gets written.
 */
export function deferredPrPath(
  workDir: string,
  repo: string,
  issueNumber: number,
): Result<string> {
  if (!REPO_PATTERN.test(repo)) {
    return {
      ok: false,
      error: new Error(`Invalid repo '${repo}' (expected owner/repo)`),
    };
  }
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    return {
      ok: false,
      error: new Error(`Invalid issue number '${issueNumber}'`),
    };
  }
  return {
    ok: true,
    value: `${deferredPrDir(workDir)}/${
      repo.replace("/", "__")
    }__${issueNumber}.json`,
  };
}

/** Whether a parsed object carries every field the drain needs. */
export function isDeferredPrRecord(value: unknown): value is DeferredPrRecord {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.repo === "string" && REPO_PATTERN.test(r.repo) &&
    typeof r.issueNumber === "number" && Number.isInteger(r.issueNumber) &&
    r.issueNumber > 0 &&
    typeof r.branch === "string" && r.branch.trim().length > 0 &&
    typeof r.base === "string" && r.base.trim().length > 0 &&
    typeof r.title === "string" && r.title.trim().length > 0 &&
    typeof r.body === "string" &&
    typeof r.deferredAtEpoch === "number" &&
    typeof r.attempts === "number" &&
    typeof r.lastError === "string"
  );
}

/**
 * Park a deferred PR.
 *
 * Fails loud: the caller reports a write failure on the issue thread rather
 * than reporting a deferral the next cycle knows nothing about.
 */
export async function recordDeferredPr(
  workDir: string,
  record: DeferredPrRecord,
): Promise<Result<string>> {
  const path = deferredPrPath(workDir, record.repo, record.issueNumber);
  if (!path.ok) return path;
  if (!isDeferredPrRecord(record as unknown)) {
    return {
      ok: false,
      error: new Error(
        `Incomplete deferred-PR record for ${record.repo}#` +
          `${record.issueNumber}`,
      ),
    };
  }
  try {
    await Deno.mkdir(deferredPrDir(workDir), { recursive: true });
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }
  const written = await atomicWrite({
    targetFile: path.value,
    content: `${JSON.stringify(record, null, 2)}\n`,
  });
  if (!written.ok) return { ok: false, error: written.error };
  return { ok: true, value: path.value };
}

/**
 * Every parked PR, oldest deferral first.
 *
 * A file that cannot be read or does not parse is reported through `onProblem`
 * and skipped — never silently swallowed, and never allowed to stop the rest
 * of the drain.
 */
export async function listDeferredPrs(
  workDir: string,
  onProblem?: (message: string) => void,
): Promise<DeferredPrRecord[]> {
  const dir = deferredPrDir(workDir);
  const records: DeferredPrRecord[] = [];
  let entries: Deno.DirEntry[];
  try {
    entries = [];
    for await (const entry of Deno.readDir(dir)) entries.push(entry);
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) {
      onProblem?.(
        `Could not read ${dir}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    return records;
  }
  for (const entry of entries) {
    if (!entry.isFile || !entry.name.endsWith(".json")) continue;
    const path = `${dir}/${entry.name}`;
    try {
      const parsed = JSON.parse(await Deno.readTextFile(path));
      if (!isDeferredPrRecord(parsed)) {
        onProblem?.(`Discarding malformed deferred-PR record ${path}`);
        continue;
      }
      records.push(parsed);
    } catch (err) {
      onProblem?.(
        `Could not read deferred-PR record ${path}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  records.sort((a, b) => a.deferredAtEpoch - b.deferredAtEpoch);
  return records;
}

/** Drop a parked PR — it was raised, or it was abandoned. */
export async function clearDeferredPr(
  workDir: string,
  repo: string,
  issueNumber: number,
): Promise<Result<void>> {
  const path = deferredPrPath(workDir, repo, issueNumber);
  if (!path.ok) return path;
  try {
    await Deno.remove(path.value);
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) {
      return {
        ok: false,
        error: err instanceof Error ? err : new Error(String(err)),
      };
    }
  }
  return { ok: true, value: undefined };
}

/**
 * The note the run leaves on the issue when it parks a PR.
 *
 * Names the branch (the work is on it, and nothing else says so), states that
 * the PR is pending rather than lost, and carries {@link PR_PENDING_MARKER}
 * so the state is greppable from the thread.
 *
 * The refusal is `gh` stderr, which can echo a URL carrying a token, so it is
 * redacted here: every outbound sink routes through `redactSecrets`
 * independently, and `postComment` does none of its own.
 */
export function formatPrPendingComment(record: DeferredPrRecord): string {
  return `${PR_PENDING_MARKER}\n` +
    `⏳ **PR pending** — the work for this issue is finished, committed and ` +
    `pushed to \`${record.branch}\`, but GitHub's secondary ` +
    `(content-creation) rate limit refused the pull request:\n\n` +
    `> ${redactSecrets(record.lastError).replace(/\s+/g, " ").trim()}\n\n` +
    `That throttle clears itself in minutes. The PR (\`${record.branch}\` → ` +
    `\`${record.base}\`) is queued and the next cycle raises it — no further ` +
    `agent run is needed, and nothing on the branch is lost.`;
}
