/** Persisted consecutive transient branch-refresh refusals (Issue #4831). */

import { withFileLock } from "./file_lock.ts";
import { atomicWrite } from "./file_utils.ts";
import {
  fetchMarkerComments,
  updateIssueComment,
} from "./marker_comment_pages.ts";

export const BRANCH_REFRESH_REFUSAL_FILE = ".branch_refresh_refusals_v1";
export const BRANCH_REFRESH_REFUSAL_MARKER =
  "<!-- vibe-branch-refresh-refusal-v1";
export const BRANCH_REFRESH_REFUSAL_THRESHOLD = 2;
export const BRANCH_REFRESH_REFUSAL_TTL_MS = 24 * 60 * 60 * 1000;

export type BranchRefreshTransientReason =
  | "mergeability-unknown"
  | "test-merge-parents-stale";

export interface BranchRefreshRefusalEntry {
  reason: BranchRefreshTransientReason;
  streak: number;
  lastSeenAtMs: number;
  notified: boolean;
}

export interface BranchRefreshRefusalEvent {
  repo: string;
  prNumber: number;
  entry: BranchRefreshRefusalEntry;
  active: boolean;
  /**
   * Which lane was refused. `refresh` (the default) is the strict-base branch
   * refresh; `repair` is a repair that could not decide its base merge because
   * mergeability is still UNKNOWN (Issue #4831, #4943). Both share one marker
   * per PR, so the latest write's wording is the one on the comment.
   */
  lane?: "refresh" | "repair";
}

export type BranchRefreshRefusalState = Map<string, BranchRefreshRefusalEntry>;

/** Post or update the single trusted diagnostic comment for a PR. */
export async function notifyBranchRefreshRefusal(
  event: BranchRefreshRefusalEvent,
  gh: (args: string[]) => Promise<string>,
  isTrustedAuthor: (login: string) => boolean,
): Promise<void> {
  const { repo, prNumber, entry, active, lane = "refresh" } = event;
  const marker =
    `${BRANCH_REFRESH_REFUSAL_MARKER} repo="${repo}" pr="${prNumber}" -->`;
  const reason = entry.reason === "mergeability-unknown"
    ? "GitHub has not finished calculating mergeability"
    : "GitHub's test-merge parents still lag the PR head or base";
  let body: string;
  if (lane === "repair") {
    body = active
      ? `${marker}\n### Repair is waiting on mergeability\n\nA repair of this PR could not decide whether to merge its base on ${entry.streak} consecutive passes because ${reason}. The worker will keep retrying.\n`
      : `${marker}\n### Repair mergeability recovered\n\nA repair of this PR is no longer waiting on mergeability; automatic recovery continues.\n`;
  } else {
    body = active
      ? `${marker}\n### Branch refresh is still waiting\n\nThe strict-base branch refresh has been refused on ${entry.streak} consecutive passes because ${reason}. The worker will keep retrying it.\n`
      : `${marker}\n### Branch refresh recovered\n\nThe strict-base branch refresh is no longer refused for ${reason}; automatic recovery continues.\n`;
  }
  const comments = await fetchMarkerComments(
    repo,
    prNumber,
    BRANCH_REFRESH_REFUSAL_MARKER,
    gh,
  );
  const own = comments.find((comment) =>
    comment.body.startsWith(marker) && typeof comment.author === "string" &&
    isTrustedAuthor(comment.author)
  );
  if (own) {
    await updateIssueComment(repo, own.id, body, gh);
  } else {
    await gh([
      "pr",
      "comment",
      String(prNumber),
      "--repo",
      repo,
      "--body",
      body,
    ]);
  }
}

export interface BranchRefreshRefusalIo {
  readTextFile(path: string): Promise<string>;
  writeTextFile(path: string, data: string): Promise<void>;
}

const productionIo: BranchRefreshRefusalIo = {
  readTextFile: (path) => Deno.readTextFile(path),
  writeTextFile: async (path, data) => {
    const result = await atomicWrite({ targetFile: path, content: data });
    if (!result.ok) throw result.error;
  },
};

export function branchRefreshRefusalKey(
  repo: string,
  prNumber: number,
): string {
  return `${repo}#${prNumber}`;
}

export function classifyTransientBranchRefreshRefusal(
  message: string,
): BranchRefreshTransientReason | undefined {
  if (
    message.includes("PR mergeability is still UNKNOWN") ||
    message.includes("PR test merge is still being computed")
  ) {
    return "mergeability-unknown";
  }
  if (
    message.includes("PR test merge parents do not match its head and base")
  ) {
    return "test-merge-parents-stale";
  }
  return undefined;
}

export function recordBranchRefreshRefusal(
  state: BranchRefreshRefusalState,
  repo: string,
  prNumber: number,
  reason: BranchRefreshTransientReason,
  nowMs = Date.now(),
): BranchRefreshRefusalEntry {
  const key = branchRefreshRefusalKey(repo, prNumber);
  const previous = state.get(key);
  // A mergeability read cannot prove that previously stale parents caught up.
  if (
    previous?.reason === "test-merge-parents-stale" &&
    reason === "mergeability-unknown"
  ) return previous;
  const consecutive = previous?.reason === reason &&
    nowMs - previous.lastSeenAtMs <= BRANCH_REFRESH_REFUSAL_TTL_MS;
  const entry: BranchRefreshRefusalEntry = {
    reason,
    streak: consecutive ? previous.streak + 1 : 1,
    lastSeenAtMs: nowMs,
    notified: consecutive && previous.notified,
  };
  state.set(key, entry);
  return entry;
}

