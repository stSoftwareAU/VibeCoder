/** Shared ownership for one branch refresh per repository/base (Issue #4613). */

import {
  type AlertDedupAuthorOptions,
  resolveAlertDedupAuthors,
  selectFleetAuthoredComments,
} from "./alert_dedup_authors.ts";
import {
  acquireBranchUpdateLock,
  parsePostedCommentId,
  releaseBranchUpdateLock,
} from "./pr_branch_lock.ts";
import { fetchMarkerComments } from "./marker_comment_pages.ts";
import { runGhCommand } from "./github.ts";

export interface BaseRefreshOwnerRecord {
  id: string;
  repo: string;
  base: string;
  prNumber: number;
  headSha: string;
  workerId: string;
  expiresAt: number;
}

export interface BaseRefreshOwnershipPort {
  now(): number;
  withBaseLock<T>(
    repo: string,
    base: string,
    fn: () => Promise<T>,
  ): Promise<T>;
  read(repo: string, base: string): Promise<BaseRefreshOwnerRecord[]>;
  write(
    record: Omit<BaseRefreshOwnerRecord, "id">,
  ): Promise<string>;
  remove(id: string): Promise<void>;
  /** Test clock seam; production ports omit it. */
  setNow?(value: number): void;
}

export type BaseRefreshStatus = "active" | "failed" | "merged" | "closed";

export interface GitHubBaseRefreshOwnershipOptions {
  workerId: string;
  ghCommandFn?: (args: string[]) => Promise<string>;
  anchorPrForBase: (repo: string, base: string) => Promise<number>;
  authorOptions?: AlertDedupAuthorOptions;
  log?: (message: string) => void;
  sleepFn?: (ms: number) => Promise<void>;
}

const BASE_REFRESH_OWNER_PREFIX = "<!-- BASE_REFRESH_OWNER_4613:";

function parseOwner(body: string): Omit<BaseRefreshOwnerRecord, "id"> | null {
  const match =
    /^<!-- BASE_REFRESH_OWNER_4613:([^:]+):([^:]+):(\d+):([a-f0-9]{40}):([^:]+):(\d+) -->$/i
      .exec(
        body.trim(),
      );
  if (!match) return null;
  try {
    const repo = decodeURIComponent(match[1]!);
    const base = decodeURIComponent(match[2]!);
    const prNumber = Number(match[3]);
    const workerId = decodeURIComponent(match[5]!);
    const expiresAt = Number(match[6]);
    if (
      !Number.isSafeInteger(prNumber) || prNumber <= 0 ||
      !Number.isSafeInteger(expiresAt)
    ) return null;
    return { repo, base, prNumber, headSha: match[4]!, workerId, expiresAt };
  } catch {
    return null;
  }
}

/**
 * GitHub comment-backed store, serialised by the existing distributed PR lock.
 * The oldest repository PR is a stable comment anchor, including after close;
 * the comment record itself is still keyed by repository and base.
 */
export function makeGitHubBaseRefreshOwnershipPort(
  options: GitHubBaseRefreshOwnershipOptions,
): BaseRefreshOwnershipPort {
  const gh = options.ghCommandFn ?? runGhCommand;
  const log = options.log ?? ((message: string) => console.warn(message));
  const fleet = resolveAlertDedupAuthors(options.authorOptions ?? {}, log);
  const verifiedAuthors = async () => {
    const fleetAuthors = await fleet;
    if (fleetAuthors.length === 0) {
      const message =
        "base refresh fleet author set unresolved; no refresh is issued";
      log(message);
      throw new Error(message);
    }
    return { fleetAuthors };
  };
  const anchors = new Map<string, number>();
  const ownerCommentRepos = new Map<string, string>();
  const anchor = async (repo: string, base: string) => {
    const key = `${repo}\0${base}`;
    let value = anchors.get(key);
    if (value === undefined) {
      value = await options.anchorPrForBase(repo, base);
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`No open PR anchor for ${repo} base ${base}`);
      }
      anchors.set(key, value);
    }
    return value;
  };
  const withBaseLock = async <T>(
    repo: string,
    base: string,
    fn: () => Promise<T>,
  ) => {
    const authorOptions = await verifiedAuthors();
    const prNumber = await anchor(repo, base);
    const lock = await acquireBranchUpdateLock({
      repo,
      prNumber,
      workerId: options.workerId,
      lockTtlSeconds: 60,
      ghCommandFn: gh,
      ...(options.sleepFn ? { sleepFn: options.sleepFn } : {}),
      log,
      note: `Serialising branch refresh ownership for ${base}.`,
      authorOptions,
    });
    if (
      !lock.ok || !lock.value.acquired || lock.value.lockCommentId === undefined
    ) {
      const message =
        `Could not acquire shared refresh lock for ${repo} base ${base}`;
      log(
        `${message}; winner ${
          lock.ok ? lock.value.winnerId ?? "unknown" : lock.error.message
        }`,
      );
      throw new Error(message);
    }
    try {
      return await fn();
    } finally {
      await releaseBranchUpdateLock({
        repo,
        prNumber,
        lockCommentId: lock.value.lockCommentId,
        ghCommandFn: gh,
      });
    }
  };
  return {
    now: () => Math.floor(Date.now() / 1000),
    withBaseLock,
    read: async (repo, base) => {
      const prNumbers = [await anchor(repo, base)];
      const rows = (await Promise.all(
        prNumbers.map((prNumber) =>
          fetchMarkerComments(repo, prNumber, BASE_REFRESH_OWNER_PREFIX, gh)
        ),
      )).flat();
      const fleetRows = await selectFleetAuthoredComments(
        rows,
        `base refresh ownership ${repo} ${base}`,
        await verifiedAuthors(),
        log,
        "unverified ownership is ignored and no refresh is issued",
      );
      return fleetRows.flatMap((row) => {
        const parsed = parseOwner(row.body);
        return parsed?.repo === repo && parsed.base === base
          ? (ownerCommentRepos.set(String(row.id), repo),
            [{ ...parsed, id: String(row.id) }])
          : [];
      });
    },
    write: async (record) => {
      const body = `${BASE_REFRESH_OWNER_PREFIX}${
        encodeURIComponent(record.repo)
      }:${
        encodeURIComponent(record.base)
      }:${record.prNumber}:${record.headSha}:${
        encodeURIComponent(record.workerId)
      }:${record.expiresAt} -->`;
      const output = await gh([
        "issue",
        "comment",
        String(await anchor(record.repo, record.base)),
        "--repo",
        record.repo,
        "--body",
        body,
      ]);
      const id = parsePostedCommentId(output);
      if (id === null) {
        throw new Error("GitHub did not identify the refresh owner comment");
      }
      ownerCommentRepos.set(String(id), record.repo);
      return String(id);
    },
    remove: async (id) => {
      if (!/^\d+$/.test(id)) {
        throw new Error("Invalid refresh owner comment id");
      }
      const repo = ownerCommentRepos.get(id);
      if (!repo) {
        throw new Error("Refresh owner comment has no repository provenance");
      }
      await gh(["api", "-X", "DELETE", `repos/${repo}/issues/comments/${id}`]);
    },
  };
}

