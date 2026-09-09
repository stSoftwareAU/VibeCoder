/**
 * Bounded, read-only Codex budget adapter (Issue #1697, parent #1694).
 *
 * `codex_budget_source.ts` records **which** sources the pinned CLI actually
 * exposes and parses their shapes; this module is the thing a caller uses. It
 * holds one cached snapshot per `CODEX_HOME`, refreshes it at most once per
 * bounded interval, collapses concurrent refreshes into a single read, and
 * records explicit exhaustion the instant a run reports it.
 *
 * Three properties are the point, and each is load-bearing:
 *
 * - **It never spends quota.** Every reading comes from a file the CLI already
 *   wrote — the rollout session JSONL — or from an error message a run already
 *   produced. There is no probe, because Codex has no free one: a probe would
 *   have to run a real turn, spending quota to estimate quota.
 * - **It never fabricates.** An API-key credential has no subscription window,
 *   so it answers `api-key-account` rather than inventing a weekly allowance.
 *   A missing file, an unparseable snapshot and a rejected credential each get
 *   their own reason code, and none of them is a zero.
 * - **It never leaks.** The only credential fact it reads is *presence*, via
 *   `codex_auth_mode.ts`; no token value is opened, returned or logged.
 *
 * ```mermaid
 * flowchart TD
 *     C["caller"] --> R["refresh()"]
 *     R -->|in flight| D["join the running read<br/>(no second read)"]
 *     R -->|cached &amp; within interval| K["cached snapshot"]
 *     R -->|due| A{"auth mode"}
 *     A -->|api key| X["unknown: api-key-account"]
 *     A -->|chatgpt / unknown| S["newest rollout session file"]
 *     S -->|token_count + rate_limits| B["known budget"]
 *     S -->|none| N["unknown: no-rate-limit-event"]
 *     E["turn.failed message"] --> Z["recordExhaustion()<br/>immediate; never overwritten<br/>by older evidence"]
 * ```
 *
 * Australian English spelling throughout (behaviour, organisation, utilise).
 */

import {
  type CodexBudget,
  type CodexExhaustion,
  parseCodexExhaustion,
  parseCodexRolloutLine,
} from "./codex_budget_source.ts";
import { type CodexAuthMode, resolveCodexAuthMode } from "./codex_auth_mode.ts";
import { type EnvLookup, processEnvLookup } from "./env_lookup.ts";

/** Sessions subdirectory of `CODEX_HOME` (`codex-rs/rollout/src/lib.rs`). */
export const CODEX_SESSIONS_SUBDIR = "sessions";

/**
 * Shortest gap between two disk reads for one `CODEX_HOME` (60s).
 *
 * The "conservative bounded recheck" of Issue #1697: after exhaustion, and
 * between ordinary reads, the adapter answers from cache rather than
 * re-scanning. A rollout file only gains a rate-limit line when a turn
 * completes, so a tighter cadence would read the same bytes again for nothing.
 */
export const DEFAULT_CODEX_MIN_REFRESH_INTERVAL_MS = 60_000;

/**
 * Age past which a snapshot is reported stale (15 minutes).
 *
 * Staleness is surfaced, never silently corrected: a caller decides whether an
 * old reading is still worth acting on. A stale snapshot is still a real
 * reading, so it is never converted into an unknown.
 */
export const DEFAULT_CODEX_SNAPSHOT_MAX_AGE_MS = 15 * 60_000;

/** Bytes read from the tail of a rollout file (256 KiB). */
export const DEFAULT_CODEX_ROLLOUT_TAIL_BYTES = 256 * 1024;

/** Newest rollout files examined before giving up on a rate-limit line. */
const MAX_ROLLOUT_FILES = 3;

/** Day directories descended into while looking for those files. */
const MAX_DAY_DIRECTORIES = 14;

/** Where a snapshot's evidence came from. */
export type CodexBudgetSourceKind =
  /** A `token_count` event in a rollout session file. */
  | "rollout-token-count"
  /** An explicit exhaustion message from a run. */
  | "exhaustion-event"
  /** The credential itself was rejected — not a budget reading at all. */
  | "auth-rejection"
  /** The credential kind alone settled it (an API key has no window). */
  | "auth-mode"
  /** Nothing was readable. */
  | "none";

