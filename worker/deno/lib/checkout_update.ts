/**
 * Host-side worker-checkout update and its crash-loop escalation
 * (Issues #512, #513, #4204).
 *
 * The worker checkout used to be updated from *inside* the container by the
 * bootstrap prelude's git reset, which made the in-container process the last
 * intentional writer to `/workspace` and forced that mount to stay read-write.
 * Issue #512 moved the update to the host; Issue #513 retired the in-container
 * reset and brought its consecutive-failure escalation across with it — the
 * diagnosis ("active development tree"), the streak file and the control-plane
 * escalation are all about the *checkout*, so they live beside the code that
 * now updates it.
 *
 * {@link updateCheckout} performs the update sequence — `git fetch origin` →
 * `git checkout <branch>` → `git reset --hard origin/<branch>` →
 * `git clean -fd` — and, on failure, enriches the error, counts the streak in
 * `<logDir>/checkout-update-failure-streak`, and raises exactly one GitHub
 * issue per streak once {@link CHECKOUT_UPDATE_ESCALATION_THRESHOLD}
 * consecutive failures are reached. A success resets the streak to zero.
 *
 * Every side effect flows through {@link CheckoutUpdateDeps} so the behaviour
 * can be unit-tested without touching git, the filesystem, or GitHub.
 *
 * Australian English spelling throughout (behaviour, organisation, authorised).
 */

import type { Result } from "../types.ts";
import { runGitCommand } from "./git_timeout.ts";
import {
  appendRunCoreLogLine,
  resolveOriginDefaultBranch,
} from "./run_bootstrap.ts";
import { spawnGh } from "./gh_spawn.ts";
import { GH_RUNTIME_CONFIG_SUFFIX } from "./credential_preflight.ts";

/**
 * Consecutive update failures before the host escalates through the control
 * plane (Issue #4204). One transient blip stays a log line; a crash-loop
 * becomes a GitHub issue the operator actually sees — the observed failure
 * mode was a worker silently running week-old code because its checkout was
 * occupied by interactive development work.
 */
export const CHECKOUT_UPDATE_ESCALATION_THRESHOLD = 3;

/** File under the log directory persisting the consecutive-failure count. */
export const CHECKOUT_UPDATE_FAILURE_STREAK_FILE =
  "checkout-update-failure-streak";

/** What the worker checkout looks like, for collision diagnosis (#4204). */
export interface CheckoutState {
  /** Currently checked-out branch (or `HEAD` when detached). */
  branch: string;
  /** Number of uncommitted paths reported by `git status --porcelain`. */
  dirtyFiles: number;
}

/** Everything the escalation hook needs to name the failure (#4204). */
export interface CheckoutUpdateEscalationContext {
  /** The worker checkout that could not be updated. */
  repoDir: string;
  /** Worker log directory (for any escalation-side logging). */
  logDir: string;
  /** Consecutive failures, including this one. */
  streak: number;
  /** The enriched failure detail. */
  error: string;
  /** Checkout state at failure time, when it could be read. */
  checkout: CheckoutState | null;
}

/** Inputs to a single checkout update. */
export interface CheckoutUpdateOptions {
  /** The checkout to update. */
  repoDir: string;
  /** Directory holding worker logs (`pull.log`, `run_core.log`, the streak). */
  logDir: string;
  /**
   * Branch to update to. Omitted, it is resolved from the checkout's own
   * `origin/HEAD` (see {@link resolveOriginDefaultBranch}).
   */
  defaultBranch?: string;
}

/** Outcome of a single checkout update. */
export interface CheckoutUpdateOutcome {
  /** Whether the checkout now matches `origin/<branch>`. */
  ok: boolean;
  /** The branch updated to, or "" when it could not be resolved. */
  branch: string;
  /** Enriched failure detail when {@link ok} is false. */
  error?: string;
  /** Consecutive failures including this one; 0 after a success. */
  streak: number;
  /** Whether this failure raised the control-plane escalation. */
  escalated: boolean;
}

