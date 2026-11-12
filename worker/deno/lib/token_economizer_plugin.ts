/**
 * TokenEconomizer plugin launch decision (Issue #4956, part of #4953).
 *
 * This module decides whether one Claude run loads the vendored Microsoft
 * TokenEconomizer Claude Code plugin (`--plugin-dir`) and, if so, with which
 * environment. It covers the implementation, PR-feedback and CI-fix runs only.
 * Reviewer and verifier calls are deliberately not run kinds: their cost would
 * confound the trial, and learned facts must not steer them.
 *
 * The plugin is installed in the container at {@link TOKEN_ECONOMIZER_PLUGIN_DIR}
 * at a pinned checksum. Wiring the result into `agent_provider.ts` and
 * `claude_runner.ts` is done elsewhere; this module only decides and builds.
 *
 * ## Fail-open for the run, fail-closed for the plugin
 *
 * {@link resolveTokenEconomizerLaunch} never throws. A plugin fault must never
 * fail a run, so every refusal (and any unexpected error) returns `null`, which
 * the caller reads as "plugin off". The plugin is then simply not loaded.
 * Refusals are logged with the cause, except a disabled block, which is silent.
 *
 * ## Micro-skills are clamped to environment facts
 *
 * {@link effectiveMicroskills} lets only the `envfacts` mechanism inject. The
 * upstream plugin injects learned facts as plain bullet lines under a header,
 * with no data fencing, and the distiller's facts are free model-written text.
 * The audited executable selected by TE_PYTHON fences the pinned plugin's
 * output with the worker's shared untrusted-text boundary and rejects excessive
 * context or facts. The archive is unchanged. Distillation stays disabled:
 * its free model-written proposals are not independently capped upstream.
 *
 * ## Stop record
 *
 * The shared controller consumes hook failures and exposes the finding/sync
 * contract for persistence (#4957). It latches `${workDir}/.token-economizer/stop.json`,
 * reports to #4959 through the worker's guarded channel and retries pending
 * reports on later enabled launches. A healthy run never clears a trial failure;
 * only authorised recovery or purge may do that. Unreadable records fail closed.
 * This local file is not a security boundary against a same-UID agent.
 *
 * ## Path confinement
 *
 * The per-spawn state directory is `${workDir}/.token-economizer/runs/<runId>`,
 * where `<runId>` is the caller's run id or a fresh UUID. The path is normalised
 * and its existing prefix canonicalised before creation. It must lie under the
 * real work directory and outside the repo checkout; the created path is checked
 * again before being used.
 *
 * Uses Australian English throughout (behaviour, recognised, organisation).
 */

import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  TOKEN_ECONOMIZER_MICROSKILLS_MAX_FACTS,
  TOKEN_ECONOMIZER_MICROSKILLS_MAX_TOKENS,
} from "./token_economizer_hook.ts";
export {
  TOKEN_ECONOMIZER_MICROSKILLS_MAX_FACTS,
  TOKEN_ECONOMIZER_MICROSKILLS_MAX_TOKENS,
} from "./token_economizer_hook.ts";
import type {
  TokenEconomizerConfig,
  TokenEconomizerMicroskills,
} from "../types.ts";
import { reportTokenEconomizerStop } from "./token_economizer_control.ts";
import { confinePath } from "./mutation_runner.ts";
import { repoCheckoutPath } from "./repo_checkout_path.ts";
import { redactSecrets } from "./secret_redaction.ts";

/** The vendored TokenEconomizer plugin, as installed in the container. */
export const TOKEN_ECONOMIZER_PLUGIN_DIR = "/opt/tokeneconomizer/plugin";

/** The runs that may load the plugin. Reviewer and verifier calls are not among them. */
export type TokenEconomizerRunKind =
  | "implementation"
  | "pr-feedback"
  | "ci-fix";

