/**
 * TokenEconomizer learnings persistence (Issue #4957, part of #4953).
 *
 * The plugin keeps what it learns under `$TOKENECONOMIZER_HOME/repos/<key>/`.
 * This module carries that state between runs through the private learnings
 * repository (`token_economizer.learnings_repo`). A run pulls its own key's
 * state into its home before the plugin loads, and pushes what it learned back
 * after the plugin has stopped. The store holds `token-economizer/<key>/...`
 * and a shared `token-economizer/config.json`, which is pulled and never pushed.
 *
 * ## Only verified state moves
 *
 * Every transfer is preceded by the #4956 latch and a fresh visibility check,
 * so a store that turned public stops the transfer. A pull that cannot verify
 * the store is `unavailable`, never `empty`: a broken store must not look like
 * a clean slate.
 *
 * ## Pushed state is allow-listed, scanned and isolated
 *
 * Only JSON state under the run's own key is mirrored. Logs, transcripts,
 * launchers and sessions stay local. Staged files are scanned with gitleaks
 * before the commit, and a secret or a fact from another repository stops the
 * trial. The record names the rule, never the value. A rejected push is
 * replayed once on the new tip, and a conflicting replay is dropped and logged.
 *
 * ## Local state is discarded, except a clean clone
 *
 * A launch is shared by later spawns of the same run (a PR-feedback re-run or a
 * rate-limit retry), and each spawn pushes again with the same persistence. The
 * scratch clone is therefore kept after `pushed` and `unchanged`, because it is
 * clean and at the store tip. Every other outcome removes it. Before anything is
 * written under the clone, the push checks that it is its own repository, so a
 * removed clone is skipped and never resolved to an enclosing repository.
 *
 * Nothing here throws. Each outcome is a value, and each fault is a WARNING.
 * Australian English spelling used throughout.
 */

import { dirname, join } from "node:path";
import { runGitCommand } from "./git_timeout.ts";
import { runGhCommandRaw } from "./github.ts";
import { defaultLogger } from "./logger.ts";
import { parseReport, type ReportFinding } from "./gitleaks_check.ts";
import { redactSecrets } from "./secret_redaction.ts";
import { spawnWithDeadline } from "./semgrep_check.ts";
import type { TokenEconomizerFinding } from "./token_economizer_control.ts";

/** The store's top-level directory, holding one directory per repository key. */
export const LEARNINGS_STORE_ROOT = "token-economizer";

/** Total size of the allow-listed state of one repository key, in bytes. */
export const LEARNINGS_KEY_CAP_BYTES = 1_048_576;

/** Timeout for each git call that talks to the store (clone, fetch, push). */
export const LEARNINGS_GIT_TIMEOUT_SECONDS = 120;

/** The shared plugin settings file, pulled into the home and never pushed. */
const CONFIG_FILE = "config.json";

/** Deepest path the allow-list admits, counted in segments. */
const MAX_SEGMENTS = 8;

/** One path segment: a conservative character set, at most 100 characters. */
const SEGMENT_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;

/** The plugin's session records, which are never synced. */
const SESSIONS_DIR = "sessions";

/** Wall-clock ceiling for the staged gitleaks scan. */
const SCAN_DEADLINE_MS = 60_000;

/** Longest single-line reason kept in an outcome or a log line. */
const MAX_REASON_CHARS = 300;

/** Identity for the learnings commits, never the operator's. */
const COMMIT_IDENTITY = [
  "-c",
  "user.name=Vibe Coder TokenEconomizer",
  "-c",
  "user.email=token-economizer@vibe-coder.invalid",
];

/** Where a learned fact is persisted, and why it was not. */
export type LearningsPersistenceStatus =
  | "restored"
  | "empty"
  | "unavailable"
  | "refused";

/**
 * What the pull established. `restored` and `empty` are a verified private
 * store read; `unavailable` is a fault; `refused` is a visibility or latch refusal.
 */
export interface LearningsPersistence {
  readonly status: LearningsPersistenceStatus;
  /** Redacted, one line. */
  readonly reason: string;
  readonly repoKey?: string;
  /** The scratch clone, present only for `restored` and `empty`. */
  readonly storeDir?: string;
}

/** A visibility verdict: only a verified private repository is `private: true`. */
export type VisibilityVerdict =
  | { private: true }
  | { private: false; reason: string };

/** Asks whether a repository is private. Called fresh before every transfer. */
export type VisibilityCheck = (repo: string) => Promise<VisibilityVerdict>;

