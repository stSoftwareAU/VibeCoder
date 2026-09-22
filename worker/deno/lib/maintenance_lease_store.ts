/**
 * Maintenance-lease store — where the fleet reads and writes the lease
 * (Issue #2450, Decision 2 of #2443).
 *
 * `maintenance_lease.ts` (#2448) decides whether this host should run a
 * repository's fixed-cost maintenance sweeps; this module is the place that
 * decision reads from and writes to. One hidden marker comment per holder
 * lives on a fleet-owned **anchor issue** in the repository itself, so every
 * host sees the same lease without a shared database.
 *
 * ## Why REST only
 *
 * The lease exists to stop four sweeps costing ≈ 20 GraphQL calls each, per
 * host, per cycle. A lease that itself cost GraphQL would eat the saving, so
 * every call here is `gh api` — the comment read, post, patch and delete, the
 * anchor search (`search/issues`) and the anchor creation
 * (`POST repos/{repo}/issues`). Every other `gh` sub-command is
 * GraphQL-backed (`gh_argv.ts`), `gh issue list` and `gh issue create`
 * included, so neither is used here.
 *
 * ## The anchor issue
 *
 * Resolved in order, and the first answer wins:
 *
 * 1. the per-repo `maintenance_lease_issue` config override;
 * 2. the number pinned in `${workDir}/.maintenance-lease-<owner>-<repo>`;
 * 3. an open issue in the repository carrying the anchor marker, filed by a
 *    fleet author — adopted and pinned, so a second host never files a
 *    duplicate;
 * 4. a freshly created anchor, pinned the same way.
 *
 * The anchor never carries a discovery label: it is fleet state, not work.
 *
 * ## Degraded, never fatal
 *
 * The lease is an optimisation, never a lock (`stream_holder.ts` doctrine). A
 * read that cannot be performed — API error, anchor missing and uncreatable,
 * a malformed repository name — logs `maintenance-lease: degraded — <reason>`
 * and returns `null`/`false` so the caller runs the pass rather than skipping
 * it. Nothing here throws at the caller, and nothing here is silent: a
 * degraded lease always says so on the log.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import type { RepoConfig } from "../types.ts";
import { isFleetAuthor } from "./fleet_authors.ts";
import {
  classifyGitHubError,
  GitHubErrorCategory,
} from "./github_errors.ts";
import {
  decideMaintenanceLease,
  formatMaintenanceLeaseMarker,
  MAINTENANCE_LEASE_MARKER_PREFIX,
  MAINTENANCE_LEASE_SECONDS,
  type MaintenanceLeaseHolder,
  type MaintenanceLeaseMarker,
  parseMaintenanceLeaseMarker,
} from "./maintenance_lease.ts";
import {
  deleteIssueComment,
  fetchMarkerComments,
} from "./marker_comment_pages.ts";
import { getRepoConfig } from "./repo_config.ts";
import { isValidRepoSlug } from "./repo_rulesets.ts";
import { installFromMachineId } from "./stream_holder.ts";

/** Marker that identifies the anchor issue in its body. */
export const MAINTENANCE_LEASE_ANCHOR_MARKER_PREFIX =
  "vibe-maintenance-lease-anchor";

/** Title every anchor issue carries. */
export const MAINTENANCE_LEASE_ANCHOR_TITLE =
  "Vibe Coder maintenance lease — do not close";

/** How many search hits the anchor lookup considers. */
const ANCHOR_SEARCH_LIMIT = "20";

/** Everything the store touches, injected so tests need no live GitHub. */
export interface MaintenanceLeaseIo {
  /** Runs `gh`. */
  ghCommandFn: (args: string[]) => Promise<string>;
  /**
   * Logins whose markers and anchors count — the set from
   * `resolveFleetMaintenanceAuthorSet()` (`fleet_authors.ts`). A marker by
   * anyone else is ignored, so an outsider cannot park a lease.
   */
  trustedAuthors: readonly string[];
  /** Directory the anchor pin file lives in. */
  workDir: string;
  /**
   * The **warning** sink: every line this module logs reports a lease that
   * degraded or a write that did not stick, and the run continues either way
   * (`stream_holder.ts` routes its own degraded lines to `console.warn`).
   */
  log: (message: string) => void;
  /** The `repo_config` map, for the `maintenance_lease_issue` override. */
  repoConfigs?: Record<string, RepoConfig>;
}