/** Every run kind that may load the plugin. */
export const TOKEN_ECONOMIZER_RUN_KINDS: readonly TokenEconomizerRunKind[] = [
  "implementation",
  "pr-feedback",
  "ci-fix",
];

/** The audited executable selected by the upstream launcher's TE_PYTHON interface. */
export const TOKEN_ECONOMIZER_HOOK_ADAPTER = fileURLToPath(
  new URL("./token_economizer_hook.ts", import.meta.url),
);

/** A launch the caller hands to `--plugin-dir` and the spawn environment. */
export interface TokenEconomizerLaunch {
  readonly pluginDir: string;
  /** Worker-owned root for the shared stop controller; never inferred from plugin output. */
  readonly workDir: string;
  readonly env: Readonly<
    Record<string, string> & { TOKENECONOMIZER_HOME: string }
  >;
}

/**
 * The only environment keys a launch may carry. {@link overlayTokenEconomizerEnv}
 * copies these and nothing else, so the overlay can never touch `PATH` or a
 * credential.
 */
export const TOKEN_ECONOMIZER_ENV_KEYS: readonly string[] = [
  "TOKENECONOMIZER_HOME",
  "TE_TOOLPRUNE",
  "TE_REPOMAP",
  "TE_HISTORY_IMPORT",
  "TE_MICROSKILLS",
  "TE_LOOPGUARD",
  "TE_MICROSKILLS_MAX_FACTS",
  "TE_MICROSKILLS_MAX_TOKENS",
  "TE_PYTHON",
];

/** The causes that durably stop the plugin. `unreadable-stop-record` is never recorded; it is reported on read. */
export type TokenEconomizerStopRule =
  | "secret-in-learnings"
  | "cross-repo-fact"
  | "plugin-run-failure"
  | "unreadable-stop-record";

/** A recorded stop. The `reason` is redacted, single-line and at most 300 characters. */
export interface TokenEconomizerStop {
  rule: TokenEconomizerStopRule;
  reason: string;
  /** ISO 8601 timestamp of when the stop was recorded. */
  recordedAt: string;
}

/** Options for {@link resolveTokenEconomizerLaunch}. */
export interface ResolveTokenEconomizerLaunchOptions {
  config: TokenEconomizerConfig;
  workDir: string;
  repo: string;
  runKind: TokenEconomizerRunKind;
  /** Names the state directory. Must pass the allow-list. Absent: a fresh UUID per launch. */
  runId?: string;
  pluginDir?: string;
  /** Audited worker executable; override only for isolated launch validation. */
  hookAdapterPath?: string;
  /** Guarded worker notification channel; injectable for offline validation. */
  notifyStop?: (args: string[]) => Promise<string>;
  logger?: {
    info(m: string, c?: Record<string, unknown>): void;
    warn(m: string, c?: Record<string, unknown>): void;
  };
}

/** The directory under the work directory that holds the stop record and the per-run state. */
const STATE_DIR_NAME = ".token-economizer";
/** The stop record file name inside the state directory. */
const STOP_FILE_NAME = "stop.json";
/** Stop rules a finding may record. `unreadable-stop-record` is excluded. */
const FINDABLE_STOP_RULES: readonly TokenEconomizerStopRule[] = [
  "secret-in-learnings",
  "cross-repo-fact",
  "plugin-run-failure",
];
/** Longest stop reason kept on disk, in characters. */
const STOP_REASON_MAX_CHARS = 300;
/** The run id allow-list: letters, digits, dots, underscores and hyphens, 1 to 80 characters. */
const RUN_ID_PATTERN = /^[A-Za-z0-9._-]{1,80}$/;
/** The manifest a usable plugin directory carries. */
const PLUGIN_MANIFEST_PATH = [".claude-plugin", "plugin.json"];
/** The micro-skills fact cap the plugin is launched with, as a string. */
const MAX_FACTS_ENV = String(TOKEN_ECONOMIZER_MICROSKILLS_MAX_FACTS);
/** The micro-skills token cap the plugin is launched with, as a string. */
const MAX_TOKENS_ENV = String(TOKEN_ECONOMIZER_MICROSKILLS_MAX_TOKENS);