/** Logging sink; the default is the worker's logger. */
export interface LearningsLogger {
  info(message: string): void;
  warn(message: string): void;
}

/** The output of one gitleaks scan of the staged learnings. */
export interface StagedScan {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}

/** Inputs to {@link pullLearnings}. */
export interface PullLearningsOptions {
  learningsRepo: string;
  repoKey: string;
  home: string;
  /** A sibling path, never inside the home. The clone is removed on failure. */
  scratchDir: string;
  /** Default `https://github.com/${learningsRepo}.git`. */
  storeUrl?: string;
  /** Default {@link githubVisibilityCheck}. */
  checkVisibility?: VisibilityCheck;
  /** The #4956 latch: `tokenEconomizerMaySync(workDir)` in production. */
  mayTransfer: () => Promise<boolean>;
  logger?: LearningsLogger;
}

/** Inputs to {@link pushLearnings}. */
export interface PushLearningsOptions {
  learningsRepo: string;
  persistence: LearningsPersistence;
  home: string;
  /** For example `stSoftwareAU/VibeCoder#4957` or `owner/repo PR #12`. */
  subject: string;
  runId: string;
  checkVisibility?: VisibilityCheck;
  mayTransfer: () => Promise<boolean>;
  /** Records a durable stop. Production: `(f) => stopTokenEconomizerTrial(workDir, f)`. */
  stop: (finding: TokenEconomizerFinding) => Promise<unknown>;
  /** Default: the real gitleaks over the staged files. */
  scanStaged?: (cwd: string) => Promise<StagedScan>;
  logger?: LearningsLogger;
}

/** What {@link pushLearnings} did. */
export type PushLearningsOutcome =
  | { kind: "pushed"; commit: string }
  | { kind: "unchanged" }
  | { kind: "skipped"; reason: string }
  | { kind: "refused"; reason: string }
  | {
    kind: "stopped";
    rule: "secret-in-learnings" | "cross-repo-fact";
    reason: string;
  }
  | { kind: "dropped"; reason: string };

/** A fault whose message is safe to log. Any other error is reported as unexpected. */
class LearningsFault extends Error {}

/** One entry of the store or the home that the allow-list admits. */
interface StateFile {
  segments: string[];
  size: number;
}

/** The admitted files under one key root, and the entries the allow-list rejected. */
interface StateWalk {
  files: StateFile[];
  rejected: string[];
}

/** The result of one git call. A spawn failure is reported as code -1. */
interface GitRun {
  code: number;
  stdout: string;
  stderr: string;
}

/** The judged staged scan: clean, a finding, or a scanner fault. */
type ScanVerdict =
  | { kind: "clean" }
  | { kind: "leaks"; reason: string }
  | { kind: "fault"; cause: string };

/** Lower-case slug of a repository name, as the upstream `slug` (at most 40 characters). */
function slug(text: string): string {
  const cleaned = (text || "repo").toLowerCase().replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "").slice(0, 40);
  return cleaned === "" ? "repo" : cleaned;
}

/** The first 10 hex characters of the SHA-1 of `text`. */
async function sha1Prefix(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-1",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 10);
}

/**
 * The canonical form of a remote URL, mirroring the upstream `normalize_remote`:
 * the scheme and the user (the host's identity) are dropped, scp-style
 * `host:path` becomes `host/path`, and `.git` and trailing slashes are removed.
 */
