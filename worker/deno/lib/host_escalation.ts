/**
 * The worker's own escalation channel — how a HOST-level failure reaches a
 * human (Issue #556).
 *
 * Every other report the worker makes rides the issue it is working on. A
 * failure that happens *before* any issue is claimed — the checkout update
 * (#4204), the container launcher's crash-loop (#4072), a credential that
 * stopped working (#554) — has no such target, and that is exactly when the
 * operator most needs telling: nothing is being worked, and nothing will be
 * until somebody looks.
 *
 * Observed live: GRQ-23 failed 20 consecutive runs across ten hours while the
 * escalation path recorded `"reported worker_run failure to GitHub"` with
 * `repo: ""` and `issueNumber: 0`. No issue existed. The outage was found by a
 * human reading a terminal.
 *
 * So the channel is a deduplicated issue in the worker's OWN repository,
 * titled for the host: one issue per host per condition, commented on while
 * the condition persists rather than re-filed. `checkout_update.ts` invented
 * this shape; this module is that shape, shared.
 *
 * Australian English spelling throughout (behaviour, organisation, authorised).
 */

import { runGitCommand } from "./git_timeout.ts";
import {
  type GhSpawnOptions,
  type GhSpawnResult,
  spawnGh,
} from "./gh_spawn.ts";
import {
  ALERT_DEDUP_TITLE_JSON_FIELDS,
  type AlertDedupAuthorOptions,
  type AlertDedupRow,
  selectFleetAuthoredMatches,
} from "./alert_dedup_authors.ts";
import {
  GH_CREDENTIAL_SUBDIR,
  GH_HOSTS_FILE,
  GH_RUNTIME_CONFIG_SUFFIX,
  SCRATCH_DIR_ENV,
} from "./credential_preflight.ts";
import { type EnvLookup, processEnvLookup } from "./env_lookup.ts";

/** Parse `owner/repo` out of a git origin URL (SSH or HTTPS). */
export function parseOriginRepo(url: string): string | null {
  const match = url.trim().match(
    /github\.com[/:]([^/\s]+\/[^/\s]+?)(?:\.git)?$/,
  );
  return match ? match[1]! : null;
}

/**
 * The host's own identity, used in every escalation title.
 *
 * @param env - Reads `VIBE_HOST_ID`; defaults to the process environment, so
 *   production callers pass nothing (Issue #967). A test hands in a fixed map
 *   rather than mutating the environment every parallel worker shares.
 */
export function escalationHostId(env: EnvLookup = processEnvLookup): string {
  let fromEnv: string | undefined;
  try {
    fromEnv = env("VIBE_HOST_ID")?.trim();
  } catch {
    fromEnv = undefined;
  }
  if (fromEnv) return fromEnv;
  try {
    return Deno.hostname().split(".")[0] || "unknown-host";
  } catch {
    return "unknown-host";
  }
}

/**
 * The `gh` environment an escalation runs with.
 *
 * These reports fire before (or instead of) the worker's configuration load,
 * so `GH_CONFIG_DIR` may not be established yet. Both staging locations are
 * probed: the entrypoint moved its writable copy to the scratch root when the
 * container root filesystem became read-only (Issue #515), and the legacy
 * path remains for a host or an older image.
 *
 * @param env - Reads `GH_CONFIG_DIR`, `HOME` and the scratch root; defaults to
 *   the process environment (Issue #967).
 */
export async function resolveEscalationGhEnv(
  env: EnvLookup = processEnvLookup,
): Promise<Record<string, string>> {
  const ghEnv: Record<string, string> = {};
  if (env("GH_CONFIG_DIR")) return ghEnv;
  const home = env("HOME");
  const scratch = env(SCRATCH_DIR_ENV);
  const candidates = [
    scratch ? `${scratch}/${GH_CREDENTIAL_SUBDIR}` : undefined,
    home ? `${home}/${GH_RUNTIME_CONFIG_SUFFIX}` : undefined,
  ].filter((dir): dir is string => dir !== undefined);
  for (const candidate of candidates) {
    try {
      await Deno.stat(`${candidate}/${GH_HOSTS_FILE}`);
      ghEnv.GH_CONFIG_DIR = candidate;
      break;
    } catch {
      // No staged copy here — try the next, else let gh resolve its own.
    }
  }
  return ghEnv;
}

