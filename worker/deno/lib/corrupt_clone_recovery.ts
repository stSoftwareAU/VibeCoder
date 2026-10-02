/**
 * Move a corrupt clone aside and re-clone it, at most once per repo per 24 h
 * per host (Issue #2957).
 *
 * `discardBrokenClone` (Issue #2848) already removes a directory that holds
 * no repository at all; this module handles the harder case — a directory
 * that *is* a repository, but a corrupt one (`detectHostFault` classes its
 * git output as `"clone-corrupt"`). Deleting it outright would discard any
 * clue a human might need to diagnose a host that keeps corrupting clones,
 * so it is renamed aside with a timestamp instead and only cleaned up the
 * next time the same repo needs recovering. The 24 h window stops a
 * persistently broken host/repo pair from looping forever.
 *
 * When the cap refuses a second re-clone within the window, the refusal is a
 * distinct, worse signal than a first corruption: the same repo on the same
 * host corrupted its clone twice inside 24 h. Issue #2958 gives that refusal
 * a machine-parseable `clone-corrupt-repeat` payload riding inside the error
 * message, so callers downstream of `setupRepo` (which only ever sees the
 * message, not this module's types) can still recover the structured detail.
 */

import type { Result } from "../types.ts";
import { detectHostFault } from "./host_fault.ts";
import { atomicWrite } from "./file_utils.ts";
import { withStateLock } from "./state_mutex.ts";
import { getHostname } from "./worker_identity.ts";
import { CLONE_CORRUPT_MARKER } from "./failure_diagnosis.ts";

/** Prefix of the one-line payload a cap refusal carries (Issue #2958). */
export const CLONE_CORRUPT_REPEAT_MARKER = "clone-corrupt-repeat";

/** A second corruption of the same repo on the same host within the window. */
export interface CloneCorruptRepeat {
  repo: string;
  host: string;
  /** ISO time of the first corruption (the recovery the cap remembers). */
  previousAt: string;
  /** Git output of the first corruption; absent for state written before #2958. */
  previousGitMessage?: string;
  /** Where the first corrupt clone was moved aside; absent for legacy state. */
  aside?: string;
  /** ISO time of this, the second, corruption. */
  currentAt: string;
  currentGitMessage: string;
}

/** Git/aside strings stored in state and the repeat payload are capped to this length. */
const MAX_STORED_MESSAGE_LENGTH = 1000;

/** Truncate `value` to {@link MAX_STORED_MESSAGE_LENGTH} so stored state and payloads stay bounded. */
function capLength(value: string): string {
  return value.length > MAX_STORED_MESSAGE_LENGTH
    ? value.slice(0, MAX_STORED_MESSAGE_LENGTH)
    : value;
}

/** `clone-corrupt-repeat: {json}` on a single line. */
export function formatCloneCorruptRepeat(repeat: CloneCorruptRepeat): string {
  return `${CLONE_CORRUPT_REPEAT_MARKER}: ${JSON.stringify(repeat)}`;
}

/** Matches the single-line `clone-corrupt-repeat: {json}` payload inside any message. */
const CLONE_CORRUPT_REPEAT_RE = new RegExp(
  `${
    CLONE_CORRUPT_REPEAT_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  }: (\\{[^\\n]*\\})`,
);

/**
 * Parse the payload out of any message containing it; `null` when absent or
 * malformed (validates every field's type; optional fields must be a string
 * when present).
 */