/** One recorded budget reading, with the timestamps that make it auditable. */
export interface CodexBudgetSnapshot {
  /** The budget, known or explicitly unknown. */
  readonly budget: CodexBudget;
  /** Which source produced it. */
  readonly source: CodexBudgetSourceKind;
  /** When the adapter recorded it, in epoch ms. */
  readonly readAt: number;
  /** When the CLI produced the evidence, in epoch ms, when known. */
  readonly capturedAt?: number;
  /**
   * When the evidence itself was produced, in epoch ms.
   *
   * `capturedAt` for a rollout line (the CLI's own timestamp) and the moment
   * of the report for an exhaustion or a rejection. This is what orders two
   * snapshots against each other — see {@link CodexBudgetAdapter}'s `#store`.
   */
  readonly evidenceAt: number;
  /** Explicit exhaustion evidence, when this snapshot carries any. */
  readonly exhaustion?: CodexExhaustion;
  /** The credential kind in force when the reading was taken. */
  readonly authMode: CodexAuthMode;
}

/** Construction options; production passes `codexHome` and nothing else. */
export interface CodexBudgetAdapterOptions {
  /** The `CODEX_HOME` whose sessions and `auth.json` are read. */
  readonly codexHome: string;
  /** Injected clock, for tests. */
  readonly now?: () => number;
  /** Injected environment lookup, forwarded to the auth-mode resolver. */
  readonly env?: EnvLookup;
  /** Shortest gap between two disk reads. */
  readonly minRefreshIntervalMs?: number;
  /** Age past which {@link CodexBudgetAdapter.isStale} answers true. */
  readonly maxSnapshotAgeMs?: number;
  /** Bytes read from the tail of each rollout file. */
  readonly tailBytes?: number;
}

/** Sort descending by name — rollout paths embed a zero-padded timestamp. */
function byNameDescending(a: string, b: string): number {
  return a < b ? 1 : a > b ? -1 : 0;
}

/**
 * List a directory's entries by name, newest first.
 *
 * A directory that is simply not there is `[]` — a `CODEX_HOME` that has never
 * run a session is the ordinary case, not a fault. Every **other** failure —
 * a permissions error, a broken mount, a path that is a file rather than a
 * directory — is rethrown, because reporting it as "no sessions" would hide a
 * broken host behind a benign reason code.
 *
 * @param dir - Directory to list.
 * @param wanted - Whether to return subdirectories or files.
 * @returns Matching entry names, descending.
 * @throws Whatever `Deno.readDirSync` threw, unless it was `NotFound`.
 */
function entryNames(dir: string, wanted: "dir" | "file"): string[] {
  const names: string[] = [];
  try {
    for (const entry of Deno.readDirSync(dir)) {
      if (wanted === "dir" ? entry.isDirectory : entry.isFile) {
        names.push(entry.name);
      }
    }
  } catch (error: unknown) {
    if (error instanceof Deno.errors.NotFound) return [];
    throw error;
  }
  return names.sort(byNameDescending);
}

/**
 * Find the newest rollout session files under a `CODEX_HOME`.
 *
 * The layout is `sessions/YYYY/MM/DD/rollout-<ISO ts>-<id>.jsonl`, all parts
 * zero-padded, so descending name order is descending chronological order at
 * every level. The descent is bounded twice over — at most
 * {@link MAX_DAY_DIRECTORIES} day directories and at most `limit` files — so a
 * long-lived `CODEX_HOME` with years of sessions costs the same as a fresh one.
 *
 * @param codexHome - The `CODEX_HOME` directory.
 * @param limit - Most files to return.
 * @returns Newest-first absolute paths; empty when there are none.
 * @throws When a directory exists but cannot be read — never silently empty.
 */