/**
 * Resolve the worker's own repository from a checkout's `origin` remote.
 *
 * @param repoDir - A checkout of the worker's repository.
 * @returns `owner/repo`.
 * @throws When origin cannot be read or is not a GitHub repository.
 */
export async function resolveOriginRepo(repoDir: string): Promise<string> {
  const origin = await runGitCommand(["remote", "get-url", "origin"], {
    cwd: repoDir,
  });
  if (!origin.ok || origin.value.code !== 0) {
    throw new Error("cannot resolve the checkout's origin remote");
  }
  const repo = parseOriginRepo(origin.value.stdout);
  if (!repo) {
    throw new Error(
      `origin is not a GitHub repository: ${origin.value.stdout.trim()}`,
    );
  }
  return repo;
}

/** What {@link fileOrCommentIssue} did with the report. */
export type EscalationDelivery = "created" | "commented";

/** One host-level escalation to deliver. */
export interface HostEscalation {
  /** `owner/repo` receiving the report. */
  repo: string;
  /** Exact title — also the deduplication key. */
  title: string;
  /** Markdown body. */
  body: string;
  /** Extra environment for `gh` (see {@link resolveEscalationGhEnv}). */
  env?: Record<string, string>;
}

/**
 * Injected seams for {@link fileOrCommentIssue}.
 *
 * Extends {@link AlertDedupAuthorOptions}: `fleetAuthors` (tests) or the
 * configured fleet identity (production) decides whose title match may
 * receive the escalation body.
 */
export interface FileOrCommentDeps extends AlertDedupAuthorOptions {
  /** Runs `gh`. Production: {@link spawnGh}. */
  ghFn?: (
    args: readonly string[],
    options: GhSpawnOptions,
  ) => Promise<GhSpawnResult>;
  /** Sink for the author-verification diagnostics. Defaults to `console.warn`. */
  log?: (message: string) => void;
}

/**
 * File the escalation, or comment on the open issue that already carries this
 * exact title **and that the fleet itself opened**.
 *
 * Deduplication is by exact title so an ongoing condition stays ONE incident.
 * A title is chosen by whoever opens the issue, though, so a title match on
 * its own would let anybody both silence a host-level escalation and have its
 * body posted onto an issue of their choosing — and this function would then
 * report `"commented"`, i.e. success, for a report that landed somewhere it
 * was never meant to go. The match therefore counts only when a fleet account
 * authored the issue.
 *
 * An unparseable listing, a failed listing or an unresolvable fleet all fall
 * through to creating a fresh issue: a duplicate report is recoverable, a lost
 * or misdirected escalation is not.
 *
 * @param escalation - The report and where it goes.
 * @param deps - Injected `gh`, log sink and fleet identity.
 * @returns Whether the report was created or added to an existing issue.
 * @throws When `gh` refuses the write — the caller must know it was not
 *   delivered, which is the whole of Issue #556.
 */
export async function fileOrCommentIssue(
  escalation: HostEscalation,
  deps: FileOrCommentDeps = {},
): Promise<EscalationDelivery> {
  const { repo, title, body } = escalation;
  const env = escalation.env ?? await resolveEscalationGhEnv();
  const gh = deps.ghFn ?? spawnGh;
  const log = deps.log ?? ((message: string) => console.warn(message));

  const listed = await listOpenIssuesTitled(gh, repo, title, env);
  let existing: number | undefined;
  if (listed !== null) {
    const verified = await selectFleetAuthoredMatches(
      listed,
      `host escalation ${repo}`,
      deps,
      log,
      'a fresh issue is created — reporting "commented" for a report ' +
        "that landed on an issue the fleet did not open would be a lie",
    );
    existing = verified[0]?.number;
  }

  const result = existing
    ? await gh(
      ["issue", "comment", `${existing}`, "--repo", repo, "--body", body],
      { env },
    )
    : await gh(
      ["issue", "create", "--repo", repo, "--title", title, "--body", body],
      { env },
    );
  if (result.code !== 0) {
    throw new Error(
      `gh issue ${
        existing ? "comment" : "create"
      } exited ${result.code}: ${result.stderr.trim()}`,
    );
  }
  return existing ? "commented" : "created";
}