/** Injectable side effects, so the behaviour is testable end to end. */
export interface CheckoutUpdateDeps {
  /** Resolve the checkout's default branch from `origin/HEAD`. */
  resolveDefaultBranch(repoDir: string): Promise<Result<string>>;
  /** Update the checkout to `origin/<branch>`; fail-loud on any git failure. */
  resetToDefaultBranch(
    repoDir: string,
    branch: string,
    logDir: string,
  ): Promise<Result<void>>;
  /**
   * Describe the checkout for collision diagnosis (Issue #4204). Best-effort:
   * `null` when the state cannot be read — diagnosis is enrichment, never a
   * new failure mode.
   */
  describeCheckoutState(repoDir: string): Promise<CheckoutState | null>;
  /** Read the persisted consecutive-failure count (0 when absent). */
  readFailureStreak(logDir: string): Promise<number>;
  /** Persist the consecutive-failure count. */
  writeFailureStreak(logDir: string, count: number): Promise<void>;
  /**
   * Raise the crash-loop through the control plane (Issue #4204) — the
   * default files (or comments on) a deduplicated GitHub issue against the
   * checkout's origin repository. Best-effort: a throw is logged and never
   * masks the underlying update failure.
   */
  escalate(context: CheckoutUpdateEscalationContext): Promise<void>;
  /** Append a timestamped line to `run_core.log`. */
  log(logDir: string, message: string): Promise<void>;
}

/** Append a single line (newline-terminated) to a file, creating it if absent. */
async function appendLine(filePath: string, line: string): Promise<void> {
  await Deno.writeTextFile(filePath, `${line}\n`, { append: true });
}

/**
 * The update sequence, unchanged from the prelude's:
 *   git fetch origin && git checkout <branch> &&
 *   git reset --hard origin/<branch> && git clean -fd
 *
 * Output is appended to `pull.log` **under the log directory**, which is a
 * mounted host directory — never the checkout. The first failing command
 * short-circuits and returns a fail-loud error (Issue #3234).
 */
export async function resetCheckoutToDefaultBranch(
  repoDir: string,
  branch: string,
  logDir: string,
): Promise<Result<void>> {
  const pullLog = `${logDir}/pull.log`;
  const steps: string[][] = [
    ["fetch", "origin"],
    ["checkout", branch],
    ["reset", "--hard", `origin/${branch}`],
    ["clean", "-fd"],
  ];

  for (const args of steps) {
    const result = await runGitCommand(args, { cwd: repoDir });
    if (!result.ok) {
      return { ok: false, error: result.error };
    }
    const { code, stdout, stderr } = result.value;
    const output = `${stdout}${stderr}`;
    if (output.length > 0) {
      try {
        await appendLine(pullLog, output.replace(/\n$/, ""));
      } catch {
        // Best-effort logging — never masks the git outcome.
      }
    }
    if (code !== 0) {
      return {
        ok: false,
        error: new Error(
          `git ${args.join(" ")} failed (exit code ${code}): ${
            stderr.trim() || stdout.trim()
          }`,
        ),
      };
    }
  }

  return { ok: true, value: undefined };
}

/**
 * Read the checkout's branch and dirty-file count (Issue #4204). Best-effort:
 * any git failure returns `null` — diagnosis must never add a failure mode.
 */
export async function describeCheckoutState(
  repoDir: string,
): Promise<CheckoutState | null> {
  try {
    const branchResult = await runGitCommand(
      ["rev-parse", "--abbrev-ref", "HEAD"],
      { cwd: repoDir },
    );
    if (!branchResult.ok || branchResult.value.code !== 0) return null;
    const statusResult = await runGitCommand(["status", "--porcelain"], {
      cwd: repoDir,
    });
    if (!statusResult.ok || statusResult.value.code !== 0) return null;
    const dirtyFiles = statusResult.value.stdout
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .length;
    return { branch: branchResult.value.stdout.trim(), dirtyFiles };
  } catch {
    return null;
  }
}

/** Path of the persisted consecutive-failure count. */
function streakFilePath(logDir: string): string {
  return `${logDir}/${CHECKOUT_UPDATE_FAILURE_STREAK_FILE}`;
}