/**
 * The micro-skills value the plugin is launched with. `off` stays `off`; the
 * other three configured values all give `envfacts`.
 *
 * Only the mechanical environment-facts mechanism may inject. The adapter
 * fences its output; the distiller's uncapped proposals remain disabled.
 *
 * @param configured - The `microskills` value from the `token_economizer` block.
 * @returns `off`, or `envfacts` for any other configured value.
 */
export function effectiveMicroskills(
  configured: TokenEconomizerMicroskills,
): "off" | "envfacts" {
  return configured === "off" ? "off" : "envfacts";
}

/**
 * Copy the allow-listed TokenEconomizer keys from a launch into a spawn
 * environment. Keys outside {@link TOKEN_ECONOMIZER_ENV_KEYS} are ignored, so a
 * launch can never set `PATH` or a credential.
 *
 * First, every `TE_` and `TOKENECONOMIZER_` key already in `baseEnv` is deleted,
 * so a stray value in the worker's own environment (a `TE_DISABLE` or a
 * `TE_LOOPGUARD_NUDGES`, say) cannot steer the plugin. Only the launch's own
 * allow-listed keys survive under those prefixes.
 *
 * @param baseEnv - The environment the agent will be spawned with. Mutated in place.
 * @param launch - The launch whose env is copied.
 */
export function overlayTokenEconomizerEnv(
  baseEnv: Record<string, string>,
  launch: TokenEconomizerLaunch,
): void {
  for (const key of Object.keys(baseEnv)) {
    if (key.startsWith("TE_") || key.startsWith("TOKENECONOMIZER_")) {
      delete baseEnv[key];
    }
  }
  for (const key of TOKEN_ECONOMIZER_ENV_KEYS) {
    const value = Object.hasOwn(launch.env, key) ? launch.env[key] : undefined;
    if (value !== undefined) baseEnv[key] = value;
  }
}

/**
 * The durable stop record's path: `${workDir}/.token-economizer/stop.json`.
 *
 * @param workDir - The parent work directory that holds the clones.
 * @returns The path of the stop record.
 */
export function tokenEconomizerStatePath(workDir: string): string {
  return join(workDir, STATE_DIR_NAME, STOP_FILE_NAME);
}

/** Resolve the fixed controller directory without allowing a symlink alias. */
export async function tokenEconomizerControlDirectory(
  workDir: string,
): Promise<string> {
  const work = await Deno.realPath(resolve(workDir));
  const directory = await confinePath(work, STATE_DIR_NAME, {
    realPath: Deno.realPath,
  });
  if (directory !== join(work, STATE_DIR_NAME)) {
    throw new Error(
      "TokenEconomizer controller directory is aliased or outside the work root",
    );
  }
  return directory;
}

/**
 * Record a durable stop until authorised recovery or purge. An existing valid
 * or unreadable latch is preserved. Atomic hard-link creation makes the first
 * writer win even across concurrent lanes; readers never see a partial record.
 * Reasons are redacted, single-line and capped at 300 characters. Persistence
 * uses stopTokenEconomizerTrial in token_economizer_control.ts to report as well.
 *
 * @param workDir - The parent work directory that holds the clones.
 * @param finding - The rule that tripped, and the human-readable reason.
 * @param now - Clock for the `recordedAt` stamp; injectable for tests.
 * @returns The stop that is now in force: the new one, or the existing one.
 * @throws If `finding.rule` is not a rule a finding may record.
 */
