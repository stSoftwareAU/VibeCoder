/** Shared latched trial stop and outcome notification (Issue #4956). */
import { fenceUntrustedIssueText } from "./prompt_delimiter.ts";
import { join } from "node:path";
import { runGhCommandRaw } from "./github.ts";
import { redactSecrets } from "./secret_redaction.ts";
import {
  type LearningsLogger,
  pushLearnings,
  type PushLearningsOutcome,
} from "./token_economizer_learnings.ts";
import { TOKEN_ECONOMIZER_HOOK_FAILURE } from "./token_economizer_hook.ts";
import {
  readTokenEconomizerStop,
  recordTokenEconomizerStop,
  tokenEconomizerControlDirectory,
  type TokenEconomizerLaunch,
  tokenEconomizerStatePath,
  type TokenEconomizerStop,
  type TokenEconomizerStopRule,
} from "./token_economizer_plugin.ts";

/** Persistence calls this same interface on a gitleaks or isolation finding. */
export interface TokenEconomizerFinding {
  rule: Exclude<TokenEconomizerStopRule, "unreadable-stop-record">;
  reason: string;
}

/** Longest receipt read, matching the stop record's 4096-byte cap. */
const RECEIPT_MAX_BYTES = 4096;

type Notify = (args: string[]) => Promise<string>;
type Log = { warn(message: string): void };

/**
 * Latch before reporting: a denied/offline GitHub call cannot re-enable loading
 * or synchronisation. The first finding stays latched until authorised recovery
 * or purge; a subsequent healthy run does not clear a failed experiment.
 */
export async function stopTokenEconomizerTrial(
  workDir: string,
  finding: TokenEconomizerFinding,
  notify: Notify = runGhCommandRaw,
  logger?: Log,
): Promise<TokenEconomizerStop> {
  const stop = await recordTokenEconomizerStop(workDir, finding);
  await reportTokenEconomizerStop(workDir, stop, notify, logger);
  return stop;
}

