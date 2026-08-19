/**
 * Content approval tracker for work-on label TOCTOU protection (Issue #1341).
 *
 * When the `work-on` label is verified as added by an allowed author, a
 * SHA-256 hash of the issue title + body is captured. Before processing
 * begins, the current content is compared against the stored hash. If the
 * content has been modified by an untrusted author after approval, the
 * worker blocks processing, removes the label, and posts a comment.
 *
 * Follows the state-persistence pattern from failure_tracker.ts:
 * atomic write-to-tmp-then-rename, mode 0o600, JSON storage.
 *
 * The state lives in a store directory *outside* the agent-writable `workDir`
 * (Issue #3717) — see `content_approval_state_dir.ts`. Every entry point takes
 * that store directory, never `workDir`.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Result } from "../types.ts";
import { atomicWrite } from "./file_utils.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Stored snapshot of issue content at the time of work-on approval. */
export interface ContentSnapshot {
  /** SHA-256 hex digest of the length-prefixed title and body (Issue #3878). */
  contentHash: string;
  /** Unix timestamp when the snapshot was captured. */
  capturedAt: number;
  /** The issue author at capture time (for trusted/untrusted classification). */
  issueAuthor: string;
  /**
   * Encoding the digest was computed under (Issue #3963).
   *
   * A digest means nothing without it: the #3878 encoding change invalidated
   * every stored digest at once precisely because none of them said which
   * encoding they belonged to. Absent on snapshots written before this stamp
   * existed — see {@link candidateEncodings}.
   */
  encoding?: string;
}

/** All stored snapshots, keyed by "repo|issueNumber". */
export interface ContentApprovalState {
  snapshots: Record<string, ContentSnapshot>;
}

/** Result of a content verification check. */
export type ContentVerificationResult =
  | {
    status: "unchanged";
    /**
     * The encoding the digest actually verified under, present only when the
     * snapshot needs re-baselining (Issue #3963): its stored encoding is
     * older than the current one, or it carries no encoding stamp at all.
     * The content is verified unchanged either way — the caller re-captures
     * so the *next* verification compares under the current encoding.
     */
    staleEncoding?: string;
  }
  | { status: "changed"; issueAuthor: string; capturedAt: number }
  | { status: "no_snapshot" }
  | { status: "error"; message: string };