/** Read the persisted streak; absent or unreadable reads as zero. */
async function defaultReadFailureStreak(logDir: string): Promise<number> {
  try {
    const text = await Deno.readTextFile(streakFilePath(logDir));
    const parsed = Number.parseInt(text.trim(), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  } catch {
    return 0;
  }
}

/** Persist the streak. Best-effort — a write failure only loses the count. */
async function defaultWriteFailureStreak(
  logDir: string,
  count: number,
): Promise<void> {
  try {
    await Deno.mkdir(logDir, { recursive: true });
    await Deno.writeTextFile(streakFilePath(logDir), `${count}\n`);
  } catch {
    // Best-effort persistence.
  }
}

/** Parse `owner/repo` out of a git origin URL (SSH or HTTPS). */
export function parseOriginRepo(url: string): string | null {
  const match = url.trim().match(
    /github\.com[/:]([^/\s]+\/[^/\s]+?)(?:\.git)?$/,
  );
  return match ? match[1]! : null;
}

/** The host's own identity for the escalation title. */
function escalationHostId(): string {
  let fromEnv: string | undefined;
  try {
    fromEnv = Deno.env.get("VIBE_HOST_ID")?.trim();
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
 * Enrich a bare git error with the collision diagnosis (Issue #4204): when the
 * checkout looks like an active development tree — dirty, or parked on another
 * branch — say so, instead of the bare failure that let a crash-loop run
 * unexplained for an hour.
 */
export function diagnoseUpdateFailure(
  error: string,
  branch: string,
  checkout: CheckoutState | null,
): string {
  if (
    !checkout || branch === "" ||
    (checkout.dirtyFiles === 0 && checkout.branch === branch)
  ) {
    return error;
  }
  return `${error} — the worker checkout looks like an active development ` +
    `tree (branch ${checkout.branch}, ${checkout.dirtyFiles} uncommitted ` +
    `change(s)). Commit or stash that work, or give the worker its own ` +
    `dedicated clone (Issue #4204).`;
}

/**
 * File (or comment on) a deduplicated GitHub issue naming the crash-loop
 * (Issue #4204). Goes through the `spawnGh` chokepoint like every other
 * worker write. The update runs before the worker's configuration is loaded,
 * so `GH_CONFIG_DIR` may not be established yet — a staged runtime copy under
 * the home directory is pointed at explicitly when present.
 */
export async function escalateCheckoutUpdateFailure(
  context: CheckoutUpdateEscalationContext,
): Promise<void> {
  const origin = await runGitCommand(["remote", "get-url", "origin"], {
    cwd: context.repoDir,
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

  const env: Record<string, string> = {};
  if (!Deno.env.get("GH_CONFIG_DIR")) {
    const home = Deno.env.get("HOME");
    if (home) {
      const runtimeDir = `${home}/${GH_RUNTIME_CONFIG_SUFFIX}`;
      try {
        await Deno.stat(`${runtimeDir}/hosts.yml`);
        env.GH_CONFIG_DIR = runtimeDir;
      } catch {
        // No staged runtime copy — let gh resolve its own configuration.
      }
    }
  }

  const host = escalationHostId();
  const title = `Worker checkout update failing on ${host}`;
  const body = [
    `The host-side worker checkout update on \`${host}\` has failed ` +
    `${context.streak} consecutive runs — the worker keeps launching on the ` +
    `checkout it already has, so that host is running stale code ` +
    `(Issues #4204, #513).`,
    "",
    "```",
    context.error,
    "```",
    "",
    context.checkout
      ? `Checkout state: branch \`${context.checkout.branch}\`, ` +
        `${context.checkout.dirtyFiles} uncommitted change(s).`
      : "Checkout state could not be read.",
    "",
    "If this checkout doubles as a development tree, commit or stash the " +
    "in-flight work, or give the worker its own dedicated clone — see " +
    "docs/DEPLOYMENT.md (Dedicated clone).",
  ].join("\n");

  // Dedup by exact title: comment on an existing open report, else create.
  const listed = await spawnGh(
    [
      "issue",
      "list",
      "--repo",
      repo,
      "--state",
      "open",
      "--search",
      `in:title \"${title}\"`,
      "--json",
      "number,title",
    ],
    { env },
  );
  let existing: number | undefined;
  if (listed.code === 0) {
    try {
      const issues = JSON.parse(listed.stdout) as {
        number: number;
        title: string;
      }[];
      existing = issues.find((issue) => issue.title === title)?.number;
    } catch {
      // Unparseable listing — fall through to creation.
    }
  }

  const result = existing
    ? await spawnGh(
      [
        "issue",
        "comment",
        `${existing}`,
        "--repo",
        repo,
        "--body",
        body,
      ],
      { env },
    )
    : await spawnGh(
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
}

/** Build the production dependency set for {@link updateCheckout}. */
export function createDefaultCheckoutUpdateDeps(): CheckoutUpdateDeps {
  return {
    resolveDefaultBranch: resolveOriginDefaultBranch,
    resetToDefaultBranch: resetCheckoutToDefaultBranch,
    describeCheckoutState,
    readFailureStreak: defaultReadFailureStreak,
    writeFailureStreak: defaultWriteFailureStreak,
    escalate: escalateCheckoutUpdateFailure,
    log: appendRunCoreLogLine,
  };
}

/**
 * Update a checkout to `origin/<default-branch>`, counting consecutive
 * failures and escalating a crash-loop exactly once per streak (#4204).
 *
 * @param options - The checkout, the log directory, and an optional branch.
 * @param depsOverride - Partial dependency overrides (production defaults fill
 *   the rest). Tests inject a recording set.
 * @returns The outcome, including the streak and whether it escalated.
 */
export async function updateCheckout(
  options: CheckoutUpdateOptions,
  depsOverride: Partial<CheckoutUpdateDeps> = {},
): Promise<CheckoutUpdateOutcome> {
  const deps: CheckoutUpdateDeps = {
    ...createDefaultCheckoutUpdateDeps(),
    ...depsOverride,
  };
  const { repoDir, logDir } = options;

  let branch = options.defaultBranch ?? "";
  let failure: string | undefined;
  if (branch === "") {
    const resolved = await deps.resolveDefaultBranch(repoDir);
    if (resolved.ok) {
      branch = resolved.value;
    } else {
      failure = `cannot resolve the default branch of ${repoDir}: ` +
        `${resolved.error.message} (pass --default-branch to name it)`;
    }
  }

  if (failure === undefined) {
    await deps.log(logDir, `Updating ${repoDir} to origin/${branch}`);
    const reset = await deps.resetToDefaultBranch(repoDir, branch, logDir);
    if (!reset.ok) {
      failure = `cannot update ${repoDir} to origin/${branch}: ` +
        reset.error.message;
    }
  }

  if (failure === undefined) {
    // A successful update ends any failure streak (Issue #4204).
    try {
      await deps.writeFailureStreak(logDir, 0);
    } catch {
      // Best-effort persistence.
    }
    return { ok: true, branch, streak: 0, escalated: false };
  }

  let checkout: CheckoutState | null = null;
  try {
    checkout = await deps.describeCheckoutState(repoDir);
  } catch {
    checkout = null;
  }
  const detail = diagnoseUpdateFailure(failure, branch, checkout);
  await deps.log(logDir, `Checkout update failed: ${detail}`);

  // Consecutive-failure escalation (Issue #4204): one blip stays a log line;
  // a crash-loop is raised through the control plane exactly once per streak,
  // so an unattended host running stale code is visible where the operator
  // actually looks. Every step is best-effort — nothing here may mask the
  // underlying failure.
  let streak: number;
  try {
    streak = (await deps.readFailureStreak(logDir)) + 1;
  } catch {
    streak = 1;
  }
  try {
    await deps.writeFailureStreak(logDir, streak);
  } catch {
    // Best-effort persistence.
  }

  let escalated = false;
  if (streak === CHECKOUT_UPDATE_ESCALATION_THRESHOLD) {
    await deps.log(
      logDir,
      `The worker checkout update has failed ${streak} consecutive runs — ` +
        `escalating through the control plane (Issue #4204)`,
    );
    try {
      await deps.escalate({ repoDir, logDir, streak, error: detail, checkout });
      escalated = true;
    } catch (escalationError) {
      await deps.log(
        logDir,
        `Checkout update escalation failed (continuing): ${
          escalationError instanceof Error
            ? escalationError.message
            : String(escalationError)
        }`,
      );
    }
  }

  return { ok: false, branch, error: detail, streak, escalated };
}