export type BaseRefreshAcquireResult =
  | { acquired: true; ownerId: string }
  | {
    acquired: false;
    reason: "owned";
    ownerPrNumber: number;
    ownerWorkerId: string;
  };

/** Claim the base while holding the shared lock that serialises competing lanes. */
export async function acquireBaseRefreshOwner(
  port: BaseRefreshOwnershipPort,
  input: {
    repo: string;
    base: string;
    prNumber: number;
    headSha: string;
    workerId: string;
    ttlSeconds: number;
  },
): Promise<BaseRefreshAcquireResult> {
  if (
    !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(input.repo) ||
    !/^[A-Za-z0-9._/-]+$/.test(input.base) ||
    input.base.split("/").includes("..") ||
    !Number.isSafeInteger(input.prNumber) || input.prNumber <= 0 ||
    !/^[a-f0-9]{40}$/i.test(input.headSha) || !input.workerId ||
    !Number.isSafeInteger(input.ttlSeconds) || input.ttlSeconds <= 0
  ) throw new Error("Invalid base refresh ownership input");

  return await port.withBaseLock(input.repo, input.base, async () => {
    const records = await port.read(input.repo, input.base);
    const now = port.now();
    for (const record of records) {
      if (record.expiresAt <= now) await port.remove(record.id);
    }
    const active = records.find((record) => record.expiresAt > now);
    if (active) {
      return {
        acquired: false,
        reason: "owned",
        ownerPrNumber: active.prNumber,
        ownerWorkerId: active.workerId,
      };
    }
    const ownerId = await port.write({
      repo: input.repo,
      base: input.base,
      prNumber: input.prNumber,
      headSha: input.headSha,
      workerId: input.workerId,
      expiresAt: now + input.ttlSeconds,
    });
    return { acquired: true, ownerId };
  });
}

/** Release an owner only when its PR has reached a terminal refresh outcome. */
export async function reconcileBaseRefreshOwner(
  port: BaseRefreshOwnershipPort,
  repo: string,
  base: string,
  readStatus: (
    owner: BaseRefreshOwnerRecord,
  ) => Promise<BaseRefreshStatus> | BaseRefreshStatus,
): Promise<{ released: boolean; reason?: string }> {
  return await port.withBaseLock(repo, base, async () => {
    const records = await port.read(repo, base);
    const now = port.now();
    let released = false;
    let reason: string | undefined;
    for (const owner of records) {
      // Re-read before takeover; an unreadable state retains ownership until
      // the bounded expiry. Callers convert read failures to "active".
      const status = await readStatus(owner);
      if (status === "merged" || status === "closed" || status === "failed") {
        await port.remove(owner.id);
        released = true;
        reason = status;
      } else if (owner.expiresAt <= now) {
        await port.remove(owner.id);
        released = true;
        reason = "expired";
      }
    }
    return released ? { released: true, reason } : { released: false };
  });
}

export async function releaseBaseRefreshOwner(
  port: BaseRefreshOwnershipPort,
  repo: string,
  base: string,
  ownerId: string,
): Promise<void> {
  await port.withBaseLock(repo, base, async () => {
    const owners = await port.read(repo, base);
    if (owners.some((owner) => owner.id === ownerId)) {
      await port.remove(ownerId);
    }
  });
}