export function parseCloneCorruptRepeat(
  message: string,
): CloneCorruptRepeat | null {
  const match = message.match(CLONE_CORRUPT_REPEAT_RE);
  if (match === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(match[1]!);
  } catch {
    // Malformed JSON payload — not a well-formed clone-corrupt-repeat marker.
    return null;
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const obj = parsed as Record<string, unknown>;
  if (
    typeof obj.repo !== "string" ||
    typeof obj.host !== "string" ||
    typeof obj.previousAt !== "string" ||
    typeof obj.currentAt !== "string" ||
    typeof obj.currentGitMessage !== "string" ||
    (obj.previousGitMessage !== undefined &&
      typeof obj.previousGitMessage !== "string") ||
    (obj.aside !== undefined && typeof obj.aside !== "string")
  ) {
    return null;
  }

  const repeat: CloneCorruptRepeat = {
    repo: obj.repo,
    host: obj.host,
    previousAt: obj.previousAt,
    currentAt: obj.currentAt,
    currentGitMessage: obj.currentGitMessage,
  };
  if (typeof obj.previousGitMessage === "string") {
    repeat.previousGitMessage = obj.previousGitMessage;
  }
  if (typeof obj.aside === "string") {
    repeat.aside = obj.aside;
  }
  return repeat;
}

/** A repo is only re-cloned once per this many milliseconds, per host. */
export const CLONE_RECOVERY_WINDOW_MS = 24 * 60 * 60 * 1000;

/** True when git output describes a corrupt clone (detectHostFault === "clone-corrupt"). */
export function isCloneCorruption(message: string): boolean {
  return detectHostFault(message) === "clone-corrupt";
}

/** Sanitise a hostname for use in a filename, as `repo_fast_failure_tracker.ts` does. */
function sanitiseHostname(hostname: string): string {
  const cleaned = hostname.replace(/[^A-Za-z0-9._-]/g, "_");
  return cleaned.length > 0 ? cleaned : "unknown-host";
}

/** `${workDir}/clone_recoveries_${sanitisedHost}.json` — one state file per host. */
export function cloneRecoveryStatePath(
  workDir: string,
  hostname: string = getHostname(),
): string {
  return `${workDir}/clone_recoveries_${sanitiseHostname(hostname)}.json`;
}

/** Options for {@link recoverCorruptClone}; both default to the real host/clock. */
export interface CloneRecoveryOptions {
  now?: () => Date;
  hostname?: string;
}

/**
 * A recovery, in the object form written since Issue #2958: the ISO time of
 * the recovery, the (capped) git output that triggered it, and where the
 * corrupt clone was moved aside.
 */
interface RecoveryStateEntry {
  at: string;
  gitMessage?: string;
  aside?: string;
}

/**
 * The state file's shape: repo slug to its last recovery. A bare ISO string
 * is state written before #2958 — still a valid cap record, just without the
 * git message or aside path a `clone-corrupt-repeat` payload can quote.
 */
type RecoveryState = Record<string, string | RecoveryStateEntry>;

/** The ISO timestamp of a recovery, whichever state form it was written in. */
function recoveryTimestamp(value: string | RecoveryStateEntry): string {
  return typeof value === "string" ? value : value.at;
}

/** Whether `value` is a legacy ISO string or a well-formed {@link RecoveryStateEntry}. */
function isValidRecoveryValue(
  value: unknown,
): value is string | RecoveryStateEntry {
  if (typeof value === "string") return true;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const obj = value as Record<string, unknown>;
  return typeof obj.at === "string" &&
    (obj.gitMessage === undefined || typeof obj.gitMessage === "string") &&
    (obj.aside === undefined || typeof obj.aside === "string");
}

/**
 * Load the state file; `ok({})` if missing or unparseable (warning logged),
 * `err` for any other read fault — that must not silently reset the 24 h cap.
 */
async function loadState(statePath: string): Promise<Result<RecoveryState>> {
  let text: string;
  try {
    text = await Deno.readTextFile(statePath);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return { ok: true, value: {} };
    }
    return {
      ok: false,
      error: new Error(
        `Could not read the clone recovery state at ${statePath}: ${error}`,
      ),
    };
  }
  try {
    const parsed = JSON.parse(text);
    if (
      parsed !== null && typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      Object.values(parsed).every(isValidRecoveryValue)
    ) {
      return { ok: true, value: parsed as RecoveryState };
    }
  } catch {
    // Fall through to the warning below — an unparseable file is overwritten.
  }
  console.warn(
    `[corrupt-clone-recovery] ${statePath} is not valid recovery state; treating it as empty`,
  );
  return { ok: true, value: {} };
}

/** UTC `YYYYMMDDTHHMMSSZ`, e.g. `20261001T120000Z`. */
function formatTimestamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

/** The directory holding `path` — no `@std/path` in this import map. */
function parentDirectory(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return cut > 0 ? trimmed.slice(0, cut) : "/";
}

