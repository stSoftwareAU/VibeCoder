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
 * every call here is REST: `gh api` for the comment read, post, patch and
 * delete, and `gh issue list` / `gh issue create` for the anchor.
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
import { installFromMachineId } from "./stream_holder.ts";

/** Marker that identifies the anchor issue in its body. */
export const MAINTENANCE_LEASE_ANCHOR_MARKER_PREFIX =
  "vibe-maintenance-lease-anchor";

/** Title every anchor issue carries. */
export const MAINTENANCE_LEASE_ANCHOR_TITLE =
  "Vibe Coder maintenance lease — do not close";

/** How many search hits the anchor lookup considers. */
const ANCHOR_SEARCH_LIMIT = "20";

/**
 * A repository name the store will act on.
 *
 * Validated before it reaches an argv or a file path: `repo` arrives from
 * operator configuration, and an unchecked value would land in a `gh api`
 * endpoint and in the pin file's name.
 */
const REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

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
  /** Where the degraded line goes. */
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

/** `value` as a positive issue number, or null when it is not one. */
function positiveIssueNumber(value: string): number | null {
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

/** Is `login` one of the fleet authors the store trusts? */
function isTrustedAuthor(
  login: unknown,
  io: MaintenanceLeaseIo,
): boolean {
  return typeof login === "string" && io.trustedAuthors.includes(login);
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
  const raw = await io.ghCommandFn([
    "issue",
    "list",
    "--repo",
    repo,
    "--state",
    "open",
    "--search",
    `"${MAINTENANCE_LEASE_ANCHOR_MARKER_PREFIX} repo=${repo}" in:body`,
    "--json",
    "number,body,author",
    "--limit",
    ANCHOR_SEARCH_LIMIT,
  ]);
  const rows = JSON.parse(raw.trim() || "[]") as Array<{
    number?: unknown;
    body?: unknown;
    author?: { login?: unknown };
  }>;
  const marker = formatMaintenanceLeaseAnchorMarker(repo);
  const numbers = rows
    .filter((row) => typeof row.body === "string" && row.body.includes(marker))
    .filter((row) => isTrustedAuthor(row.author?.login, io))
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
    "issue",
    "create",
    "--repo",
    repo,
    "--title",
    MAINTENANCE_LEASE_ANCHOR_TITLE,
    "--body",
    buildAnchorBody(repo),
  ]);
  const match = /\/issues\/(\d+)\s*$/.exec(output.trim());
  return match?.[1] === undefined ? null : Number.parseInt(match[1], 10);
}

/**
 * Resolve the anchor issue for `repo` — override, pin, search, create.
 *
 * @returns The anchor issue number, or null when the lease is degraded
 */
export async function resolveMaintenanceLeaseAnchor(
  repo: string,
  io: MaintenanceLeaseIo,
): Promise<number | null> {
  if (!REPO_RE.test(repo)) {
    degrade(io, `'${repo}' is not an owner/repo repository name`);
    return null;
  }

  const override = positiveIssueNumber(
    getRepoConfig(io.repoConfigs, repo, "maintenanceLeaseIssue"),
  );
  if (override !== null) return override;

  const pinned = await readPinnedAnchor(repo, io);
  if (pinned !== null) return pinned;

  try {
    const found = await findAnchorIssue(repo, io);
    if (found !== null) {
      await pinAnchor(repo, found, io);
      return found;
    }
    const created = await createAnchorIssue(repo, io);
    if (created === null) {
      degrade(io, `the lease anchor issue in ${repo} could not be created`);
      return null;
    }
    await pinAnchor(repo, created, io);
    return created;
  } catch (err) {
    degrade(io, `anchor lookup failed for ${repo}: ${messageOf(err)}`);
    return null;
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
  const anchor = await resolveMaintenanceLeaseAnchor(repo, io);
  if (anchor === null) return null;

  try {
    const best = freshest(await readLeaseEntries(repo, anchor, io));
    if (best === null) return null;
    return { host: best.marker.host, atEpoch: best.marker.atEpoch };
  } catch (err) {
    degrade(io, `lease read failed for ${repo}: ${messageOf(err)}`);
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

/** Delete the markers of holders whose lease has run out. */
async function dropExpiredMarkers(
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
        `maintenance-lease: could not delete the expired marker ` +
          `comment ${entry.commentId} in ${repo} — ${error.message}`,
      );
    }
  }
}

/**
 * Take or refresh `repo`'s maintenance lease for `host`.
 *
 * The host's own marker is patched in place rather than re-posted, so the
 * anchor never grows a comment per cycle. Identity and expiry both come from
 * `decideMaintenanceLease`, so the store and the decision cannot disagree
 * about which marker is this host's or when a holder is dead.
 *
 * @param repo - Repository in "owner/repo" format
 * @param host - This host's machine id (`getMachineId`) or install uuid
 * @param nowSeconds - Current epoch seconds, stamped into the marker
 * @returns True when the marker was written, false when the lease is degraded
 */
export async function refreshMaintenanceLease(
  repo: string,
  host: string,
  nowSeconds: number,
  io: MaintenanceLeaseIo,
): Promise<boolean> {
  const anchor = await resolveMaintenanceLeaseAnchor(repo, io);
  if (anchor === null) return false;

  let entries: LeaseEntry[];
  try {
    entries = await readLeaseEntries(repo, anchor, io);
  } catch (err) {
    degrade(io, `lease read failed for ${repo}: ${messageOf(err)}`);
    return false;
  }

  let own: LeaseEntry | null = null;
  const expired: LeaseEntry[] = [];
  for (const entry of entries) {
    const decision = decideMaintenanceLease({
      holder: entry.marker,
      thisHost: host,
      nowSeconds,
    });
    if (decision.reason === "own-lease") own = entry;
    else if (decision.reason === "holder-expired") expired.push(entry);
  }

  // The marker records the bare install uuid when the host id carries one, so
  // this host still recognises its own lease after a relaunch renames it.
  const holderHost = installFromMachineId(host) ?? host;
  const body = buildLeaseCommentBody(repo, holderHost, nowSeconds);

  try {
    if (own === null) {
      await postLeaseComment(repo, anchor, body, io);
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
    return false;
  }

  await dropExpiredMarkers(repo, expired, io);
  return true;
}