/** An open issue row carrying the exact title the channel deduplicates on. */
type TitledIssueRow = AlertDedupRow & { title?: string };

/**
 * The open issues in `repo` whose title is exactly `title`.
 *
 * `null` when the listing failed or could not be parsed — the caller decides
 * whether that is "create a fresh issue" (filing) or "nothing to close"
 * (closing); this helper only refuses to invent an answer.
 */
async function listOpenIssuesTitled(
  gh: NonNullable<FileOrCommentDeps["ghFn"]>,
  repo: string,
  title: string,
  env: Record<string, string>,
): Promise<TitledIssueRow[] | null> {
  const listed = await gh(
    [
      "issue",
      "list",
      "--repo",
      repo,
      "--state",
      "open",
      "--search",
      `in:title "${title}"`,
      "--json",
      ALERT_DEDUP_TITLE_JSON_FIELDS,
    ],
    { env },
  );
  if (listed.code !== 0) return null;
  try {
    const issues = JSON.parse(listed.stdout) as TitledIssueRow[];
    return issues.filter((issue) => issue.title === title);
  } catch {
    return null;
  }
}

/** Whether a resolved condition's report was found and closed. */
export type EscalationClosure = "closed" | "none";

/**
 * Close the open report for a condition that has ended, with the recovery as
 * its closing comment (Issue #2039).
 *
 * The other half of {@link fileOrCommentIssue}. A report whose body says "a
 * single success clears it" and then stays open until a human closes it has
 * only moved the manual step, not removed it: after the 2026-09-11 callback
 * contract bump the fleet raised eight such reports and a human closed all
 * eight by hand after every host had recovered. The worker that raised the
 * report is the one that knows the condition is over, so it retires it.
 *
 * Same authorship rule as filing: only an issue a fleet account opened is
 * closed. A title match somebody else opened is left alone — closing it
 * would silence a report that was never ours.
 *
 * @param escalation - The title the report was filed under and the recovery
 *   to leave on it. `body` becomes the closing comment.
 * @param deps - Injected `gh`, log sink and fleet identity.
 * @returns `"closed"` when at least one report was closed, `"none"` when
 *   nothing under that title was open (or none of it was the fleet's).
 * @throws When the listing or a close was refused — the caller must know the
 *   report is still open.
 */
export async function closeResolvedIssue(
  escalation: HostEscalation,
  deps: FileOrCommentDeps = {},
): Promise<EscalationClosure> {
  const { repo, title, body } = escalation;
  const env = escalation.env ?? await resolveEscalationGhEnv();
  const gh = deps.ghFn ?? spawnGh;
  const log = deps.log ?? ((message: string) => console.warn(message));

  const listed = await listOpenIssuesTitled(gh, repo, title, env);
  if (listed === null) {
    throw new Error(`gh issue list --repo ${repo} could not be read`);
  }
  const verified = await selectFleetAuthoredMatches(
    listed,
    `host escalation close ${repo}`,
    deps,
    log,
    "the report is left open — closing an issue the fleet did not open " +
      "would silence somebody else's",
  );
  if (verified.length === 0) return "none";
  for (const issue of verified) {
    const closed = await gh(
      ["issue", "close", `${issue.number}`, "--repo", repo, "--comment", body],
      { env },
    );
    if (closed.code !== 0) {
      throw new Error(
        `gh issue close ${issue.number} exited ${closed.code}: ${closed.stderr.trim()}`,
      );
    }
  }
  return "closed";
}