export function normaliseRemote(url: string): string {
  let canon = url.trim();
  canon = canon.replace(/^[a-z+]+:\/\//, "");
  canon = canon.replace(/^[^@/]+@/, "");
  canon = canon.replace(/\\/g, "/").replace(/\/+/g, "/");
  if (!/^[a-zA-Z]:\//.test(canon) && /^[^/]+:[^/\d]/.test(canon)) {
    canon = canon.replace(":", "/");
  }
  canon = canon.replace(/\/+$/, "");
  if (canon.endsWith(".git")) canon = canon.slice(0, -".git".length);
  return canon.toLowerCase();
}

/** The repository key the plugin uses for `originUrl`, as `<slug>-<sha1 prefix>`. */
export async function learningsRepoKey(originUrl: string): Promise<string> {
  const canon = normaliseRemote(originUrl);
  const name = canon.slice(canon.lastIndexOf("/") + 1);
  return `${slug(name)}-${await sha1Prefix(canon)}`;
}

/** The repository key of a checkout's `origin`, or null when it has none or cannot be read. */
export async function repoKeyForCheckout(
  checkout: string,
): Promise<string | null> {
  try {
    const run = await git([
      "-C",
      checkout,
      "config",
      "--get",
      "remote.origin.url",
    ]);
    if (run.code !== 0) return null;
    const url = run.stdout.trim();
    return url === "" ? null : await learningsRepoKey(url);
  } catch {
    return null;
  }
}

/** A single-line, redacted, length-capped form of `text` for a reason or a log. */
function oneLine(text: string): string {
  return redactSecrets(text).replace(/\s+/g, " ").trim().slice(
    0,
    MAX_REASON_CHARS,
  );
}

/** The message of a thrown value. */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A visibility verdict that could not be verified is never private. */
function unverifiable(cause: string): VisibilityVerdict {
  return {
    private: false,
    reason: oneLine(`visibility unverifiable: ${cause}`),
  };
}

/**
 * A GitHub visibility check via `gh api repos/<repo>`. Only `private: true`
 * together with `visibility: "private"` is private. A missing key, non-JSON
 * output or a gh error is unverifiable, and so is never a transfer.
 */
export function githubVisibilityCheck(
  runGh: (args: string[]) => Promise<string> = runGhCommandRaw,
): VisibilityCheck {
  return async (repo) => {
    let raw: string;
    try {
      raw = await runGh(["api", `repos/${repo}`]);
    } catch (error) {
      return unverifiable(errorText(error));
    }
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return unverifiable("gh returned output that is not JSON");
    }
    const record = typeof body === "object" && body !== null
      ? body as Record<string, unknown>
      : {};
    const isPrivate = record.private;
    const visibility = record.visibility;
    if (isPrivate === true && visibility === "private") {
      return { private: true };
    }
    if (isPrivate === false || visibility === "public") {
      return {
        private: false,
        reason: oneLine(`learnings repository ${repo} is public`),
      };
    }
    if (typeof isPrivate === "boolean" && typeof visibility === "string") {
      return {
        private: false,
        reason: oneLine(`learnings repository ${repo} is ${visibility}`),
      };
    }
    return unverifiable("gh response lacks private or visibility");
  };
}

/** Run one visibility check; a check that throws is unverifiable. */
async function verifyPrivate(
  check: VisibilityCheck,
  repo: string,
): Promise<VisibilityVerdict> {
  try {
    return await check(repo);
  } catch (error) {
    return unverifiable(errorText(error));
  }
}

/** Run one git command. A spawn failure is reported as code -1, never thrown. */
async function git(args: string[], timeoutSeconds?: number): Promise<GitRun> {
  const result = await runGitCommand(
    args,
    timeoutSeconds === undefined ? {} : { timeoutSeconds },
  );
  if (!result.ok) {
    return { code: -1, stdout: "", stderr: result.error.message };
  }
  return {
    code: result.value.code,
    stdout: result.value.stdout,
    stderr: result.value.stderr,
  };
}

/**
 * The redacted cause of a failed git call: its first `fatal:`, `remote:` or
 * `ssh:` line, or else its first line. The last line is often only a summary.
 */
function causeOf(run: GitRun): string {
  const text = run.stderr.trim() === "" ? run.stdout : run.stderr;
  const lines = text.split("\n").map((line) => line.trim()).filter((line) =>
    line !== ""
  );
  const named = lines.find((line) => /^(fatal|remote|ssh):/.test(line));
  return oneLine(named ?? lines[0] ?? `git exited ${run.code}`);
}

/** Whether a segment is one the allow-list may name (not `.` or `..`). */
function isSafeSegment(segment: string): boolean {
  return SEGMENT_PATTERN.test(segment) && segment !== "." && segment !== "..";
}

/**
 * Whether a relative path is admitted: at most 8 segments, each safe and not
 * `sessions`, and a file must end `.json`. A symlink is never admitted, and the
 * caller checks that first.
 */
function admitted(segments: string[], isFile: boolean): boolean {
  if (segments.length > MAX_SEGMENTS) return false;
  if (!segments.every((s) => isSafeSegment(s) && s !== SESSIONS_DIR)) {
    return false;
  }
  return !isFile || (segments.at(-1) ?? "").endsWith(".json");
}

/** Whether a repository key is a safe single path segment. */
function isSafeKey(key: string): boolean {
  return isSafeSegment(key);
}

/** Total bytes of a set of admitted files. */
function totalBytes(files: StateFile[]): number {
  return files.reduce((sum, file) => sum + file.size, 0);
}