/** Injectable dependencies for testability. */
export interface ContentApprovalDeps {
  /** Function to read a file. Defaults to Deno.readTextFile. */
  readFile?: (path: string) => Promise<string>;
  /** Function to write a file. Defaults to Deno.writeTextFile. */
  writeFile?: (
    path: string,
    content: string,
    options?: Deno.WriteFileOptions,
  ) => Promise<void>;
  /** Function to rename a file. Defaults to Deno.rename. */
  renameFile?: (oldPath: string, newPath: string) => Promise<void>;
  /** Function to remove a file. Defaults to Deno.remove. */
  removeFile?: (path: string) => Promise<void>;
  /**
   * Whether the state *store directory* exists (Issue #3717).
   *
   * An initialised store with no state file inside it means the baseline was
   * deleted, not that it was never written. Defaults to a `Deno.stat` check,
   * or to "not initialised" when `readFile` is injected — an injected read
   * layer has replaced the filesystem the real check would interrogate.
   */
  stateDirExists?: (path: string) => Promise<boolean>;
  /**
   * Create the state store directory. Defaults to `Deno.mkdir` with mode
   * 0o700. Only consulted on the injected-write path; the real filesystem
   * path always creates the directory itself.
   */
  makeStateDir?: (path: string) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STATE_FILENAME = ".content_approval_state.json";

/**
 * Sidecar that receives snapshots captured while the primary state file is
 * unusable (Issue #3875). The primary file is never rewritten from a state
 * that could not be read, so the snapshot has to land somewhere an operator
 * can find it — and its presence on disk is the audit trail that the
 * non-destructive path ran.
 */
const RECOVERY_FILENAME = ".content_approval_state.recovered.json";

/**
 * Durable record that a baseline once existed (Issue #4215). #3717 inferred
 * initialisation from the store directory's existence, which the
 * named-volume migration (#4203) broke: the store is now a mountpoint that
 * always exists (ext4 `lost+found` included), so a fresh host read as
 * "initialised store, state deleted" and every claim blocked. The marker is
 * written beside the state on every successful persist; deleting the state
 * file while it survives is still the loud fail-closed tamper fault.
 */
const STORE_MARKER_FILENAME = ".store_initialised";

/** Maximum age for snapshots before cleanup (7 days). */
const SNAPSHOT_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

/**
 * The pre-#3878 encoding: `sha256(title + "\n" + body)`.
 *
 * Retained only so a snapshot captured under it can still be *verified*
 * (Issue #3963). It is not injective — `("A", "B\nC")` and `("A\nB", "C")`
 * collide — so nothing is ever captured under it.
 */
export const CONTENT_HASH_ENCODING_V1 = "content-approval/v1";

/** The length-prefixed encoding introduced by Issue #3878. */
export const CONTENT_HASH_ENCODING_V2 = "content-approval/v2";

/**
 * Encoding new snapshots are captured under (Issues #3878, #3963).
 *
 * Bumping this no longer invalidates the store: every snapshot records the
 * encoding it was hashed under, verification re-checks under *that* encoding,
 * and a match re-baselines the snapshot under the new one. Add the outgoing
 * tag to {@link computeContentHash} when bumping, or every existing snapshot
 * becomes unverifiable.
 */
export const CURRENT_CONTENT_HASH_ENCODING = CONTENT_HASH_ENCODING_V2;

/** Encodings a stored digest may legitimately have been computed under. */
const KNOWN_HASH_ENCODINGS: readonly string[] = [
  CONTENT_HASH_ENCODING_V2,
  CONTENT_HASH_ENCODING_V1,
];

/**
 * Compute a SHA-256 hex digest of the issue title and body (Issue #3878).
 *
 * The two fields are encoded with an explicit byte-length prefix rather than
 * concatenated with a newline. Raw `${title}\n${body}` is not injective: any
 * pair that concatenates to the same string collides, so `("A", "B\nC")` and
 * `("A\nB", "C")` hashed identically and an approved body's first line could
 * be promoted into the title without disturbing the digest. Length-prefixing
 * makes the field boundary part of what is signed.
 *
 * ## Snapshot scope — why labels and comments are out
 *
 * The snapshot deliberately covers the title and body only. Both change only
 * by an issue edit, which GitHub attributes to an actor, so a change is
 * decidable against the trusted-author list. Labels and comments change
 * constantly through normal operation — the worker posts its own comments and
 * moves its own labels — so folding them in would block practically every
 * approved issue on the workflow's own activity, and the gate would be turned
 * off rather than tightened. Their own controls cover those paths instead:
 *
 * - **Comments** reach the prompt trust-annotated per author and wrapped in
 *   per-run nonce boundaries (`comment_trust_filter.ts`, Issues #1340,
 *   #3638), size- and count-capped (`comment_rate_limiter.ts`, Issue #1342,
 *   and `capFormattedComments`, Issue #3648), and can be excluded outright
 *   with `include_untrusted_comments: false`.
 * - **Labels** drive routing, but an approval label only counts when the
 *   timeline shows a *trusted* author added it (`getLabelLastAddInfo` in
 *   `work_on_content_integrity.ts`), and `label_security` strips reserved
 *   workflow labels added by anyone else (Issue #1344).
 *
 * Uses Deno's built-in Web Crypto API — deterministic and dependency-free.
 *
 * @param title - Issue title
 * @param body - Issue body
 * @param encoding - Encoding to hash under; defaults to the current one.
 *                   Only a stored snapshot's own tag should ever select an
 *                   older encoding (Issue #3963).
 * @returns Lowercase 64-character hex SHA-256 digest
 */
export async function computeContentHash(
  title: string,
  body: string,
  encoding: string = CURRENT_CONTENT_HASH_ENCODING,
): Promise<string> {
  const encoder = new TextEncoder();

  // Issue #3963: the superseded encoding stays computable so a snapshot
  // captured under it can be verified rather than declared modified.
  if (encoding === CONTENT_HASH_ENCODING_V1) {
    return await sha256Hex(encoder.encode(`${title}\n${body}`));
  }

  const titleBytes = encoder.encode(title);
  const bodyBytes = encoder.encode(body);
  const header = encoder.encode(
    `${CONTENT_HASH_ENCODING_V2}\n` +
      `title:${titleBytes.length}\n` +
      `body:${bodyBytes.length}\n`,
  );

  const encoded = new Uint8Array(
    header.length + titleBytes.length + bodyBytes.length,
  );
  encoded.set(header, 0);
  encoded.set(titleBytes, header.length);
  encoded.set(bodyBytes, header.length + titleBytes.length);

  return await sha256Hex(encoded);
}

/** SHA-256 of the given bytes as lowercase hex. */
async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Encodings a stored snapshot may legitimately have been hashed under
 * (Issue #3963).
 *
 * An unstamped snapshot pre-dates the stamp, so it is either encoding — both
 * are tried, and either match proves the content equals what was hashed at
 * approval, since both cover the same title and body. Any *stamped* snapshot
 * is checked under exactly its own tag; an unrecognised tag (a store written
 * by a newer worker) is a fault, not a modification.
 */
function candidateEncodings(snapshot: ContentSnapshot): Result<string[]> {
  const stamped = snapshot.encoding;
  if (stamped === undefined) {
    return { ok: true, value: [...KNOWN_HASH_ENCODINGS] };
  }
  if (KNOWN_HASH_ENCODINGS.includes(stamped)) {
    return { ok: true, value: [stamped] };
  }
  return {
    ok: false,
    error: new Error(
      `Unknown content hash encoding "${stamped}" on the approval snapshot: ` +
        `this worker can verify ${KNOWN_HASH_ENCODINGS.join(", ")} only, so ` +
        `the baseline cannot be checked (a store written by a newer worker?)`,
    ),
  };
}

// ---------------------------------------------------------------------------
// State persistence
// ---------------------------------------------------------------------------

function statePath(stateDir: string): string {
  return `${stateDir}/${STATE_FILENAME}`;
}

function recoveryPath(stateDir: string): string {
  return `${stateDir}/${RECOVERY_FILENAME}`;
}

function markerPath(stateDir: string): string {
  return `${stateDir}/${STORE_MARKER_FILENAME}`;
}

/**
 * Stores whose state was found unusable during this worker run (Issue #3875).
 *
 * A run is one worker process, so the condition is sticky for the cycle and
 * clears when the next process starts. Once a store has failed to read, a
 * later `no_snapshot` from that same store cannot be trusted as a genuine
 * first encounter — the baseline may simply have been destroyed — so the
 * verification fails closed instead of blessing the content in hand.
 */
const unusableStores = new Set<string>();

/** Whether `stateDir` has already failed to read during this run. */
export function isContentStateUnusable(stateDir: string): boolean {
  return unusableStores.has(stateDir);
}

/**
 * Clear the sticky "unusable this run" condition.
 *
 * Test support: a real run gets a fresh process (and so a fresh set) for
 * every cycle, but tests share one module instance.
 */
export function resetContentApprovalRunState(): void {
  unusableStores.clear();
}

/**
 * Default initialised-store probe (Issue #4215): the explicit marker, or —
 * for stores that predate it — the state file itself. The directory's own
 * existence stopped being evidence when the store became a volume
 * mountpoint (#4203): a mountpoint always exists, `lost+found` and all.
 */
async function defaultStateDirExists(path: string): Promise<boolean> {
  for (const candidate of [markerPath(path), `${path}/${STATE_FILENAME}`]) {
    try {
      if ((await Deno.stat(candidate)).isFile) return true;
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) throw err;
    }
  }
  return false;
}

/**
 * Whether the store has ever been initialised (Issue #3717).
 *
 * The store directory is created only as part of a successful write, so its
 * presence is the durable record that a baseline once existed. A probe that
 * cannot answer is a fault, not a "no".
 */
async function stateStoreInitialised(
  stateDir: string,
  deps: ContentApprovalDeps,
): Promise<Result<boolean>> {
  // A caller that injects its own read layer has replaced the filesystem, so
  // a real `Deno.stat` would answer about a directory the injected store
  // knows nothing about. Such callers declare store presence explicitly.
  const exists = deps.stateDirExists ??
    (deps.readFile ? () => Promise.resolve(false) : defaultStateDirExists);
  try {
    return { ok: true, value: await exists(stateDir) };
  } catch (err) {
    return {
      ok: false,
      error: new Error(
        `Could not determine whether the content approval store ${stateDir} ` +
          `exists: ${err instanceof Error ? err.message : String(err)}`,
      ),
    };
  }
}

/**
 * The fault raised when no store directory resolves (Issue #3874).
 *
 * `resolveContentApprovalStateDir` returns `""` when `workDir` names no
 * directory. Both halves of the store used to degenerate quietly on that
 * sentinel — the read reported an empty state, the write did nothing — so the
 * TOCTOU gate was disarmed while every issue looked like a first encounter.
 */
function unconfiguredStoreError(): Error {
  return new Error(
    "Content approval store is not configured: workDir resolves to no store " +
      "directory, so no approval baseline can be read or written. Set the " +
      "worker's workDir to an absolute path.",
  );
}

function snapshotKey(repo: string, issueNumber: number): string {
  return `${repo}|${issueNumber}`;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Read the content approval state, distinguishing "no state yet" from
 * "state exists but is unusable" (Issues #3649, #3651, #3717).
 *
 * Only an absent file in a store that was *never initialised* is the ordinary
 * first-encounter case and yields an empty state. Every other failure —
 * a read that fails (permission denied, I/O fault, a directory in its
 * place), a file that reads back but whose contents are not valid state, or a
 * file that has been deleted from an initialised store — is a fault: the
 * approval baseline for every tracked issue is unusable, so the caller must be
 * able to fail closed rather than treat it as "no snapshot → proceed".
 *
 * @returns `{ ok: true }` with the state, or `{ ok: false }` with the reason
 */
export async function readContentApprovalState(
  stateDir: string,
  deps: ContentApprovalDeps = {},
): Promise<Result<ContentApprovalState>> {
  const result = await readStateFile(stateDir, deps);
  // Issue #3875: remember the fault for the rest of the run so a later
  // `no_snapshot` from this store is not mistaken for a first encounter.
  if (!result.ok) unusableStores.add(stateDir);
  return result;
}

async function readStateFile(
  stateDir: string,
  deps: ContentApprovalDeps,
): Promise<Result<ContentApprovalState>> {
  // Issue #3874: no store configured is a configuration fault, not a
  // successful read of an empty store. Reporting it as `{ ok: true }` made it
  // indistinguishable from a legitimate first encounter.
  if (!stateDir) return { ok: false, error: unconfiguredStoreError() };

  const readFile = deps.readFile ?? Deno.readTextFile;
  const path = statePath(stateDir);

  let content: string;
  try {
    content = await readFile(path);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      // Issue #3717: the file is gone. That is a first run only if the store
      // itself was never created; the store directory is created solely as
      // part of a successful write, so its presence means a baseline once
      // existed and something removed it.
      const initialised = await stateStoreInitialised(stateDir, deps);
      if (!initialised.ok) return { ok: false, error: initialised.error };
      if (!initialised.value) {
        return { ok: true, value: { snapshots: {} } };
      }
      return {
        ok: false,
        error: new Error(
          `Content approval state deleted: ${path} is missing from the ` +
            `initialised store ${stateDir}. Remove the store directory to ` +
            `reset the approval baseline if this was intentional.`,
        ),
      };
    }
    // Issue #3651: the file is there but we cannot read it. Reporting that
    // as "no snapshots" would disarm the TOCTOU gate for every issue.
    return {
      ok: false,
      error: new Error(
        `Unreadable content approval state at ${path}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      ),
    };
  }

  let parsed: ContentApprovalState;
  try {
    parsed = JSON.parse(content) as ContentApprovalState;
  } catch (err) {
    return {
      ok: false,
      error: new Error(
        `Corrupt content approval state at ${path}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      ),
    };
  }

  if (
    !parsed || typeof parsed !== "object" ||
    !parsed.snapshots || typeof parsed.snapshots !== "object"
  ) {
    return {
      ok: false,
      error: new Error(
        `Corrupt content approval state at ${path}: missing snapshots map`,
      ),
    };
  }

  return { ok: true, value: parsed };
}

/**
 * A state loaded for a subsequent write (Issue #3875).
 *
 * `unusable` carries the read fault when the on-disk state could not be
 * loaded. The accompanying `state` is empty, so persisting it would replace
 * every other issue's baseline with the one entry the caller is adding — the
 * caller must divert instead of writing.
 */
interface StateForWrite {
  state: ContentApprovalState;
  unusable?: Error;
}

/**
 * Load the state a write is about to be derived from (Issue #3875).
 *
 * Issue #3651 made the degradation loud; the destruction it warned about was
 * still carried out by the caller. Every write path now goes through this
 * helper so an unusable read can be refused rather than laundered into a
 * one-entry map that overwrites the file.
 */
async function loadStateForWrite(
  stateDir: string,
  deps: ContentApprovalDeps,
): Promise<StateForWrite> {
  // Issue #3874: an unconfigured store gets its own marker — the store is not
  // unusable, it does not exist, and the subsequent write will fail too.
  if (!stateDir) {
    const error = unconfiguredStoreError();
    console.error(`[SECURITY] [CONTENT_STORE_UNCONFIGURED] ${error.message}`);
    return { state: { snapshots: {} }, unusable: error };
  }

  const result = await readContentApprovalState(stateDir, deps);
  if (result.ok) return { state: result.value };

  console.error(
    `[SECURITY] [CONTENT_STATE_UNUSABLE] ${result.error.message} — ` +
      `the file is left untouched rather than overwritten with a partial map, ` +
      `so every other issue's baseline survives; the content-integrity gate ` +
      `fails closed for this store until the fault is cleared`,
  );
  return { state: { snapshots: {} }, unusable: result.error };
}

/**
 * Load the content approval state from disk, tolerating a read failure.
 *
 * Returns an empty state if the file is missing, unreadable or corrupted, and
 * logs the degradation loudly (Issue #3651).
 *
 * Read-only callers only. Issue #3875: a write must never be derived from this
 * result — an empty state persisted over an unusable file erases every other
 * issue's baseline. Write paths use `loadStateForWrite`; verification uses
 * {@link readContentApprovalState} so it can fail closed.
 */
export async function loadContentApprovalState(
  stateDir: string,
  deps: ContentApprovalDeps = {},
): Promise<ContentApprovalState> {
  const loaded = await loadStateForWrite(stateDir, deps);
  return loaded.state;
}

/**
 * Persist the content approval state to disk atomically.
 *
 * On the real filesystem this delegates to the hardened `atomicWrite`, whose
 * temp path carries a kernel-random suffix and is opened with `createNew`, so
 * a symlink pre-positioned at a guessable path is never followed (Issue
 * #3682). Tests that inject an in-memory filesystem via `deps` keep the
 * write → rename → cleanup shape.
 */
export async function saveContentApprovalState(
  stateDir: string,
  state: ContentApprovalState,
  deps: ContentApprovalDeps = {},
): Promise<Result<void>> {
  // Issue #3874: a write with nowhere to go is a fault, not a success. The
  // no-op return let a whole run believe its baseline had been persisted.
  if (!stateDir) return { ok: false, error: unconfiguredStoreError() };

  return await writeStateToPath(stateDir, statePath(stateDir), state, deps);
}

/**
 * Atomically write a state map to a chosen path inside the store.
 *
 * Shared by the primary baseline write and the recovery sidecar (Issue
 * #3875), so both get the same hardened temp-file handling.
 */
async function writeStateToPath(
  stateDir: string,
  path: string,
  state: ContentApprovalState,
  deps: ContentApprovalDeps,
): Promise<Result<void>> {
  const content = JSON.stringify(state, null, 2);

  if (!deps.writeFile) {
    // Issue #3717: the store lives outside `workDir`, so it may not exist yet
    // and `atomicWrite` needs its target directory in place. Mode 0o700 keeps
    // the baseline private to the worker's own user.
    try {
      await Deno.mkdir(stateDir, { recursive: true, mode: 0o700 });
    } catch (err) {
      return {
        ok: false,
        error: new Error(
          `Failed to create content approval store ${stateDir}: ${err}`,
        ),
      };
    }

    const result = await atomicWrite({ targetFile: path, content });
    if (result.ok) {
      // The durable initialisation record (Issue #4215). Written after the
      // state so a marker never exists without a baseline having existed;
      // failure is loud — a store whose tamper protection silently never
      // arms is precisely what this file exists to prevent.
      try {
        await Deno.writeTextFile(
          markerPath(stateDir),
          "content-approval store initialised (Issue #4215) — the tamper " +
            "gate fails closed while this marker outlives the state file\n",
          { mode: 0o600 },
        );
      } catch (err) {
        return {
          ok: false,
          error: new Error(
            `State written but the initialisation marker could not be ` +
              `persisted: ${err instanceof Error ? err.message : String(err)}`,
          ),
        };
      }
      return result;
    }
    // Leave no empty store behind: an initialised store with no state file
    // reads as a deletion and would block every issue until an operator
    // intervened. `remove` without `recursive` only succeeds when the
    // directory is genuinely empty, so an existing baseline is never touched.
    await Deno.remove(stateDir).catch(() => {});
    return {
      ok: false,
      error: new Error(
        `Failed to persist content approval state: ${result.error.message}`,
      ),
    };
  }

  if (deps.makeStateDir) await deps.makeStateDir(stateDir);

  const renameFile = deps.renameFile ?? Deno.rename;
  const removeFile = deps.removeFile ?? Deno.remove;
  const tmp = `${path}.tmp.${crypto.randomUUID()}`;

  try {
    await deps.writeFile(tmp, content, { mode: 0o600 });
    await renameFile(tmp, path);
    return { ok: true, value: undefined };
  } catch (err) {
    try {
      await removeFile(tmp);
    } catch { /* ignore cleanup failure */ }
    return {
      ok: false,
      error: new Error(`Failed to persist content approval state: ${err}`),
    };
  }
}

/**
 * Read the recovery sidecar, tolerating any fault (Issue #3875).
 *
 * The sidecar holds diagnostics, never an approval baseline, so a sidecar
 * that cannot be read is started afresh rather than propagated — the caller
 * is already returning a failure for the capture itself.
 */
async function loadRecoverySidecar(
  stateDir: string,
  deps: ContentApprovalDeps,
): Promise<ContentApprovalState> {
  const readFile = deps.readFile ?? Deno.readTextFile;
  try {
    const parsed = JSON.parse(
      await readFile(recoveryPath(stateDir)),
    ) as ContentApprovalState;
    if (parsed?.snapshots && typeof parsed.snapshots === "object") {
      return parsed;
    }
  } catch { /* absent, unreadable or malformed — start a fresh sidecar */ }
  return { snapshots: {} };
}

/**
 * Divert a snapshot that cannot be persisted to the primary file (Issue #3875).
 *
 * The unreadable file is left exactly where it is: a read fault may be
 * transient (EMFILE, a momentary I/O error) and the bytes on disk are often
 * the only surviving copy of every other issue's baseline, so neither
 * overwriting nor renaming it is safe. The snapshot goes to the recovery
 * sidecar instead, and the capture is reported as the failure it is so the
 * gate fails closed rather than proceeding on a baseline that was never
 * written.
 */
async function divertSnapshotToRecovery(
  stateDir: string,
  key: string,
  snapshot: ContentSnapshot,
  cause: Error,
  deps: ContentApprovalDeps,
): Promise<Result<void>> {
  if (!stateDir) return { ok: false, error: cause };

  const sidecar = await loadRecoverySidecar(stateDir, deps);
  sidecar.snapshots[key] = snapshot;
  const written = await writeStateToPath(
    stateDir,
    recoveryPath(stateDir),
    sidecar,
    deps,
  );
  const outcome = written.ok
    ? `was recorded in ${recoveryPath(stateDir)} instead`
    : `could not even be recorded in ${
      recoveryPath(stateDir)
    }: ${written.error.message}`;

  return {
    ok: false,
    error: new Error(
      `Content approval state at ${statePath(stateDir)} is unusable ` +
        `(${cause.message}). It has been left untouched rather than ` +
        `overwritten with a one-entry map, so the snapshot for ${key} ` +
        `${outcome}. Repair or remove the store to re-baseline.`,
    ),
  };
}

// ---------------------------------------------------------------------------
// Core operations
// ---------------------------------------------------------------------------

/**
 * Capture a content snapshot when work-on label verification succeeds.
 *
 * Records the SHA-256 hash of the issue title + body, along with the
 * issue author, at the point of approval.
 *
 * @param stateDir - Approval-state store (see `content_approval_state_dir.ts`)
 * @param repo - Repository in "owner/repo" format
 * @param issueNumber - Issue number
 * @param title - Issue title at time of approval
 * @param body - Issue body at time of approval
 * @param issueAuthor - Issue author's GitHub username
 * @param deps - Optional dependency overrides for testing
 * @returns Result indicating success or failure
 */
export async function captureContentSnapshot(
  stateDir: string,
  repo: string,
  issueNumber: number,
  title: string,
  body: string,
  issueAuthor: string,
  deps: ContentApprovalDeps = {},
): Promise<Result<void>> {
  const contentHash = await computeContentHash(title, body);
  const key = snapshotKey(repo, issueNumber);
  const snapshot: ContentSnapshot = {
    contentHash,
    capturedAt: nowSeconds(),
    issueAuthor,
    // Issue #3963: stamp the encoding so a later bump can re-verify this
    // digest instead of writing it off as a content change.
    encoding: CURRENT_CONTENT_HASH_ENCODING,
  };

  const loaded = await loadStateForWrite(stateDir, deps);
  // Issue #3875: persisting the empty fallback state would erase every other
  // issue's baseline, so a single transient read fault would disarm the whole
  // fleet's TOCTOU gate. Divert instead of destroying.
  if (loaded.unusable) {
    return await divertSnapshotToRecovery(
      stateDir,
      key,
      snapshot,
      loaded.unusable,
      deps,
    );
  }

  loaded.state.snapshots[key] = snapshot;
  return await saveContentApprovalState(stateDir, loaded.state, deps);
}

/**
 * Verify that issue content has not changed since work-on approval.
 *
 * Compares the current title + body hash against the stored snapshot.
 *
 * @param stateDir - Approval-state store (see `content_approval_state_dir.ts`)
 * @param repo - Repository in "owner/repo" format
 * @param issueNumber - Issue number
 * @param currentTitle - Current issue title
 * @param currentBody - Current issue body
 * @param deps - Optional dependency overrides for testing
 * @returns Verification result: unchanged, changed, no_snapshot, or error
 */
export async function verifyContentUnchanged(
  stateDir: string,
  repo: string,
  issueNumber: number,
  currentTitle: string,
  currentBody: string,
  deps: ContentApprovalDeps = {},
): Promise<ContentVerificationResult> {
  try {
    const loaded = await readContentApprovalState(stateDir, deps);
    if (!loaded.ok) {
      // Issues #3649, #3717: an unusable or deleted baseline is an error,
      // not "no snapshot".
      return { status: "error", message: loaded.error.message };
    }
    const state = loaded.value;
    const key = snapshotKey(repo, issueNumber);
    const snapshot = state.snapshots[key];

    if (!snapshot) {
      // Issue #3875: once this store has failed to read during the run, a
      // missing snapshot is indistinguishable from a destroyed one, so it
      // must not be blessed as a first encounter for the rest of the cycle.
      if (isContentStateUnusable(stateDir)) {
        return {
          status: "error",
          message:
            `No approval snapshot for ${key}, and the content approval store ` +
            `${stateDir} was unusable earlier in this run — a missing baseline ` +
            `cannot be trusted as a first encounter`,
        };
      }
      return { status: "no_snapshot" };
    }

    // Issue #3963: check the digest under the encoding it was *stored* under.
    // Hashing under whatever encoding the running worker happens to use made
    // an encoding upgrade indistinguishable from a content edit, and the whole
    // fleet was de-scheduled the first time one shipped.
    const encodings = candidateEncodings(snapshot);
    if (!encodings.ok) {
      return { status: "error", message: encodings.error.message };
    }

    for (const encoding of encodings.value) {
      const hash = await computeContentHash(
        currentTitle,
        currentBody,
        encoding,
      );
      if (hash !== snapshot.contentHash) continue;
      // A snapshot with no stamp is re-baselined too: an unstamped digest
      // stays ambiguous until it is rewritten with its encoding recorded.
      return snapshot.encoding === CURRENT_CONTENT_HASH_ENCODING
        ? { status: "unchanged" }
        : { status: "unchanged", staleEncoding: encoding };
    }

    return {
      status: "changed",
      issueAuthor: snapshot.issueAuthor,
      capturedAt: snapshot.capturedAt,
    };
  } catch (err) {
    return {
      status: "error",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Remove a single snapshot (e.g., after processing or issue closure).
 *
 * @param stateDir - Approval-state store (see `content_approval_state_dir.ts`)
 * @param repo - Repository in "owner/repo" format
 * @param issueNumber - Issue number
 * @param deps - Optional dependency overrides for testing
 */
export async function removeContentSnapshot(
  stateDir: string,
  repo: string,
  issueNumber: number,
  deps: ContentApprovalDeps = {},
): Promise<Result<void>> {
  const loaded = await loadStateForWrite(stateDir, deps);
  const key = snapshotKey(repo, issueNumber);

  // Issue #3875: removing one key from the empty fallback state and saving it
  // would delete every remaining baseline. Refuse the write and say so.
  if (loaded.unusable) {
    return {
      ok: false,
      error: new Error(
        `Cannot remove the approval snapshot for ${key}: the content approval ` +
          `state at ${statePath(stateDir)} is unusable ` +
          `(${loaded.unusable.message}), so it has been left untouched rather ` +
          `than rewritten from a partial map`,
      ),
    };
  }

  delete loaded.state.snapshots[key];

  return await saveContentApprovalState(stateDir, loaded.state, deps);
}

/**
 * Clean up stale snapshots older than the maximum age.
 *
 * Also removes snapshots for issues in the provided closed-issues set.
 *
 * @param stateDir - Approval-state store (see `content_approval_state_dir.ts`)
 * @param closedIssueKeys - Set of "repo|issueNumber" keys for closed issues
 * @param maxAgeSeconds - Maximum age for snapshots (default: 7 days)
 * @param deps - Optional dependency overrides for testing
 * @returns Result with the number of removed snapshots
 */
export async function cleanupStaleSnapshots(
  stateDir: string,
  closedIssueKeys: Set<string> = new Set(),
  maxAgeSeconds: number = SNAPSHOT_MAX_AGE_SECONDS,
  deps: ContentApprovalDeps = {},
): Promise<Result<number>> {
  const loaded = await loadStateForWrite(stateDir, deps);
  // Issue #3875: a cleanup pass derived from the empty fallback state has
  // nothing to remove and would only rewrite the file from a partial map.
  if (loaded.unusable) {
    return {
      ok: false,
      error: new Error(
        `Cannot clean up stale approval snapshots: the content approval state ` +
          `at ${
            statePath(stateDir)
          } is unusable (${loaded.unusable.message}), ` +
          `so it has been left untouched`,
      ),
    };
  }

  const state = loaded.state;
  const now = nowSeconds();
  let removed = 0;

  for (const [key, snapshot] of Object.entries(state.snapshots)) {
    const isStale = (now - snapshot.capturedAt) >= maxAgeSeconds;
    const isClosed = closedIssueKeys.has(key);

    if (isStale || isClosed) {
      delete state.snapshots[key];
      removed++;
    }
  }

  if (removed > 0) {
    const saveResult = await saveContentApprovalState(stateDir, state, deps);
    if (!saveResult.ok) return saveResult as Result<number>;
  }

  return { ok: true, value: removed };
}

/**
 * Check whether an issue author is trusted (in the allowed authors list).
 *
 * @param issueAuthor - Issue author's GitHub username
 * @param allowedAuthors - List of authorised GitHub usernames
 * @returns True if the author is trusted
 */
export function isAuthorTrusted(
  issueAuthor: string,
  allowedAuthors: string[],
): boolean {
  const normalised = issueAuthor.toLowerCase();
  return allowedAuthors.some((a) => a.toLowerCase() === normalised);
}

/**
 * Build the security comment posted when content modification is detected.
 *
 * Issue #1740: also reports the `needs-human` label that has been applied
 * so the issue surfaces to a human reviewer rather than appearing ignored.
 *
 * @param issueNumber - Issue number
 * @param needsHumanLabel - Name of the worker-to-human escalation label
 *                         (defaults to "needs-human")
 * @returns Comment body string
 */
export function buildContentModifiedComment(
  issueNumber: number,
  needsHumanLabel: string = "needs-human",
): string {
  return [
    `## ⚠️ Issue Modified After Approval`,
    "",
    `Issue #${issueNumber} has been modified since a trusted author approved it ` +
    `with the \`work-on\` label.`,
    "",
    `For security, the \`work-on\` label has been removed, the ` +
    `\`${needsHumanLabel}\` label has been added, and automated processing has been blocked.`,
    "",
    `**To re-approve:** A trusted author should review the current issue content ` +
    `and re-add the \`work-on\` label if appropriate.`,
  ].join("\n");
}