export async function recordTokenEconomizerStop(
  workDir: string,
  finding: {
    rule: Exclude<TokenEconomizerStopRule, "unreadable-stop-record">;
    reason: string;
  },
  now: () => Date = () => new Date(),
): Promise<TokenEconomizerStop> {
  if (!isFindableStopRule(finding.rule)) {
    throw new Error(
      `unknown TokenEconomizer stop rule "${
        String(finding.rule)
      }": a finding ` +
        `may record only ${FINDABLE_STOP_RULES.join(", ")}`,
    );
  }
  const stateDir = await tokenEconomizerControlDirectory(workDir);
  const existing = await readStopFile(workDir);
  if (existing.kind === "ok") return existing.stop;
  if (existing.kind === "bad") return (await readTokenEconomizerStop(workDir))!;

  const stop: TokenEconomizerStop = {
    rule: finding.rule,
    reason: storedStopReason(finding.reason),
    recordedAt: now().toISOString(),
  };
  const path = tokenEconomizerStatePath(workDir);
  await Deno.mkdir(stateDir, { recursive: true, mode: 0o700 });
  const temp = await Deno.makeTempFile({ dir: stateDir, prefix: ".stop-" });
  try {
    await Deno.writeTextFile(temp, `${JSON.stringify(stop)}\n`, {
      mode: 0o600,
    });
    try {
      // Atomic create without replacement: two lanes cannot overwrite the first finding.
      await Deno.link(temp, path);
    } catch (error) {
      if (!(error instanceof Deno.errors.AlreadyExists)) throw error;
      const winner = await readTokenEconomizerStop(workDir);
      if (winner === null) {
        throw new Error("TokenEconomizer stop disappeared during recording");
      }
      return winner;
    }
  } finally {
    await Deno.remove(temp);
  }
  return stop;
}

/**
 * Read the durable stop record.
 *
 * A missing file is `null`: nothing has stopped the plugin. Any other state
 * fails closed: a file that cannot be read, cannot be parsed, or carries an
 * unknown rule comes back as an `unreadable-stop-record` stop, so the plugin
 * stays off. It is never read as `null`.
 *
 * @param workDir - The parent work directory that holds the clones.
 * @returns The stop in force, or `null` when there is no stop record.
 */
export async function readTokenEconomizerStop(
  workDir: string,
): Promise<TokenEconomizerStop | null> {
  const read = await readStopFile(workDir);
  if (read.kind === "missing") return null;
  if (read.kind === "ok") return read.stop;
  return {
    rule: "unreadable-stop-record",
    reason: storedStopReason(read.cause),
    recordedAt: new Date().toISOString(),
  };
}

/**
 * Decide whether one run loads the TokenEconomizer plugin, and with which
 * environment.
 *
 * Checks run in this order, and the first refusal wins: disabled block (silent),
 * stop record, run kind, plugin manifest, run id, state directory. Any refusal
 * or unexpected error returns `null` and logs the cause. A plugin fault never
 * fails the run.
 *
 * @param opts - The block, the work directory, the repo, the run kind and the
 *   optional run id, plugin directory and logger. With no run id, each launch
 *   gets a fresh UUID, so every spawn has its own state directory.
 * @returns The launch to hand to `--plugin-dir`, or `null` for plugin off.
 */