export function findRecentRolloutFiles(
  codexHome: string,
  limit: number = MAX_ROLLOUT_FILES,
): string[] {
  const sessions = `${codexHome.replace(/\/+$/, "")}/${CODEX_SESSIONS_SUBDIR}`;
  const found: string[] = [];
  let dayDirs = 0;

  for (const year of entryNames(sessions, "dir")) {
    for (const month of entryNames(`${sessions}/${year}`, "dir")) {
      for (
        const day of entryNames(`${sessions}/${year}/${month}`, "dir")
      ) {
        if (dayDirs >= MAX_DAY_DIRECTORIES) return found;
        dayDirs++;
        const dir = `${sessions}/${year}/${month}/${day}`;
        for (const name of entryNames(dir, "file")) {
          if (!name.startsWith("rollout-") || !name.endsWith(".jsonl")) {
            continue;
          }
          found.push(`${dir}/${name}`);
          if (found.length >= limit) return found;
        }
      }
    }
  }
  return found;
}

/**
 * Read at most `maxBytes` from the end of a file.
 *
 * A rollout file grows without bound across a long session, and only its tail
 * carries the newest rate limits, so the whole file is never loaded. When the
 * read starts mid-file the first (partial) line is dropped rather than handed
 * to a JSON parser that would reject it anyway.
 *
 * @param path - File to read.
 * @param maxBytes - Cap on bytes read.
 * @returns The decoded tail, or `null` when the file could not be read.
 */
export function readFileTail(path: string, maxBytes: number): string | null {
  let file: Deno.FsFile;
  try {
    file = Deno.openSync(path, { read: true });
  } catch {
    return null;
  }
  try {
    const size = file.statSync().size;
    const start = size > maxBytes ? size - maxBytes : 0;
    if (start > 0) file.seekSync(start, Deno.SeekMode.Start);

    const buffer = new Uint8Array(size - start);
    let filled = 0;
    while (filled < buffer.length) {
      const read = file.readSync(buffer.subarray(filled));
      if (read === null || read === 0) break;
      filled += read;
    }
    const text = new TextDecoder("utf-8", { fatal: false })
      .decode(buffer.subarray(0, filled));
    if (start === 0) return text;
    const newline = text.indexOf("\n");
    return newline === -1 ? "" : text.slice(newline + 1);
  } catch {
    return null;
  } finally {
    file.close();
  }
}

/**
 * Build the snapshot one piece of exhaustion evidence justifies — and no more.
 *
 * The window is **not** named. An exhaustion message evidences that *a* window
 * is spent without saying which, and copying the previously most-constrained
 * one would record a five-hour exhaustion as the weekly window at zero — an
 * inference the CLI never made, on the very field #1696 would rank.
 *
 * @param exhaustion - The parsed evidence.
 * @param at - When it was reported, epoch ms.
 * @param previous - The cached snapshot, for the credential kind only.
 * @returns The snapshot to store.
 */
function exhaustionSnapshot(
  exhaustion: CodexExhaustion,
  at: number,
  previous: CodexBudgetSnapshot | undefined,
): CodexBudgetSnapshot {
  const budget: CodexBudget = exhaustion.kind === "http_429"
    ? { known: false, reason: "transient-rate-limit" }
    : {
      known: true,
      remainingFraction: 0,
      windows: [],
      ...(exhaustion.limitName !== undefined
        ? { limitName: exhaustion.limitName }
        : {}),
    };

  return {
    budget,
    source: "exhaustion-event",
    readAt: at,
    evidenceAt: at,
    exhaustion,
    authMode: previous?.authMode ?? "unknown",
  };
}

/**
 * A bounded, deduplicating, read-only view of one `CODEX_HOME`'s budget.
 *
 * One instance per credential scope: the snapshot it caches describes the
 * account behind that `CODEX_HOME`, so two credentials need two adapters and
 * never share a cache.
 */
export class CodexBudgetAdapter {
  readonly #codexHome: string;
  readonly #now: () => number;
  readonly #env?: EnvLookup;
  readonly #minRefreshIntervalMs: number;
  readonly #maxSnapshotAgeMs: number;
  readonly #tailBytes: number;

  #snapshot: CodexBudgetSnapshot | undefined;
  #inFlight: Promise<CodexBudgetSnapshot> | undefined;
  #reads = 0;