/**
 * Fail if `path` is a symlink or a non-directory. An absent path is fine.
 * Returns whether it exists.
 */
async function assertRealDirOrAbsent(path: string): Promise<boolean> {
  try {
    const info = await Deno.lstat(path);
    if (info.isSymlink || !info.isDirectory) {
      throw new LearningsFault(
        `${oneLine(path)} is not a plain directory`,
      );
    }
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

/** Walk one level of a key root, collecting admitted files and rejected entries. */
async function walkDir(
  root: string,
  prefix: string[],
  walk: StateWalk,
): Promise<void> {
  for await (const entry of Deno.readDir(join(root, ...prefix))) {
    const segments = [...prefix, entry.name];
    const info = await Deno.lstat(join(root, ...segments));
    if (info.isDirectory) {
      if (admitted(segments, false)) {
        await walkDir(root, segments, walk);
      } else {
        walk.rejected.push(segments.join("/"));
      }
    } else if (info.isFile && admitted(segments, true)) {
      walk.files.push({ segments, size: info.size });
    } else {
      walk.rejected.push(segments.join("/"));
    }
  }
}

/**
 * The admitted files under one key root. Symlinks and other entries are never
 * followed: they are reported in `rejected`. An absent root is empty.
 */
async function walkKeyRoot(root: string): Promise<StateWalk> {
  const walk: StateWalk = { files: [], rejected: [] };
  if (await assertRealDirOrAbsent(root)) await walkDir(root, [], walk);
  return walk;
}

/** Write one file under `dest`, creating its directories privately. */
async function writeState(dest: string, bytes: Uint8Array): Promise<void> {
  await Deno.mkdir(dirname(dest), { recursive: true, mode: 0o700 });
  await Deno.writeFile(dest, bytes, { mode: 0o600 });
}

/** Remove a path, ignoring its absence. Any other failure is a fault. */
async function removeIfPresent(path: string): Promise<void> {
  try {
    await Deno.remove(path, { recursive: true });
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
}

/** Whether a path exists. */
async function exists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

/** Remove the scratch clone the caller passed. Failure is a WARNING. */
async function removeScratch(
  dir: string,
  logger: LearningsLogger,
): Promise<void> {
  try {
    await removeIfPresent(dir);
  } catch (error) {
    logger.warn(
      `token-economizer learnings: scratch clone not removed (${
        oneLine(errorText(error))
      })`,
    );
  }
}

/** The outcome of an unverified pull, logged as a WARNING. */
function notRestored(
  logger: LearningsLogger,
  status: "unavailable" | "refused",
  reason: string,
  repoKey: string | undefined,
): LearningsPersistence {
  const clean = oneLine(reason);
  logger.warn(`token-economizer learnings: ${status}: ${clean}`);
  return { status, reason: clean, repoKey };
}

/** Pull the store's state for `repoKey` into `home`, verified and never throwing. */
export async function pullLearnings(
  opts: PullLearningsOptions,
): Promise<LearningsPersistence> {
  const logger = opts.logger ?? defaultLogger;
  const { repoKey, scratchDir, home } = opts;
  let attempted = false;
  try {
    if (!isSafeKey(repoKey)) {
      return notRestored(
        logger,
        "unavailable",
        "invalid repository key",
        undefined,
      );
    }
    if (!(await opts.mayTransfer())) {
      return notRestored(
        logger,
        "refused",
        "trial stop latched: learnings transfer is not permitted",
        repoKey,
      );
    }
    const verdict = await verifyPrivate(
      opts.checkVisibility ?? githubVisibilityCheck(),
      opts.learningsRepo,
    );
    if (verdict.private !== true) {
      return notRestored(logger, "refused", verdict.reason, repoKey);
    }

    attempted = true;
    const storeUrl = opts.storeUrl ??
      `https://github.com/${opts.learningsRepo}.git`;
    const clone = await git(
      [
        "clone",
        "--depth=1",
        "--filter=blob:none",
        "--sparse",
        "--no-checkout",
        "--",
        storeUrl,
        scratchDir,
      ],
      LEARNINGS_GIT_TIMEOUT_SECONDS,
    );
    if (clone.code !== 0) {
      throw new LearningsFault(`clone failed: ${causeOf(clone)}`);
    }

    const sparse = await git([
      "-C",
      scratchDir,
      "sparse-checkout",
      "set",
      "--no-cone",
      `/${LEARNINGS_STORE_ROOT}/${repoKey}/`,
      `/${LEARNINGS_STORE_ROOT}/${CONFIG_FILE}`,
    ]);
    if (sparse.code !== 0) {
      throw new LearningsFault(`sparse checkout failed: ${causeOf(sparse)}`);
    }

    // An unborn HEAD is a store with no state yet: verified, and empty.
    const head = await git([
      "-C",
      scratchDir,
      "rev-parse",
      "--verify",
      "-q",
      "HEAD",
    ]);
    if (head.code === 1) {
      logger.info(`token-economizer learnings: store is empty for ${repoKey}`);
      return {
        status: "empty",
        reason: "store holds no state yet",
        repoKey,
        storeDir: scratchDir,
      };
    }
    if (head.code !== 0) {
      throw new LearningsFault(`could not read store HEAD: ${causeOf(head)}`);
    }
    const checkout = await git(
      ["-C", scratchDir, "checkout", "--quiet"],
      LEARNINGS_GIT_TIMEOUT_SECONDS,
    );
    if (checkout.code !== 0) {
      throw new LearningsFault(`checkout failed: ${causeOf(checkout)}`);
    }

    // Validate everything before copying anything: an untrusted store is not loaded.
    const storeRoot = join(scratchDir, LEARNINGS_STORE_ROOT);
    await assertRealDirOrAbsent(storeRoot);
    const keyRoot = join(storeRoot, repoKey);
    const state = await walkKeyRoot(keyRoot);
    if (state.rejected.length > 0) {
      throw new LearningsFault(
        `store holds an entry outside the allow-list: ${
          oneLine(state.rejected[0] ?? "")
        }`,
      );
    }
    const bytes = totalBytes(state.files);
    if (bytes > LEARNINGS_KEY_CAP_BYTES) {
      throw new LearningsFault(
        `store state of ${bytes} bytes exceeds the ${LEARNINGS_KEY_CAP_BYTES}-byte cap`,
      );
    }
    const configPath = join(storeRoot, CONFIG_FILE);
    let hasConfig = false;
    try {
      const info = await Deno.lstat(configPath);
      if (!info.isFile) {
        throw new LearningsFault(`${CONFIG_FILE} is not a regular file`);
      }
      hasConfig = true;
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }

    for (const file of state.files) {
      await writeState(
        join(home, "repos", repoKey, ...file.segments),
        await Deno.readFile(join(keyRoot, ...file.segments)),
      );
    }
    if (hasConfig) {
      await writeState(
        join(home, CONFIG_FILE),
        await Deno.readFile(configPath),
      );
    }
    if (state.files.length === 0) {
      logger.info(`token-economizer learnings: store is empty for ${repoKey}`);
      return {
        status: "empty",
        reason: "store holds no state for this key",
        repoKey,
        storeDir: scratchDir,
      };
    }
    logger.info(
      `token-economizer learnings: restored ${state.files.length} file(s) for ${repoKey}`,
    );
    return {
      status: "restored",
      reason: `restored ${state.files.length} file(s)`,
      repoKey,
      storeDir: scratchDir,
    };
  } catch (error) {
    if (attempted) await removeScratch(scratchDir, logger);
    const reason = error instanceof LearningsFault
      ? error.message
      : `unexpected error: ${errorText(error)}`;
    return notRestored(logger, "unavailable", reason, repoKey);
  }
}

/** Build the outcome of a skipped push, logged as a WARNING. */
function skip(logger: LearningsLogger, reason: string): PushLearningsOutcome {
  const clean = oneLine(reason);
  logger.warn(`token-economizer learnings: skipped: ${clean}`);
  return { kind: "skipped", reason: clean };
}

/** Build the outcome of a refused push, logged as a WARNING. */
function refuse(logger: LearningsLogger, reason: string): PushLearningsOutcome {
  const clean = oneLine(reason);
  logger.warn(`token-economizer learnings: refused: ${clean}`);
  return { kind: "refused", reason: clean };
}

/** Build the outcome of a dropped push, logged as a WARNING. */
function drop(logger: LearningsLogger, reason: string): PushLearningsOutcome {
  const clean = oneLine(reason);
  logger.warn(`token-economizer learnings: dropped: ${clean}`);
  return { kind: "dropped", reason: clean };
}

/** Report a stop. A failure to record it is a WARNING and never changes the outcome. */
async function reportStop(
  stop: PushLearningsOptions["stop"],
  finding: TokenEconomizerFinding,
  logger: LearningsLogger,
): Promise<void> {
  try {
    await stop(finding);
  } catch (error) {
    logger.warn(
      `token-economizer learnings: stop not recorded (${
        oneLine(errorText(error))
      })`,
    );
  }
}

/** Repositories other than `key` that the home holds state for. */
async function foreignRepos(home: string, key: string): Promise<string[]> {
  const names: string[] = [];
  try {
    for await (const entry of Deno.readDir(join(home, "repos"))) {
      if (entry.name !== key) names.push(entry.name);
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  return names.sort();
}

/**
 * Whether `storeDir` is its own clone: its `.git` is a real directory (not a
 * symlink), and git's top level for it is `storeDir` itself. Without this a
 * removed clone would resolve to an enclosing repository. Anything that cannot
 * be verified is not a clone.
 */
async function isOwnClone(storeDir: string): Promise<boolean> {
  try {
    const info = await Deno.lstat(join(storeDir, ".git"));
    if (info.isSymlink || !info.isDirectory) return false;
  } catch {
    return false;
  }
  const top = await git(["-C", storeDir, "rev-parse", "--show-toplevel"]);
  if (top.code !== 0) return false;
  try {
    const [fromGit, own] = await Promise.all([
      Deno.realPath(top.stdout.trim()),
      Deno.realPath(storeDir),
    ]);
    return fromGit === own;
  } catch {
    return false;
  }
}

/** The default scan: gitleaks over the staged files, bounded by a deadline. */
function defaultScanStaged(cwd: string): Promise<StagedScan> {
  return spawnWithDeadline(
    "gitleaks",
    [
      "git",
      "--staged",
      "--redact",
      "--no-banner",
      "--exit-code",
      "1",
      "--no-color",
      "--report-format",
      "json",
      "--report-path",
      "-",
      ".",
    ],
    cwd,
    SCAN_DEADLINE_MS,
  );
}

/**
 * Judge a staged scan. Clean is exit 0 with an empty JSON report. A finding is
 * exit 1 with a readable report. Anything else (a timeout, a missing binary, an
 * unreadable report) fails closed.
 */
function judgeScan(run: StagedScan): ScanVerdict {
  if (run.timedOut === true) {
    return { kind: "fault", cause: "scan exceeded its deadline" };
  }
  const findings = parseReport(run.stdout);
  if (run.exitCode === 0 && findings !== null && findings.length === 0) {
    return { kind: "clean" };
  }
  if (run.exitCode === 1 && findings !== null && findings.length > 0) {
    return { kind: "leaks", reason: leakReason(findings) };
  }
  return {
    kind: "fault",
    cause: `gitleaks exited ${run.exitCode} without a readable report`,
  };
}

/** The rule and file of the first finding. The secret value is never included. */
function leakReason(findings: ReportFinding[]): string {
  const first = findings[0];
  const more = findings.length > 1 ? ` (and ${findings.length - 1} more)` : "";
  return `gitleaks rule ${first?.rule ?? "(unknown rule)"} in ${
    first?.file ?? "(unknown file)"
  }${more}`;
}

/** The state a push carries between its stages. */
interface PushContext {
  opts: PushLearningsOptions;
  logger: LearningsLogger;
  storeDir: string;
  repoKey: string;
}

/** Whether a push was rejected as a non-fast-forward, as opposed to failing. */
function isRejectedNonFastForward(run: GitRun): boolean {
  return /\[rejected\]/.test(run.stderr) &&
    /\((fetch first|non-fast-forward)\)/.test(run.stderr);
}

/**
 * Stage, scan and commit whatever is staged in the scratch clone. Nothing staged
 * is `unchanged`. A finding is stopped and a scanner fault is skipped; neither
 * is committed.
 */
async function commitStaged(
  ctx: PushContext,
): Promise<{ kind: "committed"; commit: string } | PushLearningsOutcome> {
  const { opts, logger, storeDir, repoKey } = ctx;
  const diff = await git(["-C", storeDir, "diff", "--cached", "--quiet"]);
  if (diff.code === 0) return { kind: "unchanged" };
  if (diff.code !== 1) {
    return skip(logger, `git diff failed: ${causeOf(diff)}`);
  }

  let run: StagedScan;
  try {
    run = await (opts.scanStaged ?? defaultScanStaged)(storeDir);
  } catch (error) {
    return skip(logger, `scanner fault: ${oneLine(errorText(error))}`);
  }
  const verdict = judgeScan(run);
  if (verdict.kind === "fault") {
    return skip(logger, `scanner fault: ${verdict.cause}`);
  }
  if (verdict.kind === "leaks") {
    await reportStop(opts.stop, {
      rule: "secret-in-learnings",
      reason: verdict.reason,
    }, logger);
    logger.warn(
      `token-economizer learnings: stopped (secret-in-learnings): ${
        oneLine(verdict.reason)
      }`,
    );
    return {
      kind: "stopped",
      rule: "secret-in-learnings",
      reason: oneLine(verdict.reason),
    };
  }

  const message =
    `token-economizer: learnings for ${repoKey} from ${opts.subject}\n\nVibe-Coder-Run-Id: ${opts.runId}`;
  const commit = await git([
    "-C",
    storeDir,
    ...COMMIT_IDENTITY,
    "commit",
    "--quiet",
    "-m",
    message,
  ]);
  if (commit.code !== 0) {
    return skip(logger, `git commit failed: ${causeOf(commit)}`);
  }
  const head = await git(["-C", storeDir, "rev-parse", "HEAD"]);
  if (head.code !== 0) {
    return skip(logger, `git rev-parse failed: ${causeOf(head)}`);
  }
  return { kind: "committed", commit: head.stdout.trim() };
}

/**
 * The latch and visibility, checked fresh before each push attempt. A latched
 * trial is skipped; a store that is not private is refused. Returns null when
 * the transfer may proceed.
 */
async function transferBlocked(
  opts: PushLearningsOptions,
  logger: LearningsLogger,
): Promise<PushLearningsOutcome | null> {
  if (!(await opts.mayTransfer())) {
    return skip(logger, "trial stop latched: transfer is not permitted");
  }
  const verdict = await verifyPrivate(
    opts.checkVisibility ?? githubVisibilityCheck(),
    opts.learningsRepo,
  );
  if (verdict.private !== true) return refuse(logger, verdict.reason);
  return null;
}

/**
 * Retry a rejected push once: fetch the tip, reset to it, and replay our commit
 * with cherry-pick. A conflict drops this run's update, which keeps the other
 * run's content on the store.
 */
async function replayOnTip(
  ctx: PushContext,
  ours: string,
  branch: string,
): Promise<PushLearningsOutcome> {
  const { opts, logger, storeDir, repoKey } = ctx;
  const fetched = await git(
    ["-C", storeDir, "fetch", "--depth=1", "origin", branch],
    LEARNINGS_GIT_TIMEOUT_SECONDS,
  );
  if (fetched.code !== 0) {
    return drop(logger, `fetch for replay failed: ${causeOf(fetched)}`);
  }
  const reset = await git(["-C", storeDir, "reset", "--hard", "FETCH_HEAD"]);
  if (reset.code !== 0) {
    return drop(logger, `reset to the tip failed: ${causeOf(reset)}`);
  }
  const pick = await git([
    "-C",
    storeDir,
    "cherry-pick",
    "--no-commit",
    ours,
  ]);
  if (pick.code !== 0) {
    await git(["-C", storeDir, "reset", "--hard"]);
    const conflicted = /CONFLICT/.test(`${pick.stdout}\n${pick.stderr}`);
    return drop(
      logger,
      conflicted
        ? `later run's update dropped: it conflicts with an update already pushed to ${LEARNINGS_STORE_ROOT}/${repoKey}`
        : `replay failed: ${causeOf(pick)}`,
    );
  }

  const replayed = await walkKeyRoot(
    join(storeDir, LEARNINGS_STORE_ROOT, repoKey),
  );
  const bytes = totalBytes(replayed.files);
  if (bytes > LEARNINGS_KEY_CAP_BYTES) {
    return skip(
      logger,
      `learnings for ${repoKey} exceed the ${LEARNINGS_KEY_CAP_BYTES}-byte cap after the replay`,
    );
  }
  const committed = await commitStaged(ctx);
  if (committed.kind !== "committed") return committed;

  const blocked = await transferBlocked(opts, logger);
  if (blocked !== null) return blocked;
  const second = await git(
    ["-C", storeDir, "push", "origin", `HEAD:refs/heads/${branch}`],
    LEARNINGS_GIT_TIMEOUT_SECONDS,
  );
  if (second.code === 0) return { kind: "pushed", commit: committed.commit };
  return drop(logger, `push failed after the replay: ${causeOf(second)}`);
}

/** The push itself: verified state is mirrored, scanned, committed and pushed once. */
async function pushVerified(
  opts: PushLearningsOptions,
  logger: LearningsLogger,
): Promise<PushLearningsOutcome> {
  const { persistence } = opts;
  const { repoKey, storeDir } = persistence;
  if (
    (persistence.status !== "restored" && persistence.status !== "empty") ||
    repoKey === undefined || storeDir === undefined
  ) {
    return skip(
      logger,
      `no verified store from the pull (${persistence.status})`,
    );
  }
  if (!isSafeKey(repoKey)) return skip(logger, "invalid repository key");

  // Isolation: state for another repository in the home is a finding, and nothing moves.
  const foreign = await foreignRepos(opts.home, repoKey);
  if (foreign.length > 0) {
    const reason = `learnings home holds state for another repository (${
      foreign.join(", ")
    }) alongside ${repoKey}`;
    await reportStop(opts.stop, { rule: "cross-repo-fact", reason }, logger);
    logger.warn(
      `token-economizer learnings: stopped (cross-repo-fact): ${
        oneLine(reason)
      }`,
    );
    return {
      kind: "stopped",
      rule: "cross-repo-fact",
      reason: oneLine(reason),
    };
  }

  const keyRoot = join(opts.home, "repos", repoKey);
  const local = await walkKeyRoot(keyRoot);
  const bytes = totalBytes(local.files);
  if (bytes > LEARNINGS_KEY_CAP_BYTES) {
    return skip(
      logger,
      `learnings for ${repoKey} are ${bytes} bytes, over the ${LEARNINGS_KEY_CAP_BYTES}-byte cap`,
    );
  }

  // The clone must be its own repository before anything is written under it.
  if (!(await isOwnClone(storeDir))) {
    return skip(
      logger,
      "store clone is gone; this spawn's learnings are discarded",
    );
  }

  // Mirror: the store's copy of this key becomes exactly the local allow-listed state.
  const storeKey = join(storeDir, LEARNINGS_STORE_ROOT, repoKey);
  await removeIfPresent(storeKey);
  for (const file of local.files) {
    await writeState(
      join(storeKey, ...file.segments),
      await Deno.readFile(join(keyRoot, ...file.segments)),
    );
  }
  const add = await git([
    "-C",
    storeDir,
    "add",
    "-A",
    "--",
    `${LEARNINGS_STORE_ROOT}/${repoKey}`,
  ]);
  // `add` matches nothing when neither the store nor the home has the key; that is no change.
  if (add.code !== 0 && await exists(storeKey)) {
    return skip(logger, `git add failed: ${causeOf(add)}`);
  }

  const ctx: PushContext = { opts, logger, storeDir, repoKey };
  const committed = await commitStaged(ctx);
  if (committed.kind !== "committed") return committed;

  const branchRun = await git([
    "-C",
    storeDir,
    "symbolic-ref",
    "--short",
    "HEAD",
  ]);
  if (branchRun.code !== 0) {
    return drop(logger, `no branch to push: ${causeOf(branchRun)}`);
  }
  const branch = branchRun.stdout.trim();

  const blocked = await transferBlocked(opts, logger);
  if (blocked !== null) return blocked;
  const first = await git(
    ["-C", storeDir, "push", "origin", `HEAD:refs/heads/${branch}`],
    LEARNINGS_GIT_TIMEOUT_SECONDS,
  );
  if (first.code === 0) return { kind: "pushed", commit: committed.commit };
  if (!isRejectedNonFastForward(first)) {
    return drop(logger, `push failed: ${causeOf(first)}`);
  }
  return await replayOnTip(ctx, committed.commit, branch);
}

/**
 * Push this run's learnings to the store. Never throws. The scratch clone the
 * caller passed is kept after `pushed` and `unchanged`, because it is clean and
 * at the store tip, so a later spawn of the same run can push again with the
 * same persistence. Every other outcome removes it: local state is discarded.
 */
export async function pushLearnings(
  opts: PushLearningsOptions,
): Promise<PushLearningsOutcome> {
  const logger = opts.logger ?? defaultLogger;
  const storeDir = opts.persistence.storeDir;
  let outcome: PushLearningsOutcome;
  try {
    outcome = await pushVerified(opts, logger);
  } catch (error) {
    outcome = error instanceof LearningsFault
      ? skip(logger, error.message)
      : drop(logger, `unexpected error: ${errorText(error)}`);
  }
  const keep = outcome.kind === "pushed" || outcome.kind === "unchanged";
  if (storeDir !== undefined && !keep) await removeScratch(storeDir, logger);
  return outcome;
}