/** One lease marker comment, with the handle needed to patch or delete it. */
interface LeaseEntry {
  commentId: number;
  marker: MaintenanceLeaseMarker;
}

/** Render the anchor marker for `repo`. */
export function formatMaintenanceLeaseAnchorMarker(repo: string): string {
  return `<!-- ${MAINTENANCE_LEASE_ANCHOR_MARKER_PREFIX} repo=${repo} -->`;
}

/** Where the resolved anchor number is pinned for `repo`. */
export function maintenanceLeaseAnchorPinPath(
  workDir: string,
  repo: string,
): string {
  const [owner = "", name = ""] = repo.split("/");
  return `${workDir}/.maintenance-lease-${owner}-${name}`;
}

/** Record that the lease could not be used, and why. */
function degrade(io: MaintenanceLeaseIo, reason: string): void {
  io.log(`maintenance-lease: degraded — ${reason}`);
}

/** The message of a thrown value, whatever was thrown. */
function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * `value` as a positive issue number, or null when it is not one.
 *
 * Whole-string conversion, not `parseInt`: `2.5` and `7abc` are rejected
 * rather than silently truncated to an issue number nobody configured.
 */
function positiveIssueNumber(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const parsed = Number(trimmed);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Is `login` one of the fleet authors the store trusts?
 *
 * Delegates to `isFleetAuthor`, so the comparison is case-insensitive the way
 * GitHub logins are — a marker whose author differs only in case is this
 * host's fleet, not an outsider.
 */
function isTrustedAuthor(
  login: unknown,
  io: MaintenanceLeaseIo,
): boolean {
  if (typeof login !== "string") return false;
  return isFleetAuthor(login, [...io.trustedAuthors]);
}

/** The anchor number pinned for `repo`, or null when none is pinned. */
async function readPinnedAnchor(
  repo: string,
  io: MaintenanceLeaseIo,
): Promise<number | null> {
  const path = maintenanceLeaseAnchorPinPath(io.workDir, repo);
  try {
    return positiveIssueNumber(await Deno.readTextFile(path));
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return null;
    // An unreadable pin is not fatal — the search below still resolves the
    // anchor — but it must not pass unnoticed.
    io.log(
      `maintenance-lease: could not read the anchor pin ${path} — ${
        messageOf(err)
      }`,
    );
    return null;
  }
}

/** Pin `anchor` for `repo` so the next launch skips the search. */
async function pinAnchor(
  repo: string,
  anchor: number,
  io: MaintenanceLeaseIo,
): Promise<void> {
  const path = maintenanceLeaseAnchorPinPath(io.workDir, repo);
  try {
    await Deno.writeTextFile(path, `${anchor}\n`);
  } catch (err) {
    io.log(
      `maintenance-lease: could not pin anchor #${anchor} for ${repo} at ` +
        `${path} — ${messageOf(err)}`,
    );
  }
}

/**
 * The open fleet-authored anchor issue for `repo`, or null when there is none.
 *
 * Throws when the search itself failed: a lookup that could not be performed
 * must never read as "no anchor exists" and file a duplicate.
 */
async function findAnchorIssue(
  repo: string,
  io: MaintenanceLeaseIo,
): Promise<number | null> {
  // `gh api search/issues`, not `gh issue list`: every `gh` sub-command other
  // than `api` is GraphQL-backed (`gh_argv.ts`), and a lease that spends the
  // budget it exists to save is no lease at all.
  const raw = await io.ghCommandFn([
    "api",
    "-X",
    "GET",
    "search/issues",
    "-f",
    `q=repo:${repo} is:issue state:open in:body ` +
    `"${MAINTENANCE_LEASE_ANCHOR_MARKER_PREFIX} repo=${repo}"`,
    "-F",
    `per_page=${ANCHOR_SEARCH_LIMIT}`,
    "--jq",
    "[.items[] | {number: .number, body: .body, author: .user.login}]",
  ]);
  const rows = JSON.parse(raw.trim() || "[]") as Array<{
    number?: unknown;
    body?: unknown;
    author?: unknown;
  }>;
  const marker = formatMaintenanceLeaseAnchorMarker(repo);
  const numbers = rows
    .filter((row) => typeof row.body === "string" && row.body.includes(marker))
    .filter((row) => isTrustedAuthor(row.author, io))
    .map((row) => Number(row.number))
    .filter((number) => Number.isInteger(number) && number > 0);
  // The oldest hit wins, so every host converges on the same anchor when two
  // raced to file one.
  return numbers.length === 0 ? null : Math.min(...numbers);
}

/** The anchor issue body — what a human who finds it needs to know. */
function buildAnchorBody(repo: string): string {
  return `${formatMaintenanceLeaseAnchorMarker(repo)}
## Vibe Coder maintenance lease

This issue is the fleet's lease anchor for \`${repo}\`. Each host keeps one
hidden marker comment here naming the host that currently runs this
repository's maintenance sweeps, so the other hosts skip them.

**Do not close this issue.** Without the anchor every host runs every sweep
again, at roughly 20 GraphQL calls per sweep per cycle.`;
}

/**
 * File the anchor issue for `repo` and return its number.
 *
 * No discovery label is added: the anchor is fleet state, not work to pick up.
 */
async function createAnchorIssue(
  repo: string,
  io: MaintenanceLeaseIo,
): Promise<number | null> {
  const output = await io.ghCommandFn([
    "api",
    `repos/${repo}/issues`,
    "-X",
    "POST",
    "-f",
    `title=${MAINTENANCE_LEASE_ANCHOR_TITLE}`,
    "-f",
    `body=${buildAnchorBody(repo)}`,
    "--jq",
    ".number",
  ]);
  return positiveIssueNumber(output);
}

/** A resolved anchor, and which of the four sources answered. */
interface ResolvedAnchor {
  issue: number;
  source: "override" | "pin" | "search" | "created";
}

/** Resolve the anchor and say where the number came from. */
async function resolveAnchor(
  repo: string,
  io: MaintenanceLeaseIo,
): Promise<ResolvedAnchor | null> {
  // Validated before it reaches an argv or a file path: `repo` arrives from
  // operator configuration, and an unchecked value would land in a `gh api`
  // endpoint and in the pin file's name.
  if (!isValidRepoSlug(repo)) {
    degrade(io, `'${repo}' is not an owner/repo repository name`);
    return null;
  }

  const override = positiveIssueNumber(
    getRepoConfig(io.repoConfigs, repo, "maintenanceLeaseIssue"),
  );
  if (override !== null) return { issue: override, source: "override" };

  const pinned = await readPinnedAnchor(repo, io);
  if (pinned !== null) return { issue: pinned, source: "pin" };

  try {
    const found = await findAnchorIssue(repo, io);
    if (found !== null) {
      await pinAnchor(repo, found, io);
      return { issue: found, source: "search" };
    }
    const created = await createAnchorIssue(repo, io);
    if (created === null) {
      degrade(io, `the lease anchor issue in ${repo} could not be created`);
      return null;
    }
    await pinAnchor(repo, created, io);
    return { issue: created, source: "created" };
  } catch (err) {
    degrade(io, `anchor lookup failed for ${repo}: ${messageOf(err)}`);
    return null;
  }
}

/**
 * Resolve the anchor issue for `repo` — override, pin, search, create.
 *
 * The pin file is the per-launch memo: once written, resolution is a local
 * file read and costs no GitHub call at all.
 *
 * @returns The anchor issue number, or null when the lease is degraded
 */
export async function resolveMaintenanceLeaseAnchor(
  repo: string,
  io: MaintenanceLeaseIo,
): Promise<number | null> {
  return (await resolveAnchor(repo, io))?.issue ?? null;
}

/**
 * Drop a pin that points at an anchor GitHub says is gone.
 *
 * Without this a closed or deleted anchor would leave the host logging
 * `degraded` every cycle for ever, which is the symptom rather than a
 * recovery. The next call re-runs the search and re-creates the anchor.
 */
async function healStaleAnchor(
  repo: string,
  anchor: ResolvedAnchor,
  err: unknown,
  io: MaintenanceLeaseIo,
): Promise<void> {
  if (anchor.source !== "pin") return;
  const category = classifyGitHubError(messageOf(err)).category;
  if (category !== GitHubErrorCategory.NotFound) return;
  const path = maintenanceLeaseAnchorPinPath(io.workDir, repo);
  try {
    await Deno.remove(path);
    io.log(
      `maintenance-lease: anchor #${anchor.issue} for ${repo} is gone — ` +
        `dropped the pin, the next cycle resolves a new anchor`,
    );
  } catch (removeErr) {
    if (removeErr instanceof Deno.errors.NotFound) return;
    io.log(
      `maintenance-lease: could not drop the stale anchor pin ${path} — ${
        messageOf(removeErr)
      }`,
    );
  }
}

/**
 * Every trusted lease marker on the anchor.
 *
 * Throws when the read failed — the callers below turn that into a degraded
 * result, so a blind read can never pass as "no holder".
 */
async function readLeaseEntries(
  repo: string,
  anchor: number,
  io: MaintenanceLeaseIo,
): Promise<LeaseEntry[]> {
  const comments = await fetchMarkerComments(
    repo,
    anchor,
    MAINTENANCE_LEASE_MARKER_PREFIX,
    io.ghCommandFn,
  );
  const entries: LeaseEntry[] = [];
  for (const comment of comments) {
    if (!isTrustedAuthor(comment.author, io)) continue;
    const marker = parseMaintenanceLeaseMarker(comment.body);
    // The anchor's own marker, and any marker for another repository, are not
    // leases for this repository.
    if (marker === null || marker.repo !== repo) continue;
    if (!Number.isInteger(comment.id)) continue;
    entries.push({ commentId: comment.id, marker });
  }
  return entries;
}

/** The freshest entry — the newest comment wins a tie on `at=`. */
function freshest(entries: readonly LeaseEntry[]): LeaseEntry | null {
  let best: LeaseEntry | null = null;
  for (const entry of entries) {
    if (
      best === null || entry.marker.atEpoch > best.marker.atEpoch ||
      (entry.marker.atEpoch === best.marker.atEpoch &&
        entry.commentId > best.commentId)
    ) {
      best = entry;
    }
  }
  return best;
}

/**
 * Read the host that currently holds `repo`'s maintenance lease.
 *
 * @returns The holder for `decideMaintenanceLease`, or null when there is no
 *          holder — and equally when the lease could not be read, which is
 *          logged as degraded so the caller runs the pass
 */
export async function readMaintenanceLease(
  repo: string,
  io: MaintenanceLeaseIo,
): Promise<MaintenanceLeaseHolder | null> {
  const anchor = await resolveAnchor(repo, io);
  if (anchor === null) return null;

  try {
    const best = freshest(await readLeaseEntries(repo, anchor.issue, io));
    if (best === null) return null;
    return { host: best.marker.host, atEpoch: best.marker.atEpoch };
  } catch (err) {
    degrade(io, `lease read failed for ${repo}: ${messageOf(err)}`);
    await healStaleAnchor(repo, anchor, err, io);
    return null;
  }
}

/** The marker comment body — a hidden marker plus the line a human reads. */
function buildLeaseCommentBody(
  repo: string,
  holderHost: string,
  nowSeconds: number,
): string {
  return `${formatMaintenanceLeaseMarker(repo, holderHost, nowSeconds)}
Maintenance lease for \`${repo}\`: this host runs the repository's fixed-cost
maintenance sweeps while the lease is fresh (${MAINTENANCE_LEASE_SECONDS}s),
and the other hosts skip them. Refreshed automatically — no action needed.`;
}

/** Post the lease marker as a new comment on the anchor. */
async function postLeaseComment(
  repo: string,
  anchor: number,
  body: string,
  io: MaintenanceLeaseIo,
): Promise<void> {
  await io.ghCommandFn([
    "api",
    `repos/${repo}/issues/${anchor}/comments`,
    "-X",
    "POST",
    "-f",
    `body=${body}`,
  ]);
}

/** Refresh this host's existing lease marker in place. */
async function patchLeaseComment(
  repo: string,
  commentId: number,
  body: string,
  io: MaintenanceLeaseIo,
): Promise<void> {
  await io.ghCommandFn([
    "api",
    `repos/${repo}/issues/comments/${commentId}`,
    "-X",
    "PATCH",
    "-f",
    `body=${body}`,
  ]);
}

/**
 * Delete marker comments that no longer record a live lease.
 *
 * Two shapes qualify: a holder whose lease has run out, and a duplicate of
 * this host's own marker left behind by a raced double-post — without the
 * second, "one marker per host" would decay into one comment per race.
 */
async function dropDeadMarkers(
  repo: string,
  expired: readonly LeaseEntry[],
  io: MaintenanceLeaseIo,
): Promise<void> {
  for (const entry of expired) {
    const error = await deleteIssueComment(
      repo,
      entry.commentId,
      io.ghCommandFn,
    );
    if (error !== null) {
      io.log(
        `maintenance-lease: could not delete the dead marker ` +
          `comment ${entry.commentId} in ${repo} — ${error.message}`,
      );
    }
  }
}

/**
 * Take or refresh `repo`'s maintenance lease for `host`.
 *
 * Every marker on the anchor is classified by `decideMaintenanceLease`, so the
 * store and the decision cannot disagree about which marker is this host's or
 * when a holder is dead:
 *
 * - **own** — the first is patched in place, so the anchor never grows a
 *   comment per cycle; any duplicate of it is deleted;
 * - **expired** — deleted, the holder is dead;
 * - **held elsewhere** — another host's lease is still fresh, so nothing is
 *   written and this returns false. Callers consult `decideMaintenanceLease`
 *   before refreshing, and this is the second layer: mutual exclusion does not
 *   rest on the caller getting it right.
 *
 * @param repo - Repository in "owner/repo" format
 * @param host - This host's machine id (`getMachineId`) or install uuid
 * @param nowSeconds - Current epoch seconds, stamped into the marker
 * @returns True when the marker was written; false when the lease is degraded
 *          or another host holds it
 */
export async function refreshMaintenanceLease(
  repo: string,
  host: string,
  nowSeconds: number,
  io: MaintenanceLeaseIo,
): Promise<boolean> {
  const anchor = await resolveAnchor(repo, io);
  if (anchor === null) return false;

  let entries: LeaseEntry[];
  try {
    entries = await readLeaseEntries(repo, anchor.issue, io);
  } catch (err) {
    degrade(io, `lease read failed for ${repo}: ${messageOf(err)}`);
    await healStaleAnchor(repo, anchor, err, io);
    return false;
  }

  let own: LeaseEntry | null = null;
  const dead: LeaseEntry[] = [];
  let heldElsewhere: string | null = null;
  for (const entry of entries) {
    const decision = decideMaintenanceLease({
      holder: entry.marker,
      thisHost: host,
      nowSeconds,
    });
    if (decision.reason === "own-lease") {
      // The first own marker is the one kept; a duplicate from a raced
      // double-post is dead weight and is deleted with the rest.
      if (own === null) own = entry;
      else dead.push(entry);
    } else if (decision.reason === "holder-expired") {
      dead.push(entry);
    } else {
      heldElsewhere = decision.holderHost ?? entry.marker.host;
    }
  }

  if (own === null && heldElsewhere !== null) {
    io.log(
      `maintenance-lease: ${repo} is held by ${heldElsewhere} — ` +
        `not taking it`,
    );
    return false;
  }

  // The marker records the bare install uuid when the host id carries one, so
  // this host still recognises its own lease after a relaunch renames it.
  const holderHost = installFromMachineId(host) ?? host;
  const body = buildLeaseCommentBody(repo, holderHost, nowSeconds);

  try {
    if (own === null) {
      await postLeaseComment(repo, anchor.issue, body, io);
    } else {
      await patchLeaseComment(repo, own.commentId, body, io);
    }
  } catch (err) {
    degrade(
      io,
      `lease ${own === null ? "publish" : "refresh"} failed for ${repo}: ${
        messageOf(err)
      }`,
    );
    await healStaleAnchor(repo, anchor, err, io);
    return false;
  }

  await dropDeadMarkers(repo, dead, io);
  return true;
}
