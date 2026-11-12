/** Shared latched trial stop and outcome notification (Issue #4956). */
import { fenceUntrustedIssueText } from "./prompt_delimiter.ts";
import { join } from "node:path";
import { runGhCommandRaw } from "./github.ts";
import { TOKEN_ECONOMIZER_HOOK_FAILURE } from "./token_economizer_hook.ts";
import {
  readTokenEconomizerStop,
  recordTokenEconomizerStop,
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
  const receipt = `${tokenEconomizerStatePath(workDir)}.reported`;
  try {
    if (await Deno.readTextFile(receipt) === stop.recordedAt) return;
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
      "Plugin loading and learning synchronisation are inhibited by the shared stop record. " +
      "This failed trial overrides the normal 7-day/60-run measurement window.\n\n" +
      "<!-- vibe-token-economizer-stop -->",
    ]);
    await Deno.writeTextFile(receipt, stop.recordedAt, { mode: 0o600 });
  } catch {
    // Do not echo remote output: it can contain credentials or learned text.
    logger?.warn(
      "token-economizer: stopped; outcome notification pending (GitHub write or receipt failed)",
    );
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
            reason: `TokenEconomizer failure: ${
              name === "errors.log"
                ? "upstream hook recorded an error"
                : "hook adapter rejected input or failed"
            }`,
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

/** Required before each persistence transfer, including a rebase retry. */
export async function tokenEconomizerMaySync(
  workDir: string,
): Promise<boolean> {
  return await readTokenEconomizerStop(workDir) === null;
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