/** The final path segment — no `@std/path` in this import map. */
function baseName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return cut >= 0 ? trimmed.slice(cut + 1) : trimmed;
}

/**
 * Move a corrupt clone aside and record the recovery, unless the same repo
 * was already recovered on this host within {@link CLONE_RECOVERY_WINDOW_MS}.
 *
 * @returns `ok(<aside path>)` on success; `repoPath` no longer exists
 *   afterwards. `err` when the repo was already re-cloned too recently, or
 *   when any filesystem step fails.
 */
export async function recoverCorruptClone(
  repo: string,
  repoPath: string,
  workDir: string,
  gitMessage: string,
  options: CloneRecoveryOptions = {},
): Promise<Result<string>> {
  const now = options.now ?? (() => new Date());
  const statePath = cloneRecoveryStatePath(workDir, options.hostname);

  const base = baseName(repoPath);
  if (base === "" || base === "." || base === "..") {
    return {
      ok: false,
      error: new Error(`Not a recoverable path: ${repoPath}`),
    };
  }

  return await withStateLock(statePath, async (): Promise<Result<string>> => {
    const loaded = await loadState(statePath);
    if (!loaded.ok) return loaded;
    const state = loaded.value;
    const lastRecovery = state[repo];
    const nowDate = now();
    if (lastRecovery !== undefined) {
      const previousAt = recoveryTimestamp(lastRecovery);
      const elapsed = nowDate.getTime() - new Date(previousAt).getTime();
      if (elapsed >= 0 && elapsed < CLONE_RECOVERY_WINDOW_MS) {
        const host = options.hostname ?? getHostname();
        const repeat: CloneCorruptRepeat = {
          repo,
          host,
          previousAt,
          currentAt: nowDate.toISOString(),
          currentGitMessage: capLength(gitMessage),
        };
        if (typeof lastRecovery !== "string") {
          if (lastRecovery.gitMessage !== undefined) {
            repeat.previousGitMessage = lastRecovery.gitMessage;
          }
          if (lastRecovery.aside !== undefined) {
            repeat.aside = lastRecovery.aside;
          }
        }
        return {
          ok: false,
          error: new Error(
            `The clone of ${repo} at ${repoPath} is corrupt (${gitMessage}) and was already re-cloned within 24 h on this host, so it is not re-cloned again. — ${CLONE_CORRUPT_MARKER}.\n` +
              formatCloneCorruptRepeat(repeat),
          ),
        };
      }
    }

    const parent = parentDirectory(repoPath);
    const prefix = `${base}.corrupt-`;
    try {
      for await (const entry of Deno.readDir(parent)) {
        if (entry.name.startsWith(prefix)) {
          const siblingPath = `${parent}/${entry.name}`;
          try {
            await Deno.remove(siblingPath, { recursive: true });
          } catch (error) {
            return {
              ok: false,
              error: new Error(
                `Could not remove the old corrupt clone sibling at ${siblingPath}: ${error}`,
              ),
            };
          }
        }
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        return {
          ok: false,
          error: new Error(
            `Could not list the directory ${parent} to remove old corrupt clone siblings: ${error}`,
          ),
        };
      }
    }

    const aside = `${repoPath}.corrupt-${formatTimestamp(nowDate)}`;
    try {
      await Deno.rename(repoPath, aside);
    } catch (error) {
      return {
        ok: false,
        error: new Error(
          `Could not move the corrupt clone from ${repoPath} to ${aside}: ${error}`,
        ),
      };
    }

    const newEntry: RecoveryStateEntry = {
      at: nowDate.toISOString(),
      gitMessage: capLength(gitMessage),
      aside,
    };
    const newState: RecoveryState = { ...state, [repo]: newEntry };
    const written = await atomicWrite({
      targetFile: statePath,
      content: JSON.stringify(newState, null, 2) + "\n",
    });
    if (!written.ok) {
      return {
        ok: false,
        error: new Error(
          `Could not record the clone recovery in ${statePath}: ${written.error.message}`,
        ),
      };
    }

    const firstLine = gitMessage.split("\n")[0]!.trim();
    console.error(
      `ERROR: corrupt clone of ${repo} moved aside to ${aside}; re-cloning: ${firstLine}`,
    );
    return { ok: true, value: aside };
  });
}