  constructor(options: CodexBudgetAdapterOptions) {
    this.#codexHome = options.codexHome;
    this.#now = options.now ?? (() => Date.now());
    this.#env = options.env;
    this.#minRefreshIntervalMs = options.minRefreshIntervalMs ??
      DEFAULT_CODEX_MIN_REFRESH_INTERVAL_MS;
    this.#maxSnapshotAgeMs = options.maxSnapshotAgeMs ??
      DEFAULT_CODEX_SNAPSHOT_MAX_AGE_MS;
    this.#tailBytes = options.tailBytes ?? DEFAULT_CODEX_ROLLOUT_TAIL_BYTES;
  }

  /** The cached snapshot, without touching the disk. */
  latest(): CodexBudgetSnapshot | undefined {
    return this.#snapshot;
  }

  /**
   * How many disk reads this adapter has performed.
   *
   * Exposed so a caller — and the tests — can assert that deduplication and
   * the recheck interval genuinely prevented reads, rather than assuming it.
   */
  get readCount(): number {
    return this.#reads;
  }

  /**
   * Whether the cached snapshot is older than the configured maximum age.
   *
   * @param at - Instant to measure against; defaults to the injected clock.
   * @returns true when there is no snapshot, or the snapshot has aged out.
   */
  isStale(at: number = this.#now()): boolean {
    if (!this.#snapshot) return true;
    return at - this.#snapshot.readAt > this.#maxSnapshotAgeMs;
  }

  /**
   * Return the current budget, reading from disk only when one is due.
   *
   * Concurrent callers share a single read: the second caller joins the first
   * caller's promise rather than starting a second scan of the same files.
   *
   * @returns The snapshot — cached, deduplicated, or freshly read.
   */
  refresh(): Promise<CodexBudgetSnapshot> {
    if (this.#inFlight) return this.#inFlight;

    const now = this.#now();
    const cached = this.#snapshot;
    if (cached && now - cached.readAt < this.#minRefreshIntervalMs) {
      return Promise.resolve(cached);
    }

    const running = (async () => {
      // `await` once so concurrent synchronous callers observe `#inFlight`
      // before any reading happens.
      await Promise.resolve();
      // Stored through `#store`, so an exhaustion recorded *while* this read
      // was in flight is not overwritten by the older reading it returns.
      return this.#store(this.#read());
    })().finally(() => {
      this.#inFlight = undefined;
    });

    this.#inFlight = running;
    return running;
  }

  /**
   * Record explicit exhaustion from a run's own failure message.
   *
   * Immediate: exhaustion is the one fact worth more than a fresh percentage,
   * so it lands without waiting for the recheck interval and is not overwritten
   * by an older reading (see `#store`). The reset instant stays unknown — the
   * CLI prints it in the host's local timezone with no offset, so recovering
   * an instant from it would be a guess.
   *
   * A bare `429` is deliberately **not** recorded as a spent window: the
   * pinned CLI words a genuine usage limit as `UsageLimitReached`, so an
   * `unexpected status 429` is a per-request throttle and the remaining budget
   * is honestly unknown.
   *
   * @param message - A `turn.failed` / `error` event message.
   * @param at - Instant to record; defaults to the injected clock.
   * @returns The recorded snapshot, or `null` for an ordinary failure.
   */
  recordExhaustion(
    message: string,
    at: number = this.#now(),
  ): CodexBudgetSnapshot | null {
    const exhaustion = parseCodexExhaustion(message);
    if (!exhaustion) return null;
    return this.#store(exhaustionSnapshot(exhaustion, at, this.#snapshot));
  }

  /** Record a rejected credential, so 401/403 is never read as "no budget". */
  recordAuthRejected(
    detail?: string,
    at: number = this.#now(),
  ): CodexBudgetSnapshot {
    return this.#store({
      budget: {
        known: false,
        reason: "auth-rejected",
        ...(detail !== undefined ? { detail } : {}),
      },
      // A rejected credential is not exhaustion evidence, and must not be
      // filed as any: the whole point of the reason code is to keep "spent"
      // and "refused" apart.
      source: "auth-rejection",
      readAt: at,
      evidenceAt: at,
      authMode: this.#snapshot?.authMode ?? "unknown",
    });
  }