export async function resolveTokenEconomizerLaunch(
  opts: ResolveTokenEconomizerLaunchOptions,
): Promise<TokenEconomizerLaunch | null> {
  const { config, workDir, repo, runKind, logger } = opts;
  if (!config.enabled) return null;
  try {
    const stop = await readTokenEconomizerStop(workDir);
    if (stop !== null) {
      await reportTokenEconomizerStop(workDir, stop, opts.notifyStop, logger);
      logger?.warn(
        `token-economizer: plugin off, stop record in force (rule ${stop.rule}): ${
          redactSecrets(stop.reason)
        }`,
      );
      return null;
    }

    if (!(TOKEN_ECONOMIZER_RUN_KINDS as readonly string[]).includes(runKind)) {
      logger?.warn(
        `token-economizer: plugin off, run kind "${String(runKind)}" is not ` +
          `one of ${TOKEN_ECONOMIZER_RUN_KINDS.join(", ")}`,
      );
      return null;
    }

    const pluginDir = opts.pluginDir ?? TOKEN_ECONOMIZER_PLUGIN_DIR;
    const manifest = join(pluginDir, ...PLUGIN_MANIFEST_PATH);
    if (!(await isFile(manifest))) {
      logger?.warn(
        `token-economizer: plugin off, plugin manifest missing at ${manifest}`,
      );
      return null;
    }

    const adapter = opts.hookAdapterPath ?? TOKEN_ECONOMIZER_HOOK_ADAPTER;
    const adapterInfo = await Deno.stat(adapter);
    if (
      !adapterInfo.isFile ||
      (adapterInfo.mode !== null && (adapterInfo.mode & 0o111) === 0)
    ) {
      logger?.warn(
        "token-economizer: plugin off, audited hook adapter is not executable",
      );
      return null;
    }

    const runId = opts.runId ?? crypto.randomUUID();
    if (!isSafeRunId(runId)) {
      logger?.warn(
        `token-economizer: plugin off, run id fails the allow-list ` +
          `${RUN_ID_PATTERN.source} or is "." or ".."`,
      );
      return null;
    }

    // Check the canonical destination before mkdir: a refusal must not write
    // through a symlink into the checkout or another repository.
    const work = resolve(workDir);
    let realWork: string;
    try {
      realWork = await Deno.realPath(work);
    } catch (err) {
      logger?.warn(
        `token-economizer: plugin off, per-run state directory cannot be created: ${
          errorMessage(err)
        }`,
      );
      return null;
    }
    const stateDir = await confinePath(
      realWork,
      join(STATE_DIR_NAME, "runs", runId),
      { realPath: Deno.realPath },
    );
    if (stateDir === null) {
      logger?.warn(
        "token-economizer: plugin off, per-run state directory lies outside the work directory",
      );
      return null;
    }
    const checkout = await canonicalOrNormalised(
      resolve(repoCheckoutPath(realWork, repo)),
    );
    if (isWithin(stateDir, checkout)) {
      logger?.warn(
        "token-economizer: plugin off, per-run state directory lies inside the repo checkout",
      );
      return null;
    }
    if (stateDir !== join(realWork, STATE_DIR_NAME, "runs", runId)) {
      logger?.warn(
        "token-economizer: plugin off, per-run state directory is aliased",
      );
      return null;
    }
    try {
      await Deno.mkdir(stateDir, { recursive: true, mode: 0o700 });
    } catch (err) {
      logger?.warn(
        `token-economizer: plugin off, per-run state directory cannot be created: ${
          errorMessage(err)
        }`,
      );
      return null;
    }
    const realState = await Deno.realPath(stateDir);
    if (realState !== stateDir) {
      throw new Error("state directory changed during launch");
    }

    logger?.info(`token-economizer: plugin on for a ${runKind} run`);
    return {
      pluginDir,
      workDir: realWork,
      env: {
        TOKENECONOMIZER_HOME: realState,
        TE_TOOLPRUNE: "off",
        TE_REPOMAP: "off",
        TE_HISTORY_IMPORT: "false",
        TE_MICROSKILLS: effectiveMicroskills(config.microskills),
        TE_LOOPGUARD: config.loopguard,
        TE_MICROSKILLS_MAX_FACTS: MAX_FACTS_ENV,
        TE_MICROSKILLS_MAX_TOKENS: MAX_TOKENS_ENV,
        TE_PYTHON: adapter,
      },
    };
  } catch (err) {
    logger?.warn(
      `token-economizer: plugin off, launch failed: ${
        redactSecrets(errorMessage(err))
      }`,
    );
    return null;
  }
}