/** Retry a pending stop report; the normal measurement window never gates it. */
export async function reportTokenEconomizerStop(
  workDir: string,
  stop: TokenEconomizerStop,
  notify: Notify = runGhCommandRaw,
  logger?: Log,
): Promise<void> {
  try {
    // An aliased controller directory must never be read or written through.
    await tokenEconomizerControlDirectory(workDir);
  } catch {
    const message =
      "token-economizer: stopped; outcome notification skipped (controller directory is aliased or outside the work root)";
    if (logger) logger.warn(message);
    else console.error(message);
    return;
  }
  const receipt = `${tokenEconomizerStatePath(workDir)}.reported`;
  const fingerprint = JSON.stringify([stop.rule, stop.reason]);
  try {
    // Capped like the stop record: an oversized receipt is never a match.
    if ((await Deno.stat(receipt)).size <= RECEIPT_MAX_BYTES) {
      if (await Deno.readTextFile(receipt) === fingerprint) return;
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  try {
    await notify([
      "issue",
      "comment",
      "4959",
      "--repo",
      "stSoftwareAU/VibeCoder",
      "--body",
      `TokenEconomizer trial stopped: ${stop.rule}.\n\n` +
      fenceUntrustedIssueText(
        stop.reason,
        "Recorded failure reason (untrusted data):",
      ).join("\n") + "\n\n" +
      "Plugin loading is inhibited and the shared sync permission is false. Persistence must honour that permission before each transfer. " +
      "This failed trial overrides the normal 7-day/60-run measurement window.\n\n" +
      "<!-- vibe-token-economizer-stop -->",
    ]);
    await Deno.writeTextFile(receipt, fingerprint, { mode: 0o600 });
  } catch {
    // Do not echo remote output: it can contain credentials or learned text.
    const message =
      "token-economizer: stopped; outcome notification pending (GitHub write or receipt failed)";
    if (logger) logger.warn(message);
    else console.error(message);
  }
}

/**
 * Post-run failures are plugin failures, never failures of the underlying work.
 * The upstream error log is a signal only: no traceback or secret is copied.
 */
export async function finishTokenEconomizerRun(
  launch: TokenEconomizerLaunch,
  notify: Notify = runGhCommandRaw,
  logger?: Log,
): Promise<boolean> {
  const home = launch.env.TOKENECONOMIZER_HOME;
  for (const name of [TOKEN_ECONOMIZER_HOOK_FAILURE, "errors.log"]) {
    try {
      if ((await Deno.stat(join(home, name))).size > 0) {
        await stopTokenEconomizerTrial(
          launch.workDir,
          {
            rule: "plugin-run-failure",
            reason: name === "errors.log"
              ? "TokenEconomizer failure: upstream hook recorded an error"
              : await hookFailureReason(join(home, name)),
          },
          notify,
          logger,
        );
        return true;
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }
  return false;
}

/** Keep the adapter's cause, but never interpret its text as a stop category. */
async function hookFailureReason(path: string): Promise<string> {
  try {
    if ((await Deno.stat(path)).size <= 4096) {
      const finding: unknown = JSON.parse(await Deno.readTextFile(path));
      if (
        typeof finding === "object" && finding !== null &&
        "reason" in finding && typeof finding.reason === "string"
      ) {
        return `TokenEconomizer failure: ${finding.reason}`;
      }
    }
  } catch {
    // A corrupt signal is a fault, never permission to continue the trial.
  }
  return "TokenEconomizer failure: malformed hook-failure marker";
}

/** Required before each persistence transfer, including a rebase retry. */
export async function tokenEconomizerMaySync(
  workDir: string,
): Promise<boolean> {
  try {
    await tokenEconomizerControlDirectory(workDir);
    return await readTokenEconomizerStop(workDir) === null;
  } catch {
    // An unverified controller location never authorises a transfer.
    return false;
  }
}

/**
 * Push what this launch learned to the private learnings store (Issue #4957).
 * Null when learnings persistence is not configured. Never throws: a fault is
 * a WARNING and a `skipped` outcome, so it never changes the run's result.
 */
export async function syncTokenEconomizerLearnings(
  launch: TokenEconomizerLaunch,
  notify?: Notify,
  logger?: LearningsLogger,
): Promise<PushLearningsOutcome | null> {
  if (!launch.learnings) return null;
  try {
    return await pushLearnings({
      learningsRepo: launch.learnings.repo,
      persistence: launch.learnings.persistence,
      home: launch.env.TOKENECONOMIZER_HOME,
      subject: launch.subject,
      runId: launch.runId,
      checkVisibility: launch.learnings.checkVisibility,
      mayTransfer: () => tokenEconomizerMaySync(launch.workDir),
      stop: (finding) =>
        stopTokenEconomizerTrial(launch.workDir, finding, notify, logger),
      logger,
    });
  } catch (error) {
    const reason = redactSecrets(
      error instanceof Error ? error.message : String(error),
    );
    logger?.warn(`token-economizer learnings: sync failed: ${reason}`);
    return { kind: "skipped", reason };
  }
}

/** Observe hook faults during the run, with a final scan covering shutdown races. */
export function monitorTokenEconomizerRun(
  launch: TokenEconomizerLaunch,
  notify: Notify = runGhCommandRaw,
  logger?: Log,
): { close(): Promise<void> } {
  const watcher = Deno.watchFs(launch.env.TOKENECONOMIZER_HOME);
  const watching = (async () => {
    try {
      for await (const event of watcher) {
        if (
          event.paths.some((path) =>
            path.endsWith(`/${TOKEN_ECONOMIZER_HOOK_FAILURE}`) ||
            path.endsWith("/errors.log")
          )
        ) {
          if (await finishTokenEconomizerRun(launch, notify, logger)) break;
        }
      }
    } catch {
      logger?.warn(
        "token-economizer: hook failure monitor unavailable; final scan remains required",
      );
    }
  })();
  return {
    async close() {
      watcher.close();
      await watching;
      await finishTokenEconomizerRun(launch, notify, logger);
    },
  };
}