  /**
   * Adopt a snapshot unless the cached one rests on newer evidence.
   *
   * Two orderings meet here and both used to lose an exhaustion. A `refresh()`
   * in flight when a run reports exhaustion finished *after* it and wrote its
   * older reading over the newer fact; and the next due `refresh()` re-read
   * the same unchanged rollout file and did it again. Both are the same bug —
   * nothing compared the two pieces of evidence — so both are fixed here,
   * once, rather than at each call site.
   *
   * `readAt` still advances on a rejected replacement, so the recheck interval
   * moves on and the adapter does not re-read the same file every call.
   *
   * @param next - The snapshot just produced.
   * @returns Whichever snapshot now stands.
   */
  #store(next: CodexBudgetSnapshot): CodexBudgetSnapshot {
    const current = this.#snapshot;
    if (current && next.evidenceAt < current.evidenceAt) {
      const kept: CodexBudgetSnapshot = {
        ...current,
        readAt: Math.max(current.readAt, next.readAt),
      };
      this.#snapshot = kept;
      return kept;
    }
    this.#snapshot = next;
    return next;
  }

  /** One disk read: auth mode, then the newest rollout rate-limit line. */
  #read(): CodexBudgetSnapshot {
    this.#reads++;
    const readAt = this.#now();
    const auth = resolveCodexAuthMode(
      this.#codexHome,
      this.#env ?? processEnvLookup,
    );
    /** Every non-reading outcome shares this envelope. */
    const unknown = (
      budget: CodexBudget,
      source: CodexBudgetSourceKind,
    ): CodexBudgetSnapshot => ({
      budget,
      source,
      readAt,
      evidenceAt: readAt,
      authMode: auth.mode,
    });

    if (auth.mode === "api-key") {
      return unknown({
        known: false,
        reason: "api-key-account",
        detail:
          "API-key credentials are metered by the account's own rate limits " +
          "and billing; Codex reports no subscription window for them",
      }, "auth-mode");
    }

    let files: string[];
    try {
      files = findRecentRolloutFiles(this.#codexHome);
    } catch (error: unknown) {
      // A sessions directory that exists but cannot be walked is a fault, and
      // must not be reported as "this credential has never run" — that reads
      // as an ordinary empty CODEX_HOME and hides a broken mount or a
      // permissions error behind a benign-looking reason code.
      return unknown({
        known: false,
        reason: "read-error",
        detail: `the sessions directory under ${this.#codexHome} could not ` +
          `be walked: ${error instanceof Error ? error.name : "unknown error"}`,
      }, "none");
    }

    if (files.length === 0) {
      return unknown({
        known: false,
        reason: "no-session-file",
        detail: `no rollout session files under ${this.#codexHome}`,
      }, "none");
    }

    let unreadable = 0;
    for (const path of files) {
      const tail = readFileTail(path, this.#tailBytes);
      if (tail === null) {
        unreadable++;
        continue;
      }
      const lines = tail.split("\n");
      for (let index = lines.length - 1; index >= 0; index--) {
        const reading = parseCodexRolloutLine(lines[index]!);
        if (!reading) continue;
        return {
          budget: reading.budget,
          source: "rollout-token-count",
          readAt,
          // The CLI's own timestamp is what orders this against an exhaustion
          // report; a line with none cannot outrank anything, so it falls back
          // to the read instant only for freshness, never for precedence.
          evidenceAt: reading.capturedAt ?? 0,
          ...(reading.capturedAt !== undefined
            ? { capturedAt: reading.capturedAt }
            : {}),
          authMode: auth.mode,
        };
      }
    }

    if (unreadable === files.length) {
      return unknown({
        known: false,
        reason: "read-error",
        detail: `${unreadable} rollout session file(s) could not be read`,
      }, "none");
    }

    return unknown({
      known: false,
      reason: "no-rate-limit-event",
      detail: `no token_count event carrying rate_limits in the newest ` +
        `${files.length} rollout session file(s)`,
    }, "none");
  }
}