export function clearBranchRefreshRefusal(
  state: BranchRefreshRefusalState,
  repo: string,
  prNumber: number,
): BranchRefreshRefusalEntry | undefined {
  const key = branchRefreshRefusalKey(repo, prNumber);
  const previous = state.get(key);
  state.delete(key);
  return previous;
}

export function parseBranchRefreshRefusals(
  raw: string,
  nowMs = Date.now(),
): BranchRefreshRefusalState {
  const state: BranchRefreshRefusalState = new Map();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return state;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return state;
  }
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      continue;
    }
    const entry = value as Record<string, unknown>;
    if (
      !/^[\w.-]+\/[\w.-]+#\d+$/.test(key) ||
      (entry.reason !== "mergeability-unknown" &&
        entry.reason !== "test-merge-parents-stale") ||
      !Number.isSafeInteger(entry.streak) || (entry.streak as number) < 1 ||
      typeof entry.lastSeenAtMs !== "number" ||
      !Number.isFinite(entry.lastSeenAtMs) ||
      nowMs - entry.lastSeenAtMs > BRANCH_REFRESH_REFUSAL_TTL_MS ||
      typeof entry.notified !== "boolean"
    ) continue;
    state.set(key, {
      reason: entry.reason,
      streak: entry.streak as number,
      lastSeenAtMs: entry.lastSeenAtMs,
      notified: entry.notified,
    });
  }
  return state;
}

export function serialiseBranchRefreshRefusals(
  state: BranchRefreshRefusalState,
  nowMs = Date.now(),
): string {
  const live = Object.fromEntries(
    [...state].filter(([, entry]) =>
      nowMs - entry.lastSeenAtMs <= BRANCH_REFRESH_REFUSAL_TTL_MS
    ),
  );
  return JSON.stringify(live);
}

export async function readBranchRefreshRefusals(
  workDir: string,
  io: BranchRefreshRefusalIo = productionIo,
  warn: (message: string) => void = console.warn,
): Promise<BranchRefreshRefusalState> {
  try {
    return parseBranchRefreshRefusals(
      await io.readTextFile(`${workDir}/${BRANCH_REFRESH_REFUSAL_FILE}`),
    );
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) {
      warn(
        `Could not read branch-refresh refusal state in ${workDir}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    return new Map();
  }
}

export async function writeBranchRefreshRefusals(
  workDir: string,
  state: BranchRefreshRefusalState,
  io: BranchRefreshRefusalIo = productionIo,
  warn: (message: string) => void = console.warn,
): Promise<void> {
  try {
    await io.writeTextFile(
      `${workDir}/${BRANCH_REFRESH_REFUSAL_FILE}`,
      serialiseBranchRefreshRefusals(state),
    );
  } catch (error) {
    warn(
      `Could not persist branch-refresh refusal state in ${workDir}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/** Serialise the complete refusal read-modify-write across repair and sweep writers. */
export async function updateBranchRefreshRefusals(
  workDir: string,
  update: (state: BranchRefreshRefusalState) => Promise<void>,
): Promise<void> {
  await Deno.mkdir(workDir, { recursive: true });
  await withFileLock(
    `${workDir}/${BRANCH_REFRESH_REFUSAL_FILE}.lock`,
    async () => {
      const state = await readBranchRefreshRefusals(workDir);
      await update(state);
      await writeBranchRefreshRefusals(workDir, state);
    },
  );
}

/** A diagnostic comment to post or edit once the refusal lock is released. */
export interface DeferredRefusalNotice {
  event: BranchRefreshRefusalEvent;
  /** Runs after the comment was posted or edited. */
  onPosted?: () => void;
  /** Runs when posting or editing the comment failed. */
  onFailed: (error: unknown) => void;
}

/**
 * Run a refusal read-modify-write, then post the comments it queued, with no
 * GitHub call inside the lock. `change` decides under the lock and queues each
 * comment through `defer`. Once the lock is released each comment is posted. An
 * active comment that went out is then recorded as `notified` in a second short
 * transaction, but only on an entry still holding the reason it was posted for.
 * A failed post leaves the entry un-notified, so the next pass retries it. If the
 * lock or the write fails the error reaches the caller before any comment goes
 * out; if only the second transaction fails, that error reaches the caller after
 * the comments have gone out.
 */
export async function updateRefusalsThenNotify(
  update: (
    change: (state: BranchRefreshRefusalState) => Promise<void>,
  ) => Promise<void>,
  notify: (event: BranchRefreshRefusalEvent) => Promise<void>,
  change: (
    state: BranchRefreshRefusalState,
    defer: (notice: DeferredRefusalNotice) => void,
  ) => Promise<void>,
): Promise<void> {
  const queued: DeferredRefusalNotice[] = [];
  await update((state) => change(state, (notice) => queued.push(notice)));
  const posted: BranchRefreshRefusalEvent[] = [];
  for (const notice of queued) {
    try {
      await notify(notice.event);
    } catch (error) {
      notice.onFailed(error);
      continue;
    }
    if (notice.event.active) posted.push(notice.event);
    notice.onPosted?.();
  }
  if (posted.length === 0) return;
  await update((state) => {
    for (const { repo, prNumber, entry } of posted) {
      const current = state.get(branchRefreshRefusalKey(repo, prNumber));
      if (current !== undefined && current.reason === entry.reason) {
        current.notified = true;
      }
    }
    return Promise.resolve();
  });
}