/**
 * Spread-ready options for `runClaude`: the launch when the plugin is on, and
 * nothing when it is off.
 *
 * @param opts - The same options as {@link resolveTokenEconomizerLaunch}.
 * @returns `{ tokenEconomizer }` when a launch resolves, otherwise `{}`.
 */
export async function tokenEconomizerSpawnOptions(
  opts: ResolveTokenEconomizerLaunchOptions,
): Promise<{ tokenEconomizer?: TokenEconomizerLaunch }> {
  const launch = await resolveTokenEconomizerLaunch(opts);
  return launch === null ? {} : { tokenEconomizer: launch };
}

/** Result of reading the stop record file, before it is judged. */
type StopFileRead =
  | { kind: "missing" }
  | { kind: "ok"; stop: TokenEconomizerStop }
  | { kind: "bad"; cause: string };

/**
 * Read and validate the stop record file. Only a missing file (`ENOENT`) is
 * `missing`. Every other problem is `bad`, with a short cause.
 */
async function readStopFile(workDir: string): Promise<StopFileRead> {
  const path = tokenEconomizerStatePath(workDir);
  let text: string;
  try {
    if ((await Deno.stat(path)).size > 4096) {
      return { kind: "bad", cause: "stop record exceeds its size limit" };
    }
    text = await Deno.readTextFile(path);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return { kind: "missing" };
    return { kind: "bad", cause: `cannot read ${path}: ${errorMessage(err)}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { kind: "bad", cause: `cannot parse ${path}: ${errorMessage(err)}` };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { kind: "bad", cause: `${path} is not a JSON object` };
  }
  const record = parsed as Record<string, unknown>;
  if (!isFindableStopRule(record.rule)) {
    return { kind: "bad", cause: `${path} carries an unknown stop rule` };
  }
  if (
    typeof record.reason !== "string" ||
    [...record.reason].length > STOP_REASON_MAX_CHARS
  ) {
    return { kind: "bad", cause: `${path} has no string reason` };
  }
  if (
    typeof record.recordedAt !== "string" ||
    !Number.isFinite(Date.parse(record.recordedAt))
  ) {
    return { kind: "bad", cause: `${path} has no string recordedAt` };
  }
  return {
    kind: "ok",
    stop: {
      rule: record.rule,
      reason: storedStopReason(record.reason),
      recordedAt: record.recordedAt,
    },
  };
}

/** Whether `rule` is one a finding may record. */
function isFindableStopRule(
  rule: unknown,
): rule is Exclude<TokenEconomizerStopRule, "unreadable-stop-record"> {
  return typeof rule === "string" &&
    (FINDABLE_STOP_RULES as readonly string[]).includes(rule);
}

/**
 * Redact a stop reason, collapse its line breaks to spaces and cut it to 300
 * characters. Redaction runs first, so a token is masked whole.
 */
function storedStopReason(reason: string): string {
  const redacted = redactSecrets(reason).replace(/[\r\n]+/g, " ");
  return [...redacted].slice(0, STOP_REASON_MAX_CHARS).join("");
}

/** Whether a run id passes the allow-list and is not a relative path segment. */
function isSafeRunId(runId: string): boolean {
  return RUN_ID_PATTERN.test(runId) && runId !== "." && runId !== "..";
}

/**
 * Whether `child` is `parent` or lies beneath it. Compared by path segment,
 * never by string prefix, so `/work-other` is not under `/work`.
 */
function isWithin(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  if (rel === "") return true;
  if (isAbsolute(rel)) return false;
  return rel.split(sep)[0] !== "..";
}

/**
 * The real path of `path` when it exists, otherwise the normalised path. Other
 * errors are not swallowed.
 */
async function canonicalOrNormalised(path: string): Promise<string> {
  try {
    return await Deno.realPath(path);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return path;
    throw err;
  }
}

/** Whether `path` exists and is a regular file. Any error counts as not a file. */
async function isFile(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isFile;
  } catch {
    return false;
  }
}

/** The message of an unknown thrown value. */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
